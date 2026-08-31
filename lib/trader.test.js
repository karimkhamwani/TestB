'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Trader } = require('./trader');
const { PairLedger } = require('./ledger');
const { Observer } = require('./observer');
const { Book } = require('./books');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const FEES = { exponent: 1, rate: 0.07, takerOnly: true };

function cfg() {
  return {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'arb-tr-')),
    detector: {
      buySum: 0.985, sellSum: 1.015, shares: 5, maxActiveUsdc: 20,
      minTauSec: 20, freshnessMs: 1000, minDepth: 5,
      priceBandMin: 0.01, priceBandMax: 0.99,
    },
    observer: { minEventMs: 300, gateEventsPerDay: 20, sampleIntervalMs: 1000, xtfDivergence: 0.15, nearResWindowSec: 30 },
    trader: { maxPairsPerWindow: 2, rearmMs: 1500, unwindRetries: 3, feeRateBps: 1000, liveConfirm: false },
  };
}

/** Venue whose fills are scripted per token. */
class FakeVenue {
  constructor(script) { this.script = script; this.kind = 'fake'; this.calls = []; }
  async buyFAK(a) { this.calls.push({ side: 'BUY', ...a }); return this.script.buy[a.tokenId] || { ok: true, filledShares: 0, usdc: 0, ackMs: 1 }; }
  async sellFAK(a) { this.calls.push({ side: 'SELL', ...a }); return this.script.sell?.[a.tokenId] || { ok: true, filledShares: 0, usdc: 0, ackMs: 1 }; }
}

function setup(script, over = {}) {
  const c = cfg();
  const observer = new Observer(c);
  const nowMs = Date.now();
  const mkt = {
    series: 'btc-updown-5m', slug: 'btc-updown-5m-100', windowStartMs: nowMs - 60_000,
    windowEndMs: nowMs + 240_000, upToken: 'UP', downToken: 'DOWN',
    feeSchedule: FEES, minOrderSize: 5, tickSize: 0.01, ...over.mkt,
  };
  observer.setMarket('btc-updown-5m', mkt);
  const books = new Map();
  const up = new Book('UP'); const down = new Book('DOWN');
  // Clean opportunity: 0.85 + 0.10 = 0.95 raw, deep books.
  up.applySnapshot({ bids: [{ price: 0.84, size: 50 }], asks: [{ price: 0.85, size: 50 }] }, nowMs);
  down.applySnapshot({ bids: [{ price: 0.08, size: 50 }], asks: [{ price: 0.10, size: 50 }] }, nowMs);
  books.set('UP', up); books.set('DOWN', down);
  const ledger = new PairLedger({ maxActiveUsdc: c.detector.maxActiveUsdc, maxPairsPerWindow: c.trader.maxPairsPerWindow, dataDir: null });
  const venue = new FakeVenue(script);
  const trader = new Trader({ cfg: c, ledger, venue, observer, log: () => {} });
  return { trader, ledger, venue, books, nowMs, mkt };
}

function settle() { return new Promise((r) => setTimeout(r, 30)); }

test('trader fires both FAKs on a clean opportunity and books MATCHED', async () => {
  const { trader, ledger, venue, books, nowMs } = setup({
    buy: {
      UP: { ok: true, filledShares: 10, usdc: 8.5, ackMs: 40 },
      DOWN: { ok: true, filledShares: 10, usdc: 1.0, ackMs: 45 },
    },
  });
  trader.onBookUpdate('btc-updown-5m', books, nowMs);
  await settle();
  assert.equal(venue.calls.filter((c) => c.side === 'BUY').length, 2);
  const pair = [...ledger.pairs.values()][0];
  assert.equal(pair.state, 'MATCHED');
  assert.equal(pair.detect.clip, 10); // ceil(1/0.10)
  assert.ok(pair.latencyMs.detectToLastAck >= 0);
  assert.equal(trader.attempts, 1);
});

test('trader: one-legged fill triggers an immediate unwind at the bid', async () => {
  const { trader, ledger, venue, books, nowMs } = setup({
    buy: {
      UP: { ok: true, filledShares: 10, usdc: 8.5, ackMs: 40 },
      DOWN: { ok: true, filledShares: 0, usdc: 0, ackMs: 45 },
    },
    sell: { UP: { ok: true, filledShares: 10, usdc: 8.4, avgPrice: 0.84, ackMs: 30 } },
  });
  trader.onBookUpdate('btc-updown-5m', books, nowMs);
  await settle();
  const sell = venue.calls.find((c) => c.side === 'SELL');
  assert.ok(sell, 'must attempt sell-back');
  assert.equal(sell.tokenId, 'UP');
  assert.equal(sell.price, 0.84); // at the bid
  const pair = [...ledger.pairs.values()][0];
  assert.equal(pair.state, 'UNWOUND');
  assert.equal(pair.realizedPnl, -0.1);
});

test('trader: excess below exchange min size is marked STRANDED, not sold', async () => {
  const { trader, ledger, venue, books, nowMs } = setup({
    buy: {
      UP: { ok: true, filledShares: 10, usdc: 8.5, ackMs: 40 },
      DOWN: { ok: true, filledShares: 7, usdc: 0.7, ackMs: 45 }, // excess 3 < min 5
    },
  });
  trader.onBookUpdate('btc-updown-5m', books, nowMs);
  await settle();
  assert.ok(!venue.calls.some((c) => c.side === 'SELL'));
  const pair = [...ledger.pairs.values()][0];
  assert.equal(pair.state, 'STRANDED');
  assert.equal(pair.matchedShares, 7);
});

test('trader: no re-fire while in flight or during re-arm cooldown', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { trader, books, nowMs } = setup({ buy: {} });
  trader.venue.buyFAK = async () => { await gate; return { ok: true, filledShares: 0, usdc: 0, ackMs: 1 }; };
  trader.onBookUpdate('btc-updown-5m', books, nowMs);
  trader.onBookUpdate('btc-updown-5m', books, nowMs + 1); // in flight -> ignored
  release();
  await settle();
  trader.onBookUpdate('btc-updown-5m', books, Date.now()); // still inside rearmMs
  assert.equal(trader.attempts, 1);
});

test('trader: halted trader never fires', async () => {
  const { trader, venue, books, nowMs } = setup({ buy: {} });
  trader.halt('test');
  trader.onBookUpdate('btc-updown-5m', books, nowMs);
  await settle();
  assert.equal(venue.calls.length, 0);
});

test('trader: ledger caps block the attempt before any order goes out', async () => {
  const { trader, ledger, venue, books, nowMs } = setup({ buy: {} });
  ledger.maxActiveUsdc = 5; // clip 10 * 0.95 = $9.5 estimate > cap
  trader.onBookUpdate('btc-updown-5m', books, nowMs);
  await settle();
  assert.equal(venue.calls.length, 0);
  assert.equal(ledger.pairs.size, 0);
});

test('trader: drainResolutions books outcomes for held pairs', async () => {
  const { trader, ledger, books, nowMs } = setup({
    buy: {
      UP: { ok: true, filledShares: 10, usdc: 8.5, ackMs: 40 },
      DOWN: { ok: true, filledShares: 10, usdc: 1.0, ackMs: 45 },
    },
  });
  trader.onBookUpdate('btc-updown-5m', books, nowMs);
  await settle();
  const pair = [...ledger.pairs.values()][0];
  await trader.drainResolutions(async () => 'Down', pair.windowEndMs + 100_000);
  assert.equal(pair.state, 'RESOLVED');
  assert.equal(pair.realizedPnl, 0.5);
});
