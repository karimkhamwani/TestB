#!/usr/bin/env node
'use strict';

// arb-bot.js — supervisor for the bi-directional pair arb (plan §4).
//
// Modes:
//   --observe  Phase 0 recorder only (no orders, no keys needed)
//   --dry      Phase 1 executor against a PAPER venue (simulated FAK fills
//              from the live books; optimistic — see lib/venue.js)
//   --live     REAL ORDERS. Requires POLY_PRIVATE_KEY (+ proxy funder) in .env
//              AND ARB_LIVE_CONFIRM=yes. Start at ARB_MAX_ACTIVE_USDC=10 only
//              after a clean dry week (plan §5 Phase 1 / §8b item 5).
//
// The observer keeps recording in every mode — it is the gate instrument.
// Standalone script by design: never under pm2 / npm run up.

const { parseConfig } = require('./lib/config');
const gamma = require('./lib/gamma');
const { BookFeed } = require('./lib/books');
const { Observer } = require('./lib/observer');
const { PairLedger } = require('./lib/ledger');
const { Trader } = require('./lib/trader');
const { PaperVenue, LiveVenue } = require('./lib/venue');

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
        ' cap (plan §5 Phase 1); run --dry first and reconcile (node reconcile.js) before arming.');
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
  const tokenToSeries = new Map();
  let feedState = { connected: false, assets: 0 };
  let wsEverConnected = false;

  // ---- Phase 1 trading path (dry/live) ----
  let trader = null;
  let ledger = null;
  if (cfg.mode !== 'observe') {
    ledger = new PairLedger({
      maxActiveUsdc: cfg.detector.maxActiveUsdc,
      maxPairsPerWindow: cfg.trader.maxPairsPerWindow,
      dataDir: cfg.dataDir,
    });
    let venue;
    if (cfg.mode === 'live') {
      venue = new LiveVenue(cfg);
      await venue.init();
      log(`LIVE venue armed: funder ${venue.address} (signer ${venue.signerAddress})`);
      log('LIVE MODE — REAL ORDERS WILL BE PLACED. Caps above are the only brake.');
    } else {
      venue = new PaperVenue(feed.books);
      log('DRY mode: paper venue, fills simulated from the live books (optimistic — no race, full displayed depth).');
    }
    trader = new Trader({ cfg, ledger, venue, observer, log });
    observer.feedMode = cfg.restPoll ? 'rest-poll' : 'ws';
  }

  feed.on('ws', (state, detail) => {
    feedState = feed.state();
    if (state === 'open') { wsEverConnected = true; log('market ws connected'); }
    else log(`market ws ${state}${detail ? ': ' + detail : ''}`);
  });
  feed.on('update', (assetId) => {
    const series = tokenToSeries.get(assetId);
    if (!series) return;
    observer.onBookUpdate(series, feed.books);
    if (trader) trader.onBookUpdate(series, feed.books);
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
        }
        observer.setMarket(p.series, mkt);
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
  async function restPollOnce() {
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
      if (trader) trader.onBookUpdate(series, feed.books, Date.now());
    }
    feedState = { connected: false, assets: feed.books.size, restPoll: true };
  }

  if (cfg.restPoll) {
    observer.feedMode = 'rest-poll';
    log('WARNING: --rest-poll debug mode. 1 Hz REST sampling aliases sub-second events;');
    log('WARNING: this data is NOT valid for the Phase 0 gate. Use the Windows box + websockets.');
  }

  await refreshDiscovery();

  const traderExtra = () => (trader ? {
    mode: cfg.mode,
    trading: {
      venue: cfg.mode,
      halted: trader.halted,
      attempts: trader.attempts,
      inFlight: [...trader.inFlight],
      latency: trader.latencyStats(),
      ledger: ledger.stats(),
    },
  } : { mode: cfg.mode });

  const timers = [
    setInterval(refreshDiscovery, 5_000),
    setInterval(drainOutcomes, 10_000),
    setInterval(() => observer.sampleAll(feed.books), cfg.observer.sampleIntervalMs),
    setInterval(() => { feedState = cfg.restPoll ? feedState : feed.state(); observer.writeStatus(feed.books, feedState, Date.now(), traderExtra()); }, 3_000),
  ];
  if (cfg.restPoll) timers.push(setInterval(restPollOnce, 1_000));
  if (trader) {
    timers.push(setInterval(
      () => trader.drainResolutions((series, startSec) => gamma.fetchWindowOutcome(cfg.gammaBase, series, startSec))
        .catch((err) => log(`resolution drain error: ${err.message}`)),
      15_000));
  }

  // Loud hint if the ws never comes up (the Mac situation).
  setTimeout(() => {
    if (!cfg.restPoll && !wsEverConnected) {
      log('market ws has not connected after 30s — CLOB websockets are blocked on this machine?');
      log('Run the observer on the Windows trading box (or --rest-poll for a plumbing-only smoke test).');
    }
  }, 30_000);

  const shutdown = () => {
    log('shutting down');
    for (const t of timers) clearInterval(t);
    for (const [series] of observer.markets) observer.closeSeriesEvents(series);
    observer.writeStatus(feed.books, feedState, Date.now(), traderExtra());
    feed.close();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
