'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('./arb-core');

// The live schedule observed on btc-updown-5m markets (feeType crypto_fees_v2)
const FEES = { exponent: 1, rate: 0.07, takerOnly: true, rebateRate: 0.2 };
const NO_FEES = null;

const CFG = {
  buySum: 0.985,
  sellSum: 1.015,
  shares: 5,
  maxActiveUsdc: 10,
  minTauSec: 20,
  freshnessMs: 1000,
  minDepth: 5,
  priceBandMin: 0.01,
  priceBandMax: 0.99,
};

function baseInput(over = {}) {
  return {
    askUp: 0.49, askDown: 0.48, bidUp: 0.48, bidDown: 0.47,
    askUpSize: 50, askDownSize: 50, bidUpSize: 50, bidDownSize: 50,
    bookTsUpMs: 10_000, bookTsDownMs: 10_000,
    windowEndMs: 310_000, nowMs: 10_100,
    feeSchedule: FEES, minOrderSize: 5,
    ...over,
  };
}

test('taker fee peaks at p=0.50 and collapses at the extremes', () => {
  const mid = core.takerFeePerShare(0.50, FEES);
  assert.equal(core.round6(mid), 0.0175); // 0.07 * 0.25
  assert.ok(core.takerFeePerShare(0.10, FEES) < mid);
  assert.ok(core.takerFeePerShare(0.90, FEES) < mid);
  assert.equal(core.round6(core.takerFeePerShare(0.99, FEES)), core.round6(0.07 * 0.99 * 0.01));
  assert.equal(core.takerFeePerShare(0.5, NO_FEES), 0);
  assert.equal(core.takerFeePerShare(0.5, { ...FEES, feesEnabled: false }), 0);
});

test('fee is symmetric in p (p(1-p) curve)', () => {
  assert.equal(
    core.round6(core.takerFeePerShare(0.30, FEES)),
    core.round6(core.takerFeePerShare(0.70, FEES)),
  );
});

test('makers pay zero under takerOnly', () => {
  assert.equal(core.makerFeePerShare(0.50, FEES), 0);
  assert.ok(core.makerFeePerShare(0.50, { ...FEES, takerOnly: false }) > 0);
});

test('buy edge: 0.49+0.49 pair with fees is WORSE than 0.90+0.08 pair with fees', () => {
  // Same raw sum 0.98, but the polarized pair sits near the fee curve floor.
  const mid = core.buyEdgePerShare(0.49, 0.49, FEES);
  const pol = core.buyEdgePerShare(0.90, 0.08, FEES);
  assert.ok(pol > mid, `polarized ${pol} should beat midpoint ${mid}`);
  // Raw (no-fee) edges are identical:
  assert.equal(core.round6(core.buyEdgePerShare(0.49, 0.49, NO_FEES)), 0.02);
  assert.equal(core.round6(core.buyEdgePerShare(0.90, 0.08, NO_FEES)), 0.02);
});

test('buy edge exact value at 0.49/0.49 under live schedule', () => {
  // fee per leg = 0.07 * 0.49 * 0.51 = 0.0174930
  const expected = 1 - 0.98 - 2 * (0.07 * 0.49 * 0.51);
  assert.equal(core.round6(core.buyEdgePerShare(0.49, 0.49, FEES)), core.round6(expected));
});

test('sell edge: fees subtract from proceeds', () => {
  assert.equal(core.round6(core.sellEdgePerShare(0.52, 0.50, NO_FEES)), 0.02);
  const withFees = core.sellEdgePerShare(0.52, 0.50, FEES);
  assert.ok(withFees < 0.02 && withFees < 0);  // 3.5c of fees eats a 2c raw edge
});

test('fee-adjusted sums are the edge complements', () => {
  const b = core.feeAdjustedBuySum(0.49, 0.48, FEES);
  assert.equal(core.round6(1 - b), core.round6(core.buyEdgePerShare(0.49, 0.48, FEES)));
  const s = core.feeAdjustedSellSum(0.52, 0.51, FEES);
  assert.equal(core.round6(s - 1), core.round6(core.sellEdgePerShare(0.52, 0.51, FEES)));
});

// ---------- clip sizing ----------

test('clip: plain midpoint pair uses base shares', () => {
  const clip = core.clipShares({
    baseShares: 5, minOrderSize: 5, priceUp: 0.49, priceDown: 0.48,
    depthUp: 50, depthDown: 50, maxUsdc: 10,
  });
  assert.equal(clip, 5);
});

test('clip: polarized pair scales up past the $1 marketable minimum', () => {
  // cheap leg $0.08 -> ceil(1/0.08) = 13 shares needed
  const clip = core.clipShares({
    baseShares: 5, minOrderSize: 5, priceUp: 0.90, priceDown: 0.08,
    depthUp: 50, depthDown: 50, maxUsdc: 20,
  });
  assert.equal(clip, 13);
});

test('clip: returns 0 (not a smaller trade) when depth cannot cover the minimum', () => {
  const clip = core.clipShares({
    baseShares: 5, minOrderSize: 5, priceUp: 0.90, priceDown: 0.08,
    depthUp: 50, depthDown: 9, maxUsdc: 20, // depth 9 < required 13
  });
  assert.equal(clip, 0);
});

test('clip: returns 0 when the USDC cap cannot cover the minimum', () => {
  const clip = core.clipShares({
    baseShares: 5, minOrderSize: 5, priceUp: 0.49, priceDown: 0.48,
    depthUp: 50, depthDown: 50, maxUsdc: 4, // 5 shares * 0.97 = 4.85 > 4
  });
  assert.equal(clip, 0);
});

test('clip: honors exchange minOrderSize over baseShares', () => {
  const clip = core.clipShares({
    baseShares: 2, minOrderSize: 5, priceUp: 0.49, priceDown: 0.48,
    depthUp: 50, depthDown: 50, maxUsdc: 10,
  });
  assert.equal(clip, 5);
});

test('clip: zero/absent prices are untradeable', () => {
  assert.equal(core.clipShares({
    baseShares: 5, minOrderSize: 5, priceUp: 0, priceDown: 0.5,
    depthUp: 50, depthDown: 50, maxUsdc: 10,
  }), 0);
});

// ---------- evaluatePair gating ----------

test('evaluate: clean buy-side opportunity passes all gates', () => {
  const r = core.evaluatePair(baseInput({ askUp: 0.10, askDown: 0.85 }), CFG);
  assert.equal(r.buy.ok, true, JSON.stringify(r.buy));
  assert.deepEqual(r.buy.reasons, []);
  assert.ok(r.buy.edge > 0.015);
  assert.equal(r.buy.clip, 10); // ceil(1/0.10)
});

test('evaluate: midpoint 0.98 raw sum FAILS the fee-adjusted trigger', () => {
  // Raw sum 0.97 but ~3.5c of taker fees pushes feeAdjSum above 0.985.
  const r = core.evaluatePair(baseInput({ askUp: 0.49, askDown: 0.48 }), CFG);
  assert.ok(r.buy.feeAdjSum > CFG.buySum);
  assert.ok(r.buy.reasons.includes('no-edge'));
  assert.equal(r.buy.ok, false);
});

test('evaluate: stale book rejects both sides', () => {
  const r = core.evaluatePair(baseInput({ bookTsDownMs: 5000, askUp: 0.10, askDown: 0.85 }), CFG);
  assert.ok(r.buy.reasons.includes('stale-book'));
  assert.ok(r.sell.reasons.includes('stale-book'));
});

test('evaluate: too little time remaining rejects', () => {
  const r = core.evaluatePair(baseInput({ nowMs: 295_000, bookTsUpMs: 294_950, bookTsDownMs: 294_950, askUp: 0.10, askDown: 0.85 }), CFG);
  assert.ok(r.buy.reasons.includes('tau'));
});

test('evaluate: thin depth rejects', () => {
  const r = core.evaluatePair(baseInput({ askUp: 0.10, askDown: 0.85, askDownSize: 3 }), CFG);
  assert.ok(r.buy.reasons.includes('depth'));
  assert.equal(r.buy.ok, false);
});

test('evaluate: price band rejects a 0.995 leg', () => {
  const r = core.evaluatePair(baseInput({ askUp: 0.995, askDown: 0.001 }), CFG);
  assert.ok(r.buy.reasons.includes('price-band'));
});

test('evaluate: empty book side reports empty-book, not a crash', () => {
  const r = core.evaluatePair(baseInput({ bidUp: null }), CFG);
  assert.equal(r.sell.ok, false);
  assert.ok(r.sell.reasons.includes('empty-book'));
  assert.equal(r.sell.edge, null);
});

test('evaluate: sell-side opportunity with a genuinely rich pair', () => {
  // Polarized rich pair keeps fees near zero: 0.92 + 0.12 = 1.04 bid sum.
  // Sell-side capital is $1/pair-share (the split), so the $10 cap allows 10.
  const r = core.evaluatePair(baseInput({ bidUp: 0.92, bidDown: 0.12 }), CFG);
  assert.equal(r.sell.ok, true, JSON.stringify(r.sell));
  assert.ok(r.sell.feeAdjSum >= CFG.sellSum);
  assert.equal(r.sell.clip, 9); // ceil(1/0.12)
});

test('evaluate: sell-side clip is capped by $1/share split capital, not bid sum', () => {
  // Cheap leg $0.09 needs 12 shares = $12 of split capital > $10 cap -> untradeable.
  const r = core.evaluatePair(baseInput({ bidUp: 0.94, bidDown: 0.09 }), CFG);
  assert.equal(r.sell.clip, 0);
  assert.ok(r.sell.reasons.includes('clip'));
});

test('evaluate: rich pair at the midpoint dies to fees', () => {
  // Raw bid sum 1.02 at ~0.5/0.5 loses ~3.5c to fees -> below 1.015 trigger.
  const r = core.evaluatePair(baseInput({ bidUp: 0.52, bidDown: 0.50 }), CFG);
  assert.ok(r.sell.feeAdjSum < CFG.sellSum);
  assert.ok(r.sell.reasons.includes('no-edge'));
});

test('evaluate: results are rounded to 6dp (vector-stable)', () => {
  const r = core.evaluatePair(baseInput(), CFG);
  for (const v of [r.buy.edge, r.buy.feeAdjSum, r.sell.edge, r.sell.feeAdjSum, r.tauSec]) {
    assert.equal(v, core.round6(v));
  }
});
