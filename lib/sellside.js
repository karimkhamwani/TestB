'use strict';

// Sell-side module — harvest RICH pairs (bidSum > $1 + fees).
//
// Inventory comes from the CTF, not the order book: split $N USDC into
// N Up + N Down (fee-free, "split to obtain tokens without paying trading
// fees"), then sell both legs into the rich bids. A full pair is riskless
// inventory worth $1 regardless of outcome, so this direction's failure mode
// is gentler than the buy side's.
//
// Two inventory strategies, both implemented:
//   - pre-split (ARB_PRESPLIT_USDC > 0): split at window open and hold — the
//     sells fire instantly with no on-chain tx on the critical path
//   - split-on-signal: split only when a rich moment appears (adds the split
//     latency to the race; the measured split->sell round-trip decides which
//     to run)
// Unsold inventory merges back to USDC at window end (or rides to resolution
// if the merge fails — $1 either way).

const core = require('../arb-core');

class SellSide {
  constructor({ cfg, ledger, venue, observer, ctf, onPairUpdate, ownBidAtBest = null, log = () => {} }) {
    this.cfg = cfg;
    this.ledger = ledger;
    this.venue = venue;
    this.observer = observer;
    this.ctf = ctf;
    this.onPairUpdate = onPairUpdate;
    // Self-trade oracle supplied by the strategy: true when OUR maker bid is
    // the best bid on a token (works in paper AND live — the venue can't know).
    this.ownBidAtBest = ownBidAtBest || ((tokenId) => this.venue.restingAtBest && this.venue.restingAtBest(tokenId, 'BUY'));
    this.log = log;
    this.inv = new Map();     // series -> {pairId, window}
    this.inFlight = new Set();
    this.rearmAt = new Map();
    this.splitLatencies = [];
  }

  /** Window open: pre-split inventory if configured. */
  async onWindowStart(series, mkt) {
    const presplit = this.cfg.trader.presplitUsdc;
    if (!(presplit > 0)) return;
    if (!this.ledger.canOpen(series, mkt.slug, presplit).ok) return;
    const pair = this.ledger.openPair({
      source: 'sellside', series, window: mkt.slug, windowEndMs: mkt.windowEndMs,
      conditionId: mkt.conditionId, upToken: mkt.upToken, downToken: mkt.downToken,
      meta: { presplit: true, tDetect: Date.now(), expectedFees: 0 },
      estUsdc: presplit, // reserve while the split tx is in flight
    });
    const res = await this.ctf.split(mkt.conditionId, presplit);
    if (!res.ok) {
      this.log(`sellside pre-split failed (${series}): ${res.error}`);
      this.ledger.settleIfFlat(pair.id);
      return;
    }
    this.ledger.bookSplit(pair.id, { shares: res.shares, usdc: presplit, costUsdc: res.costUsdc || 0 });
    this.inv.set(series, { pairId: pair.id, window: mkt.slug });
    this.log(`sellside pre-split ${series}: $${presplit} -> ${res.shares} pairs`);
  }

  async onBookUpdate(series, books, nowMs, seriesCapUsdc) {
    if (this.inFlight.has(series) || (this.rearmAt.get(series) || 0) > nowMs) return;
    const input = this.observer.snapshot(series, books, nowMs);
    if (!input) return;
    const r = core.evaluatePair(input, this.cfg.detector);
    if (!r.sell.ok) return;

    const mkt = this.observer.markets.get(series);
    this.inFlight.add(series);
    try {
      await this._attempt(series, mkt, input, r.sell, nowMs, seriesCapUsdc);
    } catch (err) {
      this.log(`sellside attempt error ${series}: ${err.message}`);
    } finally {
      this.inFlight.delete(series);
      this.rearmAt.set(series, Date.now() + this.cfg.trader.rearmMs);
    }
  }

  async _attempt(series, mkt, input, sell, tDetect, seriesCapUsdc) {
    // Self-trade guard FIRST — before any capital moves. Never sell into a
    // level where our own maker bid rests, and never split just to discover
    // we can't sell (that orphaned inventory and re-split every re-arm).
    for (const tok of [mkt.upToken, mkt.downToken]) {
      if (this.ownBidAtBest(tok)) {
        return;
      }
    }

    let inv = this.inv.get(series);
    if (inv && inv.window !== mkt.slug) inv = null;
    let pair = inv ? this.ledger.pairs.get(inv.pairId) : null;
    let clip = sell.clip;

    if (pair) {
      clip = Math.min(clip, pair.qty.up, pair.qty.down);
      if (clip < (mkt.minOrderSize || 5)) return;
    } else {
      // Split-on-signal: the on-chain tx sits in the race — measure it.
      const usdc = clip * 1.0;
      if (!this.ledger.canOpen(series, mkt.slug, usdc, seriesCapUsdc).ok) return;
      pair = this.ledger.openPair({
        source: 'sellside', series, window: mkt.slug, windowEndMs: mkt.windowEndMs,
        conditionId: mkt.conditionId, upToken: mkt.upToken, downToken: mkt.downToken,
        meta: { bidUp: input.bidUp, bidDown: input.bidDown, clip, tDetect, expectedFees: sell.feeAdjSum !== null ? clip * (input.bidUp + input.bidDown - sell.feeAdjSum) : 0 },
        estUsdc: usdc,
      });
      const t0 = Date.now();
      const res = await this.ctf.split(mkt.conditionId, usdc);
      if (!res.ok) {
        this.log(`sellside split failed (${series}): ${res.error}`);
        this.ledger.settleIfFlat(pair.id);
        return;
      }
      this.splitLatencies.push(Date.now() - t0);
      this.ledger.bookSplit(pair.id, { shares: res.shares, usdc, costUsdc: res.costUsdc || 0 });
      // Register inventory IMMEDIATELY: any early exit below must still leave
      // the split pairs tracked so onWindowRoll merges them back.
      this.inv.set(series, { pairId: pair.id, window: mkt.slug });
    }

    this.log(`sellside FIRE ${series}: sell ${clip} both legs at ${input.bidUp}/${input.bidDown} (feeAdjSellSum ${sell.feeAdjSum})`);
    const args = { size: clip, feeRateBps: this.cfg.trader.feeRateBps, tickSize: mkt.tickSize, feeSchedule: mkt.feeSchedule };
    const [up, down] = await Promise.all([
      this.venue.sellFAK({ ...args, tokenId: mkt.upToken, price: input.bidUp }),
      this.venue.sellFAK({ ...args, tokenId: mkt.downToken, price: input.bidDown }),
    ]);
    if (up.filledShares > 0) this.ledger.bookSell(pair.id, 'up', { shares: up.filledShares, usdc: up.usdc });
    if (down.filledShares > 0) this.ledger.bookSell(pair.id, 'down', { shares: down.filledShares, usdc: down.usdc });
    this.log(`sellside ${series}: sold up ${up.filledShares}/${clip} down ${down.filledShares}/${clip}`);
    if (pair.qty.up === 0 && pair.qty.down === 0) {
      this.ledger.settleIfFlat(pair.id);
      if (this.inv.get(series)?.pairId === pair.id) this.inv.delete(series);
      if (this.onPairUpdate) this.onPairUpdate(pair);
    }
  }

  /** Window rolled: merge leftover pairs back to cash; singles ride to resolution. */
  async onWindowRoll(series, mergeBatcher) {
    const inv = this.inv.get(series);
    if (!inv) return;
    this.inv.delete(series);
    const pair = this.ledger.pairs.get(inv.pairId);
    if (!pair) return;
    const mergeable = Math.min(pair.qty.up, pair.qty.down);
    if (mergeable > 0) {
      mergeBatcher.add(pair.conditionId, pair.id, mergeable);
      this.log(`sellside ${series}: queueing merge-back of ${mergeable} leftover pairs (pair ${pair.id})`);
    } else if (pair.qty.up === 0 && pair.qty.down === 0) {
      this.ledger.settleIfFlat(pair.id);
      if (this.onPairUpdate) this.onPairUpdate(pair);
    }
    // any single-leg remainder rides to resolution via pendingResolutions
  }

  splitLatencyStats() {
    if (!this.splitLatencies.length) return null;
    const s = [...this.splitLatencies].sort((a, b) => a - b);
    return { n: s.length, p50: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
  }
}

module.exports = { SellSide };
