'use strict';

// Phase 1 take-take BUY-side executor (plan §5 Phase 1).
//
// On every book update: if the fee-adjusted ask sum clears the trigger with
// depth, freshness, tau and clip all green, fire TWO concurrent FAK buys.
// Outcomes:
//   both fill      -> hold to resolution (v1; merge-on-fill arrives with 4b)
//   one / partial  -> IMMEDIATE sell-back of the excess at the bid (no leash,
//                     no 50s wait — in take mode we were never entitled to rest)
//   neither fills  -> nothing happened (SCRATCH)
//
// Caps enforced through the ledger: ARB_MAX_ACTIVE_USDC, pairs-per-window,
// plus one in-flight attempt per series and a short re-arm cooldown.

const core = require('../arb-core');

class Trader {
  constructor({ cfg, ledger, venue, observer, log }) {
    this.cfg = cfg;
    this.ledger = ledger;
    this.venue = venue;
    this.observer = observer; // reused for snapshot() + markets map
    this.log = log || (() => {});
    this.inFlight = new Set();   // series currently racing
    this.rearmAt = new Map();    // series -> earliest next attempt (ms)
    this.halted = false;
    this.attempts = 0;
    this.latencies = [];         // detect->last-ack ms, for the 4a histogram
  }

  halt(why) {
    this.halted = true;
    this.log(`TRADER HALTED: ${why}`);
  }

  onBookUpdate(series, books, nowMs = Date.now()) {
    if (this.halted || this.inFlight.has(series)) return;
    if ((this.rearmAt.get(series) || 0) > nowMs) return;

    const input = this.observer.snapshot(series, books, nowMs);
    if (!input) return;
    const r = core.evaluatePair(input, this.cfg.detector);
    if (!r.buy.ok) return;

    const mkt = this.observer.markets.get(series);
    const estUsdc = r.buy.clip * (input.askUp + input.askDown);
    const gate = this.ledger.canOpen(series, mkt.slug, estUsdc);
    if (!gate.ok) return;

    this.inFlight.add(series);
    this._attempt(series, mkt, input, r.buy, books, nowMs)
      .catch((err) => this.log(`attempt error ${series}: ${err.message}`))
      .finally(() => {
        this.inFlight.delete(series);
        this.rearmAt.set(series, Date.now() + this.cfg.trader.rearmMs);
      });
  }

  async _attempt(series, mkt, input, buy, books, tDetect) {
    this.attempts++;
    const expectedFees = buy.clip * (
      core.takerFeePerShare(input.askUp, input.feeSchedule) +
      core.takerFeePerShare(input.askDown, input.feeSchedule));

    const pair = this.ledger.openPair({
      series, window: mkt.slug, windowEndMs: mkt.windowEndMs,
      upToken: mkt.upToken, downToken: mkt.downToken,
      askUp: input.askUp, askDown: input.askDown,
      clip: buy.clip, expectedFees: core.round6(expectedFees), tDetect,
    });
    this.log(`FIRE ${series} clip=${buy.clip} askUp=${input.askUp} askDown=${input.askDown} feeAdjSum=${buy.feeAdjSum} (pair ${pair.id}, ${this.venue.kind})`);

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

    const booked = this.ledger.bookLegs(pair.id, up, down, latencyMs);
    this.log(`pair ${pair.id} ${booked.state}: up ${up.filledShares}/${buy.clip} down ${down.filledShares}/${buy.clip}` +
      (up.error || down.error ? ` errors: up=${up.error || '-'} down=${down.error || '-'}` : ''));

    if (booked.state === 'PARTIAL') await this._unwind(booked, mkt, books);
  }

  /** Immediate sell-back of the excess leg at the bid. */
  async _unwind(pair, mkt, books) {
    for (let i = 0; i < this.cfg.trader.unwindRetries && pair.excess; i++) {
      const book = books.get(pair.excess.tokenId);
      const bid = book ? book.bestBid() : null;
      if (bid == null) { await sleep(250); continue; }
      if (pair.excess.shares < mkt.minOrderSize) {
        this.ledger.markStranded(pair.id, `excess ${pair.excess.shares} < exchange min ${mkt.minOrderSize}`);
        this.log(`pair ${pair.id} STRANDED: excess below min order size — rides to resolution`);
        return;
      }
      const res = await this.venue.sellFAK({
        tokenId: pair.excess.tokenId, price: bid, size: pair.excess.shares,
        feeRateBps: this.cfg.trader.feeRateBps, tickSize: mkt.tickSize,
      });
      if (res.filledShares > 0) {
        this.ledger.bookUnwind(pair.id, { shares: res.filledShares, usdc: res.usdc });
        this.log(`pair ${pair.id} unwound ${res.filledShares} @ ~${res.avgPrice}`);
      } else {
        await sleep(250);
      }
    }
    if (pair.excess) {
      this.ledger.markStranded(pair.id, 'unwind retries exhausted');
      this.log(`pair ${pair.id} STRANDED: unwind retries exhausted — rides to resolution`);
    }
  }

  /** Called periodically with an outcome fetcher; books resolutions.
   *  Gamma can take minutes to finalize outcomePrices to 1/0, so we retry:
   *  a fully MATCHED pair pays $1/share regardless of outcome and may book
   *  UNKNOWN after ~10 min; a pair with an excess leg has money riding on the
   *  outcome and retries indefinitely (loudly). */
  async drainResolutions(fetchOutcome, nowMs = Date.now()) {
    for (const p of this.ledger.pendingResolutions(nowMs)) {
      const startSec = Number(p.window.split('-').pop());
      let outcome = null;
      try { outcome = await fetchOutcome(p.series, startSec); } catch {}
      if (outcome === null) {
        p.outcomeAttempts = (p.outcomeAttempts || 0) + 1;
        const outcomeMatters = !!p.excess;
        if (outcomeMatters) {
          if (p.outcomeAttempts % 20 === 0) {
            this.log(`pair ${p.id} still unresolved after ${p.outcomeAttempts} lookups — excess ${p.excess.shares} ${p.excess.sideName} rides on it`);
          }
          continue; // never book UNKNOWN when excess P&L depends on the outcome
        }
        if (p.outcomeAttempts < 40) continue;
      }
      const done = this.ledger.bookResolution(p.id, outcome);
      this.log(`pair ${p.id} RESOLVED ${outcome ?? 'UNKNOWN'} pnl=${done.realizedPnl}`);
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

module.exports = { Trader };
