'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PairLedger } = require('./ledger');

function ledger(over = {}) {
  return new PairLedger({ maxActiveUsdc: 10, maxPairsPerWindow: 2, dataDir: null, ...over });
}

function open(l, over = {}) {
  return l.openPair({
    source: 'taker', series: 'btc-updown-5m', window: 'btc-updown-5m-100', windowEndMs: 1_000_000,
    conditionId: '0xc', upToken: 'UP', downToken: 'DOWN',
    meta: { askUp: 0.85, askDown: 0.10, clip: 10, expectedFees: 0.02, tDetect: 900_000 },
    estUsdc: 9.5, ...over,
  });
}

test('taker lifecycle: both legs fill -> MATCHED; estimate replaced by real cost', () => {
  const l = ledger();
  const p = open(l);
  assert.equal(l.committedUsdc(), 9.5); // reservation
  l.bookBuy(p.id, 'up', { shares: 10, usdc: 8.5 });
  l.bookBuy(p.id, 'down', { shares: 10, usdc: 1.0 });
  assert.equal(p.state, 'MATCHED');
  assert.equal(l.committedUsdc(), 9.5); // now the real spend
  assert.deepEqual(p.qty, { up: 10, down: 10 });
});

test('merge finalizes a matched pair: MERGED with ctf cost in the pnl', () => {
  const l = ledger();
  const p = open(l);
  l.bookBuy(p.id, 'up', { shares: 10, usdc: 8.5 });
  l.bookBuy(p.id, 'down', { shares: 10, usdc: 1.0 });
  l.bookMerge(p.id, { shares: 10, usdc: 10, costUsdc: 0.01 });
  assert.equal(p.state, 'MERGED');
  assert.equal(p.realizedPnl, 0.49); // 10 - 9.5 - 0.01
  assert.equal(l.committedUsdc(), 0);
});

test('resolution: winner shares pay $1; UNKNOWN books only balanced pairs', () => {
  const l = ledger();
  const p = open(l);
  l.bookBuy(p.id, 'up', { shares: 10, usdc: 8.5 });
  l.bookBuy(p.id, 'down', { shares: 6, usdc: 0.6 });
  l.bookResolution(p.id, 'Up');
  assert.equal(p.redeemUsdc, 10); // all 10 Up shares won
  assert.equal(p.realizedPnl, 0.9); // 10 - 9.1

  const q = open(l, { window: 'w2' });
  l.bookBuy(q.id, 'up', { shares: 10, usdc: 8.5 });
  l.bookBuy(q.id, 'down', { shares: 6, usdc: 0.6 });
  l.bookResolution(q.id, null); // unknown -> only min(10,6) booked
  assert.equal(q.redeemUsdc, 6);
});

test('scratch: no fills, settleIfFlat -> SCRATCH releasing the reservation', () => {
  const l = ledger();
  const p = open(l);
  l.bookBuy(p.id, 'up', { shares: 0, usdc: 0 });
  l.bookBuy(p.id, 'down', { shares: 0, usdc: 0 });
  l.settleIfFlat(p.id);
  assert.equal(p.state, 'SCRATCH');
  assert.equal(p.realizedPnl, 0);
  assert.equal(l.committedUsdc(), 0);
});

test('unwind with basis books the loss exactly; full cut -> UNWOUND', () => {
  const l = ledger();
  const p = open(l);
  l.bookBuy(p.id, 'up', { shares: 10, usdc: 8.5, avgPrice: 0.85 });
  l.bookBuy(p.id, 'down', { shares: 0, usdc: 0 });
  assert.equal(p.state, 'PARTIAL');
  l.bookSell(p.id, 'up', { shares: 10, usdc: 8.2, reason: 'unwind', basisUsdc: 8.5 });
  l.settleIfFlat(p.id);
  assert.equal(p.state, 'UNWOUND');
  assert.equal(p.realizedPnl, -0.3);
  assert.equal(p.unwindLossUsdc, 0.3);
});

test('sellside lifecycle: split -> sell both -> flat -> UNWOUND-equivalent terminal', () => {
  const l = ledger();
  const p = open(l, { source: 'sellside', estUsdc: 10 });
  l.bookSplit(p.id, { shares: 10, usdc: 10, costUsdc: 0.01 });
  assert.deepEqual(p.qty, { up: 10, down: 10 });
  l.bookSell(p.id, 'up', { shares: 10, usdc: 9.2 });
  l.bookSell(p.id, 'down', { shares: 10, usdc: 1.2 });
  l.settleIfFlat(p.id);
  assert.equal(p.realizedPnl, 0.39); // 10.4 - 10 - 0.01
  assert.equal(l.committedUsdc(), 0);
});

test('sellside partial: leftover pairs merge back, realized nets out', () => {
  const l = ledger();
  const p = open(l, { source: 'sellside', estUsdc: 10 });
  l.bookSplit(p.id, { shares: 10, usdc: 10 });
  l.bookSell(p.id, 'up', { shares: 6, usdc: 5.7 });   // sold 6 Up @0.95
  l.bookSell(p.id, 'down', { shares: 4, usdc: 0.44 }); // sold 4 Down @0.11
  // leftover: 4 Up, 6 Down -> 4 mergeable pairs + 2 Down singles
  l.bookMerge(p.id, { shares: 4, usdc: 4, costUsdc: 0.01 });
  assert.deepEqual(p.qty, { up: 0, down: 2 });
  l.bookResolution(p.id, 'Down'); // singles won
  assert.equal(p.redeemUsdc, 2);
  assert.equal(p.realizedPnl, 2.13); // 5.7+0.44+4+2 - 10 - 0.01
});

test('selling more than held throws (booking guard)', () => {
  const l = ledger();
  const p = open(l);
  l.bookBuy(p.id, 'up', { shares: 5, usdc: 4 });
  assert.throws(() => l.bookSell(p.id, 'up', { shares: 6, usdc: 5 }), /holds/);
});

test('caps: pairs-per-window, active-USDC, and per-series allocation', () => {
  const l = ledger();
  const a = open(l, { estUsdc: 4 });
  assert.match(l.canOpen('btc-updown-5m', 'btc-updown-5m-100', 1, 4.5).why || '', /series allocation/);
  assert.equal(l.canOpen('btc-updown-5m', 'btc-updown-5m-100', 1, 6).ok, true);
  open(l, { estUsdc: 4 });
  assert.match(l.canOpen('btc-updown-5m', 'btc-updown-5m-100', 1).why, /pairs-per-window/);
  assert.match(l.canOpen('btc-updown-5m', 'w2', 4).why, /active-USDC/);
});

test('stats: decomposition and per-source rollup add up', () => {
  const l = ledger({ maxPairsPerWindow: 9 });
  const p1 = open(l);
  l.bookBuy(p1.id, 'up', { shares: 10, usdc: 8.5 });
  l.bookBuy(p1.id, 'down', { shares: 10, usdc: 1.0 });
  l.bookMerge(p1.id, { shares: 10, usdc: 10, costUsdc: 0.01 });
  const p2 = open(l, { source: 'maker' });
  l.bookBuy(p2.id, 'up', { shares: 5, usdc: 2.5, avgPrice: 0.5 });
  l.bookSell(p2.id, 'up', { shares: 5, usdc: 2.4, reason: 'unwind', basisUsdc: 2.5 });
  l.settleIfFlat(p2.id);
  const s = l.stats();
  assert.equal(s.realizedPnl, 0.39); // 0.49 - 0.1
  assert.equal(s.decomposition.merges, 10);
  assert.equal(s.decomposition.buys, 12);
  assert.equal(s.decomposition.unwindProceeds, 2.4);
  assert.equal(s.decomposition.unwindLosses, 0.1);
  assert.equal(s.decomposition.ctfCosts, 0.01);
  assert.equal(s.bySource.taker.realized, 0.49);
  assert.equal(s.bySource.maker.realized, -0.1);
  assert.equal(s.counts.MERGED, 1);
  assert.equal(s.counts.UNWOUND, 1);
});

test('pendingResolutions: only pairs still holding inventory past end + grace', () => {
  const l = ledger();
  const p = open(l, { windowEndMs: 1000 });
  l.bookBuy(p.id, 'up', { shares: 10, usdc: 8.5 });
  l.bookBuy(p.id, 'down', { shares: 10, usdc: 1.0 });
  assert.equal(l.pendingResolutions(1000 + 89_000).length, 0);
  assert.equal(l.pendingResolutions(1000 + 91_000).length, 1);
  l.bookMerge(p.id, { shares: 10, usdc: 10 });
  assert.equal(l.pendingResolutions(1000 + 91_000).length, 0);
});

test('realizedBySeries feeds the allocator', () => {
  const l = ledger({ maxPairsPerWindow: 9 });
  const p = open(l);
  l.bookBuy(p.id, 'up', { shares: 10, usdc: 8.5 });
  l.bookBuy(p.id, 'down', { shares: 10, usdc: 1.0 });
  l.bookMerge(p.id, { shares: 10, usdc: 10 });
  assert.deepEqual(l.realizedBySeries(), { 'btc-updown-5m': 0.5 });
});
