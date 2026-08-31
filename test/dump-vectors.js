'use strict';

// Dumps arb-core.vectors.json — the golden test vectors the C++ engine must
// reproduce bit-for-bit at 6dp (plan §4b guardrail 1). A vector mismatch fails
// the C++ build; there is no hand-waved "it's the same formula".

const fs = require('node:fs');
const path = require('node:path');
const core = require('../arb-core');

const FEES = { exponent: 1, rate: 0.07, takerOnly: true, rebateRate: 0.2 };
const CFG = {
  buySum: 0.985, sellSum: 1.015, shares: 5, maxActiveUsdc: 10,
  minTauSec: 20, freshnessMs: 1000, minDepth: 5,
  priceBandMin: 0.01, priceBandMax: 0.99,
};

const vectors = [];

// Fee curve grid
for (let p = 1; p <= 99; p += 7) {
  const price = p / 100;
  vectors.push({
    fn: 'takerFeePerShare',
    input: { price, feeSchedule: FEES },
    expect: core.round6(core.takerFeePerShare(price, FEES)),
  });
}

// Edge grid: every combination of a coarse price lattice
const lattice = [0.02, 0.08, 0.15, 0.33, 0.48, 0.49, 0.50, 0.52, 0.67, 0.85, 0.92, 0.97];
for (const a of lattice) for (const b of lattice) {
  vectors.push({
    fn: 'buyEdgePerShare',
    input: { askUp: a, askDown: b, feeSchedule: FEES },
    expect: core.round6(core.buyEdgePerShare(a, b, FEES)),
  });
  vectors.push({
    fn: 'sellEdgePerShare',
    input: { bidUp: a, bidDown: b, feeSchedule: FEES },
    expect: core.round6(core.sellEdgePerShare(a, b, FEES)),
  });
}

// Clip sizing cases, including the polarized $1-minimum and cap-starved paths
const clipCases = [
  { baseShares: 5, minOrderSize: 5, priceUp: 0.49, priceDown: 0.48, depthUp: 50, depthDown: 50, maxUsdc: 10 },
  { baseShares: 5, minOrderSize: 5, priceUp: 0.90, priceDown: 0.08, depthUp: 50, depthDown: 50, maxUsdc: 20 },
  { baseShares: 5, minOrderSize: 5, priceUp: 0.90, priceDown: 0.08, depthUp: 50, depthDown: 9, maxUsdc: 20 },
  { baseShares: 5, minOrderSize: 5, priceUp: 0.49, priceDown: 0.48, depthUp: 50, depthDown: 50, maxUsdc: 4 },
  { baseShares: 2, minOrderSize: 5, priceUp: 0.49, priceDown: 0.48, depthUp: 50, depthDown: 50, maxUsdc: 10 },
  { baseShares: 5, minOrderSize: 5, priceUp: 0.92, priceDown: 0.12, depthUp: 50, depthDown: 50, maxUsdc: 10, usdcPerShare: 1 },
  { baseShares: 5, minOrderSize: 5, priceUp: 0.94, priceDown: 0.09, depthUp: 50, depthDown: 50, maxUsdc: 10, usdcPerShare: 1 },
];
for (const c of clipCases) {
  vectors.push({ fn: 'clipShares', input: c, expect: core.clipShares(c) });
}

// Full evaluatePair cases (gates)
const evalCases = [
  { askUp: 0.10, askDown: 0.85, bidUp: 0.09, bidDown: 0.84 },
  { askUp: 0.49, askDown: 0.48, bidUp: 0.48, bidDown: 0.47 },
  { askUp: 0.995, askDown: 0.001, bidUp: 0.99, bidDown: 0.001 },
  { askUp: 0.50, askDown: 0.50, bidUp: 0.92, bidDown: 0.12 },
  { askUp: 0.50, askDown: 0.50, bidUp: 0.52, bidDown: 0.50 },
];
for (const c of evalCases) {
  const input = {
    askUpSize: 50, askDownSize: 50, bidUpSize: 50, bidDownSize: 50,
    bookTsUpMs: 10_000, bookTsDownMs: 10_000,
    windowEndMs: 310_000, nowMs: 10_100,
    feeSchedule: FEES, minOrderSize: 5,
    ...c,
  };
  vectors.push({ fn: 'evaluatePair', input, cfg: CFG, expect: core.evaluatePair(input, CFG) });
}

const out = path.join(__dirname, '..', 'arb-core.vectors.json');
fs.writeFileSync(out, JSON.stringify({ generatedBy: 'test/dump-vectors.js', roundDp: core.ROUND_DP, vectors }, null, 1));
console.log(`wrote ${vectors.length} vectors -> ${out}`);
