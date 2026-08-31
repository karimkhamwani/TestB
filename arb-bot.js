#!/usr/bin/env node
'use strict';

// arb-bot.js — supervisor for the bi-directional pair arb (plan §4).
//
// Phase 0 build: ONLY the observer exists. Live mode intentionally refuses to
// start — per the plan, "nothing gets built past the observer until the
// observer proves the opportunities exist net of fees." Run:
//
//   npm run arb -- --observe        (equivalently: ARB_MODE=observe npm run arb)
//
// Standalone script by design: never under pm2 / npm run up.

const { parseConfig } = require('./lib/config');
const gamma = require('./lib/gamma');
const { BookFeed } = require('./lib/books');
const { Observer } = require('./lib/observer');

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function main() {
  const cfg = parseConfig({});

  if (cfg.mode !== 'observe') {
    console.error(
      'ARB_MODE=live refused: Phase 1 executor is not built yet.\n' +
      'The Phase 0 gate (>= ' + cfg.observer.gateEventsPerDay + ' fee-adjusted, depth-backed events/day, ' +
      '>= ' + cfg.observer.minEventMs + 'ms duration) must pass first — run --observe for 2-3 days ' +
      'on the Windows box and read the dashboard Arb tab.');
    process.exit(1);
  }

  log(`observer starting: ${cfg.series.length} series, data -> ${cfg.dataDir}`);
  log(`gate: >= ${cfg.observer.gateEventsPerDay} events/day of >= ${cfg.observer.minEventMs}ms with ` +
      `${cfg.detector.minDepth}x${cfg.detector.minDepth} depth, buySum<=${cfg.detector.buySum}, sellSum>=${cfg.detector.sellSum}`);

  const observer = new Observer(cfg);
  const feed = new BookFeed(cfg.clobWs);
  const tokenToSeries = new Map();
  let feedState = { connected: false, assets: 0 };
  let wsEverConnected = false;

  feed.on('ws', (state, detail) => {
    feedState = feed.state();
    if (state === 'open') { wsEverConnected = true; log('market ws connected'); }
    else log(`market ws ${state}${detail ? ': ' + detail : ''}`);
  });
  feed.on('update', (assetId) => {
    const series = tokenToSeries.get(assetId);
    if (series) observer.onBookUpdate(series, feed.books);
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
    }
    feedState = { connected: false, assets: feed.books.size, restPoll: true };
  }

  if (cfg.restPoll) {
    observer.feedMode = 'rest-poll';
    log('WARNING: --rest-poll debug mode. 1 Hz REST sampling aliases sub-second events;');
    log('WARNING: this data is NOT valid for the Phase 0 gate. Use the Windows box + websockets.');
  }

  await refreshDiscovery();

  const timers = [
    setInterval(refreshDiscovery, 5_000),
    setInterval(drainOutcomes, 10_000),
    setInterval(() => observer.sampleAll(feed.books), cfg.observer.sampleIntervalMs),
    setInterval(() => { feedState = cfg.restPoll ? feedState : feed.state(); observer.writeStatus(feed.books, feedState); }, 3_000),
  ];
  if (cfg.restPoll) timers.push(setInterval(restPollOnce, 1_000));

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
    observer.writeStatus(feed.books, feedState);
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
