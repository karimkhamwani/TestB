'use strict';

// arb-core.js — pure detector math for the bi-directional pair arb.
//
// Everything in this file is a pure function of its inputs: no I/O, no clocks,
// no globals. This is the module the C++ engine must mirror; the golden test
// vectors (arb-core.vectors.json, produced by test/dump-vectors.js) are dumped
// from these exact functions at 6dp.
//
// Conventions:
//   - prices are decimals in [0, 1] (e.g. 0.57)
//   - fees are per SHARE unless a function says otherwise
//   - "feeSchedule" is the object gamma serves per market, e.g.
//       { exponent: 1, rate: 0.07, takerOnly: true, rebateRate: 0.2 }
//     with feeType "crypto_fees_v2" / feesEnabled true.
//
// FEE FORMULA CAVEAT (plan §2): fee = shares * rate * (p*(1-p))^exponent is
// the V2 write-up's formula with the live feeSchedule parameters observed on
// real updown markets (rate 0.07, exponent 1 => 1.75c/share at p=0.50, ~0 at
// the extremes). The base (shares vs notional) is secondhand until verified
// against one real charged fill — work item in Phase 1, before any live gate.

const ROUND_DP = 6;

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

/** Taker fee per share at price p under a V2 crypto fee schedule. Makers pay
 *  zero when takerOnly is set (it is, on every observed updown market). */
function takerFeePerShare(price, feeSchedule) {
  if (!feeSchedule || feeSchedule.feesEnabled === false) return 0;
  const rate = Number(feeSchedule.rate) || 0;
  const exponent = feeSchedule.exponent == null ? 1 : Number(feeSchedule.exponent);
  const p = Math.min(Math.max(price, 0), 1);
  return rate * Math.pow(p * (1 - p), exponent);
}

function makerFeePerShare(price, feeSchedule) {
  if (!feeSchedule || feeSchedule.feesEnabled === false) return 0;
  if (feeSchedule.takerOnly !== false) return 0; // takers pay; makers exempt
  return takerFeePerShare(price, feeSchedule);
}

/** Fee-adjusted BUY sum: what a take-take buyer really pays per pair-share. */
function feeAdjustedBuySum(askUp, askDown, feeSchedule) {
  return askUp + askDown
    + takerFeePerShare(askUp, feeSchedule)
    + takerFeePerShare(askDown, feeSchedule);
}

/** Fee-adjusted SELL sum: what a take-take seller really receives per pair-share. */
function feeAdjustedSellSum(bidUp, bidDown, feeSchedule) {
  return bidUp + bidDown
    - takerFeePerShare(bidUp, feeSchedule)
    - takerFeePerShare(bidDown, feeSchedule);
}

/** Per-share edge on the buy side (cheap pair): 1 - feeAdjBuySum. */
function buyEdgePerShare(askUp, askDown, feeSchedule) {
  return 1 - feeAdjustedBuySum(askUp, askDown, feeSchedule);
}

/** Per-share edge on the sell side (rich pair): feeAdjSellSum - 1. */
function sellEdgePerShare(bidUp, bidDown, feeSchedule) {
  return feeAdjustedSellSum(bidUp, bidDown, feeSchedule) - 1;
}

/**
 * Dynamic clip size (plan §4 detector NOTE): a fixed clip locks the bot out of
 * exactly the polarized pairs the fee model favors, because a 5-share clip on
 * a $0.09 leg is $0.45 — under the exchange's $1 marketable minimum.
 *
 *   shares = max(baseShares, minOrderSize, ceil(1 / cheapLegPrice))
 * capped by depth on BOTH legs and by the active-USDC cap.
 *
 * Returns 0 when the caps cannot accommodate the required minimum (i.e. the
 * opportunity is un-tradeable at our constraints, not "trade smaller").
 */
function clipShares({ baseShares, minOrderSize = 5, priceUp, priceDown, depthUp, depthDown, maxUsdc, usdcPerShare }) {
  const cheapLeg = Math.min(priceUp, priceDown);
  if (!(cheapLeg > 0)) return 0;
  const minMarketable = Math.ceil(1 / cheapLeg); // $1 minimum per leg
  const required = Math.max(baseShares, minOrderSize, minMarketable);
  // Capital per pair-share: buy side pays the ask sum; sell side parks $1.00
  // (the CTF split) regardless of bid prices. Caller passes usdcPerShare=1 there.
  const pairCost = usdcPerShare ?? (priceUp + priceDown);
  const capByDepth = Math.floor(Math.min(depthUp, depthDown));
  const capByUsdc = pairCost > 0 ? Math.floor(maxUsdc / pairCost) : 0;
  const clip = Math.min(required, capByDepth, capByUsdc);
  return clip >= required ? clip : 0;
}

/**
 * Full gated evaluation of one Up/Down pair snapshot. Pure: caller supplies
 * `nowMs`. Returns per-side results with an explicit reject-reason list so the
 * observer can count WHY opportunities die, not just that they did.
 *
 * input = {
 *   askUp, askDown, bidUp, bidDown,        // best prices (null/undefined if side empty)
 *   askUpSize, askDownSize, bidUpSize, bidDownSize,
 *   bookTsUpMs, bookTsDownMs,              // last book update per token
 *   windowEndMs, nowMs,
 *   feeSchedule, minOrderSize,
 * }
 * cfg = { buySum, sellSum, shares, maxActiveUsdc, minTauSec, freshnessMs,
 *         minDepth, priceBandMin, priceBandMax }
 */
function evaluatePair(input, cfg) {
  const tauSec = (input.windowEndMs - input.nowMs) / 1000;
  const ageUp = input.nowMs - input.bookTsUpMs;
  const ageDown = input.nowMs - input.bookTsDownMs;

  const common = [];
  if (!(tauSec > cfg.minTauSec)) common.push('tau');
  if (!(ageUp < cfg.freshnessMs) || !(ageDown < cfg.freshnessMs)) common.push('stale-book');

  const side = (kind) => {
    const isBuy = kind === 'buy';
    const pUp = isBuy ? input.askUp : input.bidUp;
    const pDown = isBuy ? input.askDown : input.bidDown;
    const sUp = isBuy ? input.askUpSize : input.bidUpSize;
    const sDown = isBuy ? input.askDownSize : input.bidDownSize;

    const reasons = [...common];
    if (pUp == null || pDown == null) {
      return { ok: false, reasons: [...reasons, 'empty-book'], edge: null, feeAdjSum: null, clip: 0 };
    }

    const feeAdjSum = isBuy
      ? feeAdjustedBuySum(pUp, pDown, input.feeSchedule)
      : feeAdjustedSellSum(pUp, pDown, input.feeSchedule);
    const edge = isBuy ? 1 - feeAdjSum : feeAdjSum - 1;
    const triggered = isBuy ? feeAdjSum <= cfg.buySum : feeAdjSum >= cfg.sellSum;
    if (!triggered) reasons.push('no-edge');

    for (const p of [pUp, pDown]) {
      if (p < cfg.priceBandMin || p > cfg.priceBandMax) { reasons.push('price-band'); break; }
    }
    if (!(Math.min(sUp ?? 0, sDown ?? 0) >= cfg.minDepth)) reasons.push('depth');

    const clip = clipShares({
      baseShares: cfg.shares,
      minOrderSize: input.minOrderSize ?? 5,
      priceUp: pUp, priceDown: pDown,
      depthUp: sUp ?? 0, depthDown: sDown ?? 0,
      maxUsdc: cfg.maxActiveUsdc,
      usdcPerShare: isBuy ? undefined : 1, // sell side parks $1/share via splitPosition
    });
    if (clip === 0) reasons.push('clip');

    return {
      ok: reasons.length === 0,
      reasons,
      edge: round6(edge),
      feeAdjSum: round6(feeAdjSum),
      rawSum: round6(pUp + pDown),
      clip,
    };
  };

  return { buy: side('buy'), sell: side('sell'), tauSec: round6(tauSec) };
}

module.exports = {
  ROUND_DP,
  round6,
  takerFeePerShare,
  makerFeePerShare,
  feeAdjustedBuySum,
  feeAdjustedSellSum,
  buyEdgePerShare,
  sellEdgePerShare,
  clipShares,
  evaluatePair,
};
