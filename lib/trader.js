'use strict';

// Taker module — take-take BUY side (the safe core of the strategy).
//
// On every book update: if the fee-adjusted ask sum clears the trigger with
// depth, freshness, tau and clip all green, fire TWO concurrent FAK buys.
// Outcomes:
//   both fill      -> matched pair (strategy merges it to cash, or holds to
//                     resolution when the CTF path is unavailable)
//   one / partial  -> IMMEDIATE sell-back of the excess at the bid (no leash,
//                     no wait — in take mode we were never entitled to rest)
//   neither fills  -> nothing happened (SCRATCH)
//
// Caps enforced through the ledger (active-USDC, pairs-per-window, per-series
// allocation) plus one in-flight attempt per series and a re-arm cooldown.

const core = require('../arb-core');

class Taker {
  constructor({ cfg, ledger, venue, observer, onPairUpdate, log }) {
    this.cfg = cfg;
    this.ledger = ledger;
    this.venue = venue;
    this.observer = observer;
    this.onPairUpdate = onPairUpdate;
    this.log = log || (() => {});
    this.inFlight = new Set();
    this.rearmAt = new Map();
    this.halted = false;
    this.attempts = 0;
    this.latencies = [];
  }

  halt(why) {
    this.halted = true;
    this.log(`TAKER HALTED: ${why}`);
  }

  onBookUpdate(series, books, nowMs = Date.now(), seriesCapUsdc = null) {
    if (this.halted || this.inFlight.has(series)) return;
    if ((this.rearmAt.get(series) || 0) > nowMs) return;

    const input = this.observer.snapshot(series, books, nowMs);
    if (!input) return;
    const r = core.evaluatePair(input, this.cfg.detector);
    if (!r.buy.ok) return;

    const mkt = this.observer.markets.get(series);
    const estUsdc = r.buy.clip * (input.askUp + input.askDown);
    if (!this.ledger.canOpen(series, mkt.slug, estUsdc, seriesCapUsdc).ok) return;

    this.inFlight.add(series);
    this._attempt(series, mkt, input, r.buy, books, nowMs, estUsdc)
      .catch((err) => this.log(`taker attempt error ${series}: ${err.message}`))
      .finally(() => {
        this.inFlight.delete(series);
        this.rearmAt.set(series, Date.now() + this.cfg.trader.rearmMs);
      });
  }

  async _attempt(series, mkt, input, buy, books, tDetect, estUsdc) {
    this.attempts++;
    const expectedFees = buy.clip * (
      core.takerFeePerShare(input.askUp, input.feeSchedule) +
      core.takerFeePerShare(input.askDown, input.feeSchedule));

    const pair = this.ledger.openPair({
      source: 'taker', series, window: mkt.slug, windowEndMs: mkt.windowEndMs,
      conditionId: mkt.conditionId, upToken: mkt.upToken, downToken: mkt.downToken,
      meta: { askUp: input.askUp, askDown: input.askDown, clip: buy.clip, feeAdjSum: buy.feeAdjSum, expectedFees: core.round6(expectedFees), tDetect },
      estUsdc,
    });
    this.log(`taker FIRE ${series} clip=${buy.clip} askUp=${input.askUp} askDown=${input.askDown} feeAdjSum=${buy.feeAdjSum} (pair ${pair.id}, ${this.venue.kind})`);

    const orderArgs = { size: buy.clip, feeRateBps: this.cfg.trader.feeRateBps, tickSize: mkt.tickSize };
    const tPost = Date.now();
    const [up, down] = await Promise.all([
      this.venue.buyFAK({ ...orderArgs, tokenId: mkt.upToken, price: input.askUp }),
      this.venue.buyFAK({ ...orderArgs, tokenId: mkt.downToken, price: input.askDown }),
    ]);
    const tAck = Date.now();
    const latencyMs = { detectToPost: tPost - tDetect, detectToLastAck: tAck - tDetect };
    this.latencies.push(latencyMs.detectToLastAck);
    if (this.latencies.length > 10_000) this.latencies.splice(0, 5_000);

    this.ledger.bookBuy(pair.id, 'up', { shares: up.filledShares, usdc: up.usdc, avgPrice: up.avgPrice, ackMs: up.ackMs, error: up.error });
    this.ledger.bookBuy(pair.id, 'down', { shares: down.filledShares, usdc: down.usdc, avgPrice: down.avgPrice, ackMs: down.ackMs, error: down.error });
    this.ledger.setLatency(pair.id, latencyMs);
    this.log(`taker pair ${pair.id} up ${up.filledShares}/${buy.clip} down ${down.filledShares}/${buy.clip}` +
      (up.error || down.error ? ` errors: up=${up.error || '-'} down=${down.error || '-'}` : ''));

    if (pair.qty.up !== pair.qty.down) {
      await this._unwind(pair, mkt, books, up, down);
    }
    this.ledger.settleIfFlat(pair.id); // SCRATCH when nothing filled
    if (this.onPairUpdate) this.onPairUpdate(pair);
  }

  /** Immediate sell-back of the excess leg at the bid. */
  async _unwind(pair, mkt, books, upFill, downFill) {
    for (let i = 0; i < this.cfg.trader.unwindRetries; i++) {
      const excessSide = pair.qty.up > pair.qty.down ? 'up' : 'down';
      const shares = Math.abs(pair.qty.up - pair.qty.down);
      if (shares === 0) return;
      const tokenId = excessSide === 'up' ? mkt.upToken : mkt.downToken;
      const book = books.get(tokenId);
      const bid = book ? book.bestBid() : null;
      if (bid === null) { await sleep(250); continue; }
      if (shares < (mkt.minOrderSize || 5)) {
        this.ledger.markStranded(pair.id, `excess ${shares} < exchange min ${mkt.minOrderSize}`);
        this.log(`taker pair ${pair.id} STRANDED: excess below min order size — rides to resolution`);
        return;
      }
      const res = await this.venue.sellFAK({
        tokenId, price: bid, size: shares,
        feeRateBps: this.cfg.trader.feeRateBps, tickSize: mkt.tickSize,
      });
      if (res.filledShares > 0) {
        const legFill = excessSide === 'up' ? upFill : downFill;
        const basis = legFill.avgPrice !== null ? res.filledShares * legFill.avgPrice : null;
        this.ledger.bookSell(pair.id, excessSide, { shares: res.filledShares, usdc: res.usdc, reason: 'unwind', basisUsdc: basis });
        this.log(`taker pair ${pair.id} unwound ${res.filledShares} ${excessSide} @ ~${res.avgPrice}`);
      } else {
        await sleep(250);
      }
    }
    if (pair.qty.up !== pair.qty.down) {
      this.ledger.markStranded(pair.id, 'unwind retries exhausted');
      this.log(`taker pair ${pair.id} STRANDED: unwind retries exhausted — rides to resolution`);
    }
  }

  latencyStats() {
    if (!this.latencies.length) return null;
    const s = [...this.latencies].sort((a, b) => a - b);
    const pick = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
    return { n: s.length, p50: pick(0.5), p95: pick(0.95), max: s[s.length - 1] };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { Taker };
