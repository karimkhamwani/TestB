'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Taker } = require('./trader');
const { PairLedger } = require('./ledger');
const { Observer } = require('./observer');
const { Book } = require('./books');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const FEES = { exponent: 1, rate: 0.07, takerOnly: true };

function cfg() {
  return {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'arb-tk-')),
    detector: {
      buySum: 0.985, sellSum: 1.015, shares: 5, maxActiveUsdc: 20,
      minTauSec: 20, freshnessMs: 1000, minDepth: 5,
      priceBandMin: 0.01, priceBandMax: 0.99,
    },
    observer: { minEventMs: 300, gateEventsPerDay: 20, sampleIntervalMs: 1000, xtfDivergence: 0.15, nearResWindowSec: 30 },
    trader: {
      modules: ['taker'], maxPairsPerWindow: 2, rearmMs: 1500, unwindRetries: 3, feeRateBps: 1000,
      liveConfirm: false, postSum: 0.98, completeMaxSum: 0.99, leashSec: 15, requoteMs: 1000,
      presplitUsdc: 0, mergeCostUsdc: 0.01, mergeFlushSec: 30, skew: 0.5, maxLossUsdc: 3,
    },
  };
}

class FakeVenue {
  constructor(script) { this.script = script; this.kind = 'fake'; this.calls = []; }
  async buyFAK(a) { this.calls.push({ side: 'BUY', ...a }); return this.script.buy[a.tokenId] || { ok: true, filledShares: 0, usdc: 0, ackMs: 1, avgPrice: null }; }
  async sellFAK(a) { this.calls.push({ side: 'SELL', ...a }); return this.script.sell?.[a.tokenId] || { ok: true, filledShares: 0, usdc: 0, ackMs: 1, avgPrice: null }; }
}

function setup(script, over = {}) {
  const c = cfg();
  const observer = new Observer(c);
  const nowMs = Date.now();
  const mkt = {
    series: 'btc-updown-5m', slug: 'btc-updown-5m-100', windowStartMs: nowMs - 60_000,
    windowEndMs: nowMs + 240_000, conditionId: '0xc', upToken: 'UP', downToken: 'DOWN',
    feeSchedule: FEES, minOrderSize: 5, tickSize: 0.01, ...over.mkt,
  };
  observer.setMarket('btc-updown-5m', mkt);
  const books = new Map();
  const up = new Book('UP'); const down = new Book('DOWN');
  up.applySnapshot({ bids: [{ price: 0.84, size: 50 }], asks: [{ price: 0.85, size: 50 }] }, nowMs);
  down.applySnapshot({ bids: [{ price: 0.08, size: 50 }], asks: [{ price: 0.10, size: 50 }] }, nowMs);
  books.set('UP', up); books.set('DOWN', down);
  const ledger = new PairLedger({ maxActiveUsdc: c.detector.maxActiveUsdc, maxPairsPerWindow: c.trader.maxPairsPerWindow, dataDir: null });
  const venue = new FakeVenue(script);
  const updates = [];
  const taker = new Taker({ cfg: c, ledger, venue, observer, onPairUpdate: (p) => updates.push(p), log: () => {} });
  return { taker, ledger, venue, books, nowMs, mkt, updates };
}

function settle() { return new Promise((r) => setTimeout(r, 30)); }

test('taker fires both FAKs and books MATCHED, notifying the strategy', async () => {
  const { taker, ledger, venue, books, nowMs, updates } = setup({
    buy: {
      UP: { ok: true, filledShares: 10, usdc: 8.5, ackMs: 40, avgPrice: 0.85 },
      DOWN: { ok: true, filledShares: 10, usdc: 1.0, ackMs: 45, avgPrice: 0.10 },
    },
  });
  taker.onBookUpdate('btc-updown-5m', books, nowMs);
  await settle();
  assert.equal(venue.calls.filter((c) => c.side === 'BUY').length, 2);
  const pair = [...ledger.pairs.values()][0];
  assert.equal(pair.state, 'MATCHED');
  assert.equal(pair.detect.clip, 10); // ceil(1/0.10)
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, pair.id);
});

test('one-legged fill: immediate unwind at the bid with exact basis', async () => {
  const { taker, ledger, venue, books, nowMs } = setup({
    buy: {
      UP: { ok: true, filledShares: 10, usdc: 8.5, ackMs: 40, avgPrice: 0.85 },
      DOWN: { ok: true, filledShares: 0, usdc: 0, ackMs: 45, avgPrice: null },
    },
    sell: { UP: { ok: true, filledShares: 10, usdc: 8.4, avgPrice: 0.84, ackMs: 30 } },
  });
  taker.onBookUpdate('btc-updown-5m', books, nowMs);
  await settle();
  const sell = venue.calls.find((c) => c.side === 'SELL');
  assert.equal(sell.tokenId, 'UP');
  assert.equal(sell.price, 0.84);
  const pair = [...ledger.pairs.values()][0];
  assert.equal(pair.state, 'UNWOUND');
  assert.equal(pair.realizedPnl, -0.1);
  assert.equal(pair.unwindLossUsdc, 0.1);
});

test('excess below exchange min size -> STRANDED, no sell attempted', async () => {
  const { taker, ledger, venue, books, nowMs } = setup({
    buy: {
      UP: { ok: true, filledShares: 10, usdc: 8.5, ackMs: 40, avgPrice: 0.85 },
      DOWN: { ok: true, filledShares: 7, usdc: 0.7, ackMs: 45, avgPrice: 0.10 },
    },
  });
  taker.onBookUpdate('btc-updown-5m', books, nowMs);
  await settle();
  assert.ok(!venue.calls.some((c) => c.side === 'SELL'));
  const pair = [...ledger.pairs.values()][0];
  assert.equal(pair.state, 'STRANDED');
  assert.deepEqual(pair.qty, { up: 10, down: 7 });
});

test('no re-fire while in flight or during re-arm cooldown', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { taker, books, nowMs } = setup({ buy: {} });
  taker.venue.buyFAK = async () => { await gate; return { ok: true, filledShares: 0, usdc: 0, ackMs: 1, avgPrice: null }; };
  taker.onBookUpdate('btc-updown-5m', books, nowMs);
  taker.onBookUpdate('btc-updown-5m', books, nowMs + 1);
  release();
  await settle();
  taker.onBookUpdate('btc-updown-5m', books, Date.now());
  assert.equal(taker.attempts, 1);
});

test('per-series allocation cap blocks before any order goes out', async () => {
  const { taker, ledger, venue, books, nowMs } = setup({ buy: {} });
  taker.onBookUpdate('btc-updown-5m', books, nowMs, 5); // est ~$9.5 > $5 series cap
  await settle();
  assert.equal(venue.calls.length, 0);
  assert.equal(ledger.pairs.size, 0);
});

test('halted taker never fires', async () => {
  const { taker, venue, books, nowMs } = setup({ buy: {} });
  taker.halt('test');
  taker.onBookUpdate('btc-updown-5m', books, nowMs);
  await settle();
  assert.equal(venue.calls.length, 0);
});
