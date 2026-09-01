#!/usr/bin/env node
'use strict';

// arb-bot.js — supervisor for the bi-directional pair arb.
//
// Modes:
//   --observe  recorder only (no orders, no keys needed)
//   --dry      the FULL strategy against a PAPER venue + paper CTF (simulated
//              fills from the live books; optimistic — see lib/venue.js)
//   --live     REAL ORDERS. Requires POLY_PRIVATE_KEY (+ proxy funder) in .env
//              AND ARB_LIVE_CONFIRM=yes. Start at the $10 cap only after a
//              clean dry week.
//
// One strategy, all modules (lib/strategy.js): taker, maker, sellside,
// allocator, skew — sharing one ledger, one venue, one CTF.
// The observer keeps recording in every mode — it is the measurement
// instrument. Standalone script by design: never under pm2 / npm run up.

const { parseConfig } = require('./lib/config');
const gamma = require('./lib/gamma');
const { BookFeed } = require('./lib/books');
const { Observer } = require('./lib/observer');
const { PairLedger } = require('./lib/ledger');
const { Strategy } = require('./lib/strategy');
const { PaperCTF, LiveCTF } = require('./lib/ctf');
const { PaperVenue, LiveVenue } = require('./lib/venue');
const { UserFeed } = require('./lib/userws');

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function main() {
  const cfg = parseConfig({});

  if (cfg.mode === 'live') {
    if (!cfg.trader.liveConfirm) {
      console.error(
        'ARB_MODE=live refused: set ARB_LIVE_CONFIRM=yes to arm real orders.\n' +
        'Live is meant to follow a clean DRY week at the $' + cfg.detector.maxActiveUsdc +
        ' cap; run --dry first and reconcile (node reconcile.js) before arming.');
      process.exit(1);
    }
    if (!process.env.POLY_PRIVATE_KEY) {
      console.error('ARB_MODE=live refused: POLY_PRIVATE_KEY is not set (put it in .env on the trading box).');
      process.exit(1);
    }
  }

  log(`starting mode=${cfg.mode}: ${cfg.series.length} series, data -> ${cfg.dataDir}`);
  if (cfg.mode !== 'observe') {
    log(`caps: $${cfg.detector.maxActiveUsdc} active, ${cfg.trader.maxPairsPerWindow} pairs/window, ` +
        `clip base ${cfg.detector.shares}, feeRateBps ${cfg.trader.feeRateBps}, rearm ${cfg.trader.rearmMs}ms`);
  }
  log(`gate: >= ${cfg.observer.gateEventsPerDay} events/day of >= ${cfg.observer.minEventMs}ms with ` +
      `${cfg.detector.minDepth}x${cfg.detector.minDepth} depth, buySum<=${cfg.detector.buySum}, sellSum>=${cfg.detector.sellSum}`);

  const observer = new Observer(cfg);
  const feed = new BookFeed(cfg.clobWs);
  let userFeed = null;
  const tokenToSeries = new Map();
  let feedState = { connected: false, assets: 0 };
  let wsEverConnected = false;

  // ---- trading path (dry/live): one strategy, all modules ----
  let strategy = null;
  let ledger = null;
  if (cfg.mode !== 'observe') {
    ledger = new PairLedger({
      maxActiveUsdc: cfg.detector.maxActiveUsdc,
      maxPairsPerWindow: cfg.trader.maxPairsPerWindow,
      dataDir: cfg.dataDir,
      mode: cfg.mode,
    });
    let venue, ctf;
    if (cfg.mode === 'live') {
      venue = new LiveVenue(cfg);
      await venue.init();
      ctf = await new LiveCTF().init();
      if (ctf.disabledWhy) log(`CTF disabled: ${ctf.disabledWhy}`);
      log(`LIVE venue armed: funder ${venue.address} (signer ${venue.signerAddress})`);
      log('LIVE MODE — REAL ORDERS WILL BE PLACED. Caps above are the only brake.');
    } else {
      venue = new PaperVenue(feed.books);
      ctf = new PaperCTF({ txCostUsdc: cfg.trader.mergeCostUsdc });
      log('DRY mode: paper venue + paper CTF, fills simulated from the live books (optimistic — no race, full displayed depth).');
    }
    strategy = new Strategy({ cfg, observer, venue, ledger, ctf, log });
    log(`modules: ${[...strategy.modules].join(', ')} | skew κ=${strategy.skew.kappa}${strategy.skew.active ? '' : ' (pinned — pure arb)'} | auto-merge ${strategy.skew.autoMerge}`);
    observer.feedMode = cfg.restPoll ? 'rest-poll' : 'ws';

    // Live maker quotes are gated on the user-channel fill feed: resting
    // orders we can't see fill are unmanaged risk.
    if (cfg.mode === 'live' && strategy.maker) {
      strategy.maker.enabled = false;
      userFeed = new UserFeed({
        wsUrl: cfg.clobWs.replace('/ws/market', '/ws/user'),
        creds: venue.creds,
        dataDir: cfg.dataDir,
      });
      userFeed.on('state', (s2, detail) => {
        strategy.maker.enabled = s2 === 'open';
        log(`user ws ${s2}${detail ? ': ' + detail : ''}${s2 === 'open' ? ' — maker enabled' : ' — maker quoting DISABLED'}`);
      });
      userFeed.on('fill', (fill) => {
        strategy.onUserFill(fill, feed.books).catch((err) => log(`user fill error: ${err.message}`));
      });
    }
  }

  feed.on('ws', (state, detail) => {
    feedState = feed.state();
    if (state === 'open') { wsEverConnected = true; log('market ws connected'); }
    else log(`market ws ${state}${detail ? ': ' + detail : ''}`);
  });
  feed.on('tick_size', (assetId, newTick) => {
    const series = tokenToSeries.get(assetId);
    const mkt = series ? observer.markets.get(series) : null;
    if (mkt && newTick) {
      log(`tick size change ${series}: ${mkt.tickSize} -> ${newTick}`);
      mkt.tickSize = newTick;
    }
  });
  feed.on('update', (assetId) => {
    const series = tokenToSeries.get(assetId);
    if (!series) return;
    observer.onBookUpdate(series, feed.books);
    if (strategy) strategy.onBookUpdate(series, feed.books).catch((err) => log(`strategy error: ${err.message}`));
  });

  // ---- discovery loop: keep each series pointed at its current window ----
  const parsed = cfg.series.map((s) => ({ series: s, ...gamma.parseSeries(s) }));
  const pendingOutcomes = []; // {series, startSec, ring, dueMs}

  async function refreshDiscovery() {
    const nowMs = Date.now();
    let changed = false;
    for (const p of parsed) {
      const startSec = gamma.windowStartSec(p.tfSec, nowMs);
      const current = observer.markets.get(p.series);
      if (current && current.windowStartMs === startSec * 1000) continue;
      try {
        const mkt = await gamma.fetchWindowMarket(cfg.gammaBase, p.series, startSec);
        if (!mkt) {
          if (!current || current.windowEndMs < nowMs) log(`discovery: no event yet for ${gamma.windowSlug(p.series, startSec)}`);
          continue;
        }
        if (current) {
          // Window rolled: close open edge events and queue the near-res ring.
          observer.closeSeriesEvents(p.series, nowMs);
          const ring = observer.takeNearResRing(p.series);
          if (ring) pendingOutcomes.push({ series: p.series, startSec: ring.startSec, ring, dueMs: nowMs + 90_000 });
          // Strategy hooks must never abort discovery: a throw here would
          // leave the new window's tokens unmapped (dead series until the
          // NEXT roll) because setMarket below already marks it current.
          if (strategy) await strategy.onWindowRoll(p.series, feed.books).catch((err) => log(`window-roll hook error ${p.series}: ${err.message}`));
        }
        observer.setMarket(p.series, mkt);
        if (strategy) await strategy.onWindowStart(p.series, mkt).catch((err) => log(`window-start hook error ${p.series}: ${err.message}`));
        tokenToSeries.set(mkt.upToken, p.series);
        tokenToSeries.set(mkt.downToken, p.series);
        changed = true;
        log(`window: ${mkt.slug} ends ${new Date(mkt.windowEndMs).toISOString()} fee=${mkt.feeSchedule ? mkt.feeSchedule.rate : 0}`);
      } catch (err) {
        log(`discovery error for ${p.series}: ${err.message}`);
      }
    }
    if (changed) {
      const assets = [];
      for (const [, mkt] of observer.markets) assets.push(mkt.upToken, mkt.downToken);
      for (const [tok] of tokenToSeries) if (!assets.includes(tok)) tokenToSeries.delete(tok);
      if (!cfg.restPoll) feed.setAssets(assets);
      if (userFeed) userFeed.setMarkets([...observer.markets.values()].map((m) => m.conditionId));
    }
  }

  // Near-resolution outcome lookups, ~90s after each window closes. Gamma can
  // take several minutes to finalize outcomePrices to 1/0 (observed live:
  // still 0.995/0.005 at close+83s), so unresolved lookups retry every 60s
  // for up to 10 attempts before recording outcome: null.
  async function drainOutcomes() {
    const nowMs = Date.now();
    for (let i = pendingOutcomes.length - 1; i >= 0; i--) {
      const p = pendingOutcomes[i];
      if (p.dueMs > nowMs) continue;
      let outcome = null;
      try {
        outcome = await gamma.fetchWindowOutcome(cfg.gammaBase, p.series, p.startSec);
      } catch (err) {
        log(`outcome lookup failed for ${p.series}-${p.startSec}: ${err.message}`);
      }
      if (outcome === null && (p.attempts = (p.attempts || 0) + 1) < 10) {
        p.dueMs = nowMs + 60_000;
        continue;
      }
      pendingOutcomes.splice(i, 1);
      observer.recordNearResOutcome(p.ring, outcome);
    }
  }

  // ---- debug-only REST polling fallback (Mac smoke tests; NOT gate-valid) ----
  let restPollBusy = false;
  async function restPollOnce() {
    if (restPollBusy) return; // sweeps take seconds; don't stack them
    restPollBusy = true;
    try { await restPollSweep(); } finally { restPollBusy = false; }
  }
  async function restPollSweep() {
    const nowMs = Date.now();
    for (const [series, mkt] of observer.markets) {
      for (const [tok, side] of [[mkt.upToken, 'up'], [mkt.downToken, 'down']]) {
        try {
          const res = await fetch(`${cfg.clobBase}/book?token_id=${tok}`);
          if (!res.ok) continue;
          const b = await res.json();
          let book = feed.books.get(tok);
          if (!book) { feed.books.set(tok, new (require('./lib/books').Book)(tok)); book = feed.books.get(tok); }
          book.applySnapshot(b, Date.now());
        } catch {}
      }
      observer.onBookUpdate(series, feed.books, Date.now());
      if (strategy) await strategy.onBookUpdate(series, feed.books, Date.now());
    }
    feedState = { connected: false, assets: feed.books.size, restPoll: true };
  }

  if (cfg.restPoll) {
    observer.feedMode = 'rest-poll';
    log('WARNING: --rest-poll debug mode. 1 Hz REST sampling aliases sub-second events;');
    log('WARNING: this data is NOT valid for the go/no-go gate. Use the Windows box + websockets.');
  }

  await refreshDiscovery();

  const traderExtra = () => (strategy ? {
    mode: cfg.mode,
    trading: { venue: cfg.mode, ...strategy.stats() },
  } : { mode: cfg.mode });

  // Timer bodies do slow network work — never let invocations stack.
  const guarded = (fn) => {
    let busy = false;
    return async () => {
      if (busy) return;
      busy = true;
      try { await fn(); } catch (err) { log(`timer error: ${err.message}`); } finally { busy = false; }
    };
  };
  const timers = [
    setInterval(guarded(refreshDiscovery), 5_000),
    setInterval(guarded(drainOutcomes), 10_000),
    setInterval(() => observer.sampleAll(feed.books), cfg.observer.sampleIntervalMs),
    setInterval(() => { feedState = cfg.restPoll ? feedState : feed.state(); observer.writeStatus(feed.books, feedState, Date.now(), traderExtra()); }, 3_000),
  ];
  if (cfg.restPoll) timers.push(setInterval(restPollOnce, 1_000));
  if (strategy) {
    timers.push(setInterval(guarded(() => strategy.tick(feed.books)), 1_000));
    timers.push(setInterval(
      guarded(() => strategy.drainResolutions((series, startSec) => gamma.fetchWindowOutcome(cfg.gammaBase, series, startSec))),
      15_000));
  }

  // Loud hint if the ws never comes up (the Mac situation).
  setTimeout(() => {
    if (!cfg.restPoll && !wsEverConnected) {
      log('market ws has not connected after 30s — CLOB websockets are blocked on this machine?');
      log('Run the observer on the Windows trading box (or --rest-poll for a plumbing-only smoke test).');
    }
  }, 30_000);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('shutting down');
    for (const t of timers) clearInterval(t);
    if (strategy) {
      // Cancel every resting quote and flush queued merges — live GTC bids
      // must never be left working with no fill feed watching them.
      try { await strategy.shutdown(feed.books); log('quotes cancelled, merges flushed'); }
      catch (err) { log(`shutdown cleanup error: ${err.message}`); }
    }
    for (const [series] of observer.markets) observer.closeSeriesEvents(series);
    observer.writeStatus(feed.books, feedState, Date.now(), traderExtra());
    feed.close();
    if (userFeed) userFeed.close();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
