'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Observer } = require('./observer');
const { Book } = require('./books');

const FEES = { exponent: 1, rate: 0.07, takerOnly: true, rebateRate: 0.2 };

function makeCfg(dataDir) {
  return {
    dataDir,
    detector: {
      buySum: 0.985, sellSum: 1.015, shares: 5, maxActiveUsdc: 10,
      minTauSec: 20, freshnessMs: 1000, minDepth: 5,
      priceBandMin: 0.01, priceBandMax: 0.99,
    },
    observer: { minEventMs: 300, gateEventsPerDay: 20, sampleIntervalMs: 1000, xtfDivergence: 0.15, nearResWindowSec: 30 },
  };
}

function makeMarket(nowMs, over = {}) {
  return {
    series: 'btc-updown-5m', slug: 'btc-updown-5m-1788205500',
    windowStartMs: nowMs - 60_000, windowEndMs: nowMs + 240_000,
    conditionId: '0xabc', upToken: 'UP', downToken: 'DOWN',
    feeSchedule: FEES, minOrderSize: 5, ...over,
  };
}

function makeBooks(nowMs, { askUp, askDown, bidUp, bidDown, size = 50 }) {
  const books = new Map();
  const up = new Book('UP');
  const down = new Book('DOWN');
  up.applySnapshot({ bids: [{ price: bidUp, size }], asks: [{ price: askUp, size }] }, nowMs);
  down.applySnapshot({ bids: [{ price: bidDown, size }], asks: [{ price: askDown, size }] }, nowMs);
  books.set('UP', up);
  books.set('DOWN', down);
  return books;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arb-obs-'));
}

test('observer opens and closes a buy-side event; >=300ms qualifies for the gate', () => {
  const obs = new Observer(makeCfg(tmpDir()));
  const t0 = 1_000_000;
  obs.setMarket('btc-updown-5m', makeMarket(t0));

  // Polarized cheap pair: 0.85 + 0.10 = 0.95 raw, fees tiny -> triggers.
  obs.onBookUpdate('btc-updown-5m', makeBooks(t0, { askUp: 0.85, askDown: 0.10, bidUp: 0.84, bidDown: 0.09 }), t0);
  assert.ok(obs.open.has('btc-updown-5m:buy'), 'event should open');

  // 500ms later the edge is gone -> event closes, 500ms >= 300ms so it gates.
  obs.onBookUpdate('btc-updown-5m', makeBooks(t0 + 500, { askUp: 0.90, askDown: 0.12, bidUp: 0.84, bidDown: 0.09 }), t0 + 500);
  assert.ok(!obs.open.has('btc-updown-5m:buy'));
  assert.equal(obs.counters.buyEvents, 1);
  assert.equal(obs.counters.buyGateEvents, 1);
});

test('observer: sub-300ms flicker is counted but does NOT qualify for the gate', () => {
  const obs = new Observer(makeCfg(tmpDir()));
  const t0 = 1_000_000;
  obs.setMarket('btc-updown-5m', makeMarket(t0));
  obs.onBookUpdate('btc-updown-5m', makeBooks(t0, { askUp: 0.85, askDown: 0.10, bidUp: 0.84, bidDown: 0.09 }), t0);
  obs.onBookUpdate('btc-updown-5m', makeBooks(t0 + 80, { askUp: 0.90, askDown: 0.12, bidUp: 0.84, bidDown: 0.09 }), t0 + 80);
  assert.equal(obs.counters.buyEvents, 1);
  assert.equal(obs.counters.buyGateEvents, 0);
});

test('observer: thin depth never opens an event (bait gate)', () => {
  const obs = new Observer(makeCfg(tmpDir()));
  const t0 = 1_000_000;
  obs.setMarket('btc-updown-5m', makeMarket(t0));
  obs.onBookUpdate('btc-updown-5m', makeBooks(t0, { askUp: 0.85, askDown: 0.10, bidUp: 0.84, bidDown: 0.09, size: 3 }), t0);
  assert.ok(!obs.open.has('btc-updown-5m:buy'));
});

test('observer: rich pair opens a sell-side event', () => {
  const obs = new Observer(makeCfg(tmpDir()));
  const t0 = 1_000_000;
  obs.setMarket('btc-updown-5m', makeMarket(t0));
  obs.onBookUpdate('btc-updown-5m', makeBooks(t0, { askUp: 0.95, askDown: 0.14, bidUp: 0.93, bidDown: 0.11 }), t0);
  assert.ok(obs.open.has('btc-updown-5m:sell'));
  // Fair books close it.
  obs.onBookUpdate('btc-updown-5m', makeBooks(t0 + 400, { askUp: 0.95, askDown: 0.14, bidUp: 0.90, bidDown: 0.08 }), t0 + 400);
  assert.equal(obs.counters.sellGateEvents, 1);
});

test('observer: window rollover force-closes open events', () => {
  const obs = new Observer(makeCfg(tmpDir()));
  const t0 = 1_000_000;
  obs.setMarket('btc-updown-5m', makeMarket(t0));
  obs.onBookUpdate('btc-updown-5m', makeBooks(t0, { askUp: 0.85, askDown: 0.10, bidUp: 0.84, bidDown: 0.09 }), t0);
  obs.closeSeriesEvents('btc-updown-5m', t0 + 1000);
  assert.equal(obs.open.size, 0);
  assert.equal(obs.counters.buyGateEvents, 1);
});

test('observer: gate projection scales observed events to per-day', () => {
  const obs = new Observer(makeCfg(tmpDir()));
  obs.startedMs = Date.now() - 12 * 3600 * 1000; // pretend 12h of uptime
  for (let i = 0; i < 15; i++) obs.gateLog.push({ tMs: Date.now() - i * 60_000, side: 'buy' });
  const g = obs.gateStatus();
  assert.equal(g.observedInHorizon.buy, 15);
  assert.equal(g.projectedPerDay.buy, 30); // 15 in 12h -> 30/day
  assert.equal(g.pass.buy, true);
  assert.equal(g.pass.sell, false);
});

test('observer: sampler writes rows and tracks the near-resolution ring', () => {
  const dir = tmpDir();
  const obs = new Observer(makeCfg(dir));
  const t0 = Date.now();
  obs.setMarket('btc-updown-5m', makeMarket(t0, { windowEndMs: t0 + 25_000 })); // inside final 30s
  const books = makeBooks(t0, { askUp: 0.58, askDown: 0.44, bidUp: 0.57, bidDown: 0.42 });
  obs.sampleAll(books, t0);
  assert.equal(obs.counters.samples, 1);
  const ring = obs.takeNearResRing('btc-updown-5m');
  assert.ok(ring);
  assert.equal(ring.snaps[0].leading, 'Up');
  assert.equal(ring.snaps[0].leadingAsk, 0.58);
});

test('observer: cross-timeframe divergence event opens and closes', () => {
  const obs = new Observer(makeCfg(tmpDir()));
  const t0 = Date.now();
  const m5 = makeMarket(t0);
  const m15 = makeMarket(t0, { series: 'btc-updown-15m', slug: 'btc-updown-15m-x', upToken: 'UP15', downToken: 'DOWN15' });
  obs.setMarket('btc-updown-5m', m5);
  obs.setMarket('btc-updown-15m', m15);

  const books = makeBooks(t0, { askUp: 0.31, askDown: 0.71, bidUp: 0.29, bidDown: 0.69 }); // 5m mid 0.30
  const up15 = new Book('UP15'); const down15 = new Book('DOWN15');
  up15.applySnapshot({ bids: [{ price: 0.59, size: 50 }], asks: [{ price: 0.61, size: 50 }] }, t0); // 15m mid 0.60
  down15.applySnapshot({ bids: [{ price: 0.39, size: 50 }], asks: [{ price: 0.41, size: 50 }] }, t0);
  books.set('UP15', up15); books.set('DOWN15', down15);

  obs.sampleAll(books, t0);
  assert.ok(obs.xtfOpen.has('btc'), 'divergence 0.30 >= 0.15 should open');
  // converge -> closes
  up15.applySnapshot({ bids: [{ price: 0.29, size: 50 }], asks: [{ price: 0.31, size: 50 }] }, t0 + 1000);
  obs.sampleAll(books, t0 + 1000);
  assert.ok(!obs.xtfOpen.has('btc'));
});
