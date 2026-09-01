'use strict';

// Maker module — passive buy-side quoting with a completion engine.
//
// Rest bids on BOTH legs priced so the pair sum clears ARB_POST_SUM; earn the
// spread instead of paying it (maker fills pay ZERO fees under takerOnly).
// The one-legged problem is attacked directly, not time-boxed:
//
//   on any leg fill: immediately check whether TAKING the other side's ask
//   still completes the pair under ARB_COMPLETE_MAX_SUM. If yes, FAK it — a
//   completed arb beats waiting. If no, start a short leash (ARB_LEASH_SEC),
//   keep re-checking on every book tick, then sell the lone leg back.
//
// Lean-aware legging control: sizing is never skewed by side (a deliberate
// one-sided buy is a directional bet) unless the skew module is ACTIVE with a
// calibrated model. But STRANDING risk is skewed on purpose: as the market
// polarizes, the losing-side bid is widened first and pulled beyond a limit —
// if an accident happens, it strands us on the probable winner, which the
// completion engine can usually still finish into a full pair.

const core = require('../arb-core');

const LEAN_WIDEN_MID = 0.65;  // |mid-0.5| beyond this widens the losing-side bid
const LEAN_PULL_MID = 0.80;   // beyond this the losing-side bid is pulled entirely

class Maker {
  constructor({ cfg, ledger, venue, observer, skew, onPairUpdate, log = () => {} }) {
    this.cfg = cfg;
    this.ledger = ledger;
    this.venue = venue;
    this.observer = observer;
    this.skew = skew;
    this.onPairUpdate = onPairUpdate;
    this.log = log;
    this.state = new Map(); // series -> {quotes:{up,down}, attempt, lastQuoteMs}
    // orderId -> {series, side, price, mkt}. Fills are routed by ORDER id, not
    // by current quote: a re-quote cancels the old order, but that order may
    // have just filled — the fill still arrives and MUST be booked (live
    // cancel/fill race). Entries also pin the market they were quoted
    // against, so a fill or cut after a window roll never touches the new
    // window's tokens.
    this.orderIndex = new Map();
    // In live mode the strategy flips this with user-ws connectivity: resting
    // quotes without a fill feed are unmanaged risk, so no feed -> no quotes.
    this.enabled = true;
  }

  _s(series) {
    if (!this.state.has(series)) this.state.set(series, { quotes: { up: null, down: null }, attempt: null, lastQuoteMs: 0 });
    return this.state.get(series);
  }

  /** Desired bid prices for both legs under the post-sum constraint. */
  desiredQuotes(input, mkt) {
    const tick = mkt.tickSize || 0.01;
    const rt = (x) => roundTick(x, tick);
    const postSum = this.cfg.trader.postSum;
    if (input.bidUp == null || input.bidDown == null) return null;
    let qUp = input.bidUp;      // join the best bid, never improve through it
    let qDown = input.bidDown;
    // Enforce the sum constraint by backing off the richer leg tick by tick.
    let guard = 200;
    while (qUp + qDown > postSum + 1e-9 && guard-- > 0) {
      if (qUp >= qDown) qUp = rt(qUp - tick); else qDown = rt(qDown - tick);
    }
    // Lean-aware widening/pulling of the LOSING side's bid.
    const mid = (input.bidUp + (input.askUp ?? input.bidUp)) / 2;
    if (mid >= LEAN_PULL_MID) qDown = null;
    else if (mid >= LEAN_WIDEN_MID) qDown = qDown === null ? null : rt(qDown - 2 * tick);
    if (mid <= 1 - LEAN_PULL_MID) qUp = null;
    else if (mid <= 1 - LEAN_WIDEN_MID) qUp = qUp === null ? null : rt(qUp - 2 * tick);
    if (qUp !== null && qUp < tick) qUp = null;
    if (qDown !== null && qDown < tick) qDown = null;
    return { qUp, qDown };
  }

  legSizes(mid, minOrderSize = 5) {
    const base = this.cfg.detector.shares;
    if (!this.skew || !this.skew.active) return { up: base, down: base };
    // Clamp both legs to the exchange minimum: a sub-minimum hedge leg would
    // be rejected live while paper accepts it (dry/live divergence), and an
    // unfillable hedge is exactly the naked exposure the skew cap forbids.
    const { dominant, hedge } = this.skew.legSizes(base * 2);
    const d = Math.max(dominant, minOrderSize);
    const h = Math.max(hedge, minOrderSize);
    return mid >= 0.5 ? { up: d, down: h } : { up: h, down: d };
  }

  /** USDC that would be spent if every resting bid filled at once. Quotes are
   *  not ledger reservations, so this is checked against the cap explicitly —
   *  otherwise 10 series × 2 bids can commit several× the cap simultaneously. */
  restingExposureUsdc() {
    let sum = 0;
    for (const st of this.state.values()) {
      for (const side of ['up', 'down']) {
        const q = st.quotes[side];
        if (q) sum += q.price * q.size;
      }
    }
    return sum;
  }

  async onBookUpdate(series, books, nowMs, seriesCapUsdc) {
    const st = this._s(series);
    if (!this.enabled) { if (!st.attempt) await this._cancelQuotes(series); return; }
    if (st.attempt) return this._driveAttempt(series, books, nowMs);
    if (st.quoting) return; // a postGTC slower than requoteMs must not interleave (zombie orders)
    if ((st.cooldownUntil || 0) > nowMs) return; // quiet period after a losing cut
    if (nowMs - st.lastQuoteMs < this.cfg.trader.requoteMs) return;
    const input = this.observer.snapshot(series, books, nowMs);
    if (!input) return;
    const mkt = this.observer.markets.get(series);
    const tauSec = (input.windowEndMs - nowMs) / 1000;

    st.quoting = true;
    try {
      // No quoting near the close or without capacity for a full pair.
      if (tauSec < this.cfg.detector.minTauSec + this.cfg.trader.leashSec) return await this._cancelQuotes(series);
      const est = this.cfg.detector.shares * this.cfg.trader.postSum;
      if (!this.ledger.canOpen(series, mkt.slug, est, seriesCapUsdc).ok) return await this._cancelQuotes(series);
      // Fill-everything worst case must fit under the cap alongside booked pairs.
      const myResting = ['up', 'down'].reduce((a, s) => a + (st.quotes[s] ? st.quotes[s].price * st.quotes[s].size : 0), 0);
      if (this.ledger.committedUsdc() + this.restingExposureUsdc() - myResting + est > this.cfg.detector.maxActiveUsdc) {
        return await this._cancelQuotes(series);
      }

      const want = this.desiredQuotes(input, mkt);
      if (!want) return;

      // A LONE bid (other side pulled by the lean rule) has no both-bids-fill
      // path to a pair — its only completion route is taking the other side's
      // ask. If that is already impossible (quote + otherAsk > completeMaxSum),
      // the quote is a naked directional punt that only fills on adverse flow:
      // don't post it at all.
      if (want.qUp !== null && want.qDown === null) {
        if (input.askDown == null || want.qUp + input.askDown > this.cfg.trader.completeMaxSum + 1e-9) want.qUp = null;
      } else if (want.qDown !== null && want.qUp === null) {
        if (input.askUp == null || want.qDown + input.askUp > this.cfg.trader.completeMaxSum + 1e-9) want.qDown = null;
      }
      if (want.qUp === null && want.qDown === null) return this._cancelQuotes(series);

      const mid = (input.bidUp + (input.askUp ?? input.bidUp)) / 2;
      const sizes = this.legSizes(mid, mkt.minOrderSize || 5);
      st.lastQuoteMs = nowMs;
      await this._syncQuote(series, mkt, 'up', want.qUp, sizes.up);
      await this._syncQuote(series, mkt, 'down', want.qDown, sizes.down);
    } finally {
      st.quoting = false;
    }
  }

  async _syncQuote(series, mkt, side, price, size) {
    const st = this._s(series);
    const cur = st.quotes[side];
    const tokenId = side === 'up' ? mkt.upToken : mkt.downToken;
    if (price === null) {
      if (cur) {
        await this.venue.cancel(cur.orderId);
        st.quotes[side] = null;
        if (this.cfg.verbose) this.log(`maker pulled ${series} ${side} bid`);
      }
      return;
    }
    if (cur && Math.abs(cur.price - price) < 1e-9 && cur.size === size) return;
    if (cur) { await this.venue.cancel(cur.orderId); st.quotes[side] = null; }
    const res = await this.venue.postGTC({
      tokenId, side: 'BUY', price, size,
      feeRateBps: this.cfg.trader.feeRateBps, tickSize: mkt.tickSize,
    });
    if (res.ok) {
      if (this.cfg.verbose) this.log(`maker quote ${series} ${side} ${size}@${price}${cur ? ' (requote)' : ''}`);
      st.quotes[side] = { orderId: res.orderId, price, size, tokenId };
      this.orderIndex.set(res.orderId, { series, side, price, mkt });
      if (this.orderIndex.size > 10_000) {
        for (const k of [...this.orderIndex.keys()].slice(0, 5_000)) this.orderIndex.delete(k);
      }
    }
  }

  async _cancelQuotes(series) {
    const st = this._s(series);
    for (const side of ['up', 'down']) {
      if (st.quotes[side]) { await this.venue.cancel(st.quotes[side].orderId); st.quotes[side] = null; }
    }
  }

  /** A resting bid filled (paper simulation or live user-ws push). Routed by
   *  ORDER id so fills for just-cancelled/replaced orders still book. */
  async onFill(fill, books, nowMs = Date.now()) {
    const ref = this.orderIndex.get(fill.orderId);
    if (!ref) return false;
    const st = this._s(ref.series);
    const quote = st.quotes[ref.side];
    if (quote && quote.orderId === fill.orderId && fill.shares >= quote.size) st.quotes[ref.side] = null;

    const mkt = ref.mkt; // pinned at post time — NOT the current window's market
    if (!st.attempt) {
      const pair = this.ledger.openPair({
        source: 'maker', series: ref.series, window: mkt.slug, windowEndMs: mkt.windowEndMs,
        conditionId: mkt.conditionId, upToken: mkt.upToken, downToken: mkt.downToken,
        meta: { postPrice: fill.price, side: ref.side, tDetect: nowMs, expectedFees: 0 }, // maker legs are fee-free
      });
      st.attempt = { pairId: pair.id, mkt, leashUntil: nowMs + this.cfg.trader.leashSec * 1000, filledSide: ref.side, fillPrice: fill.price };
      this.log(`maker fill ${ref.series} ${ref.side} ${fill.shares}@${fill.price} -> completion engine (pair ${pair.id})`);
    } else if (st.attempt.mkt.slug !== mkt.slug) {
      // A stale fill from a PREVIOUS window while an attempt runs in the new
      // one: book it on its own pair so the ledger reflects reality, and let
      // resolution settle it (its window is already over).
      const pair = this.ledger.openPair({
        source: 'maker', series: ref.series, window: mkt.slug, windowEndMs: mkt.windowEndMs,
        conditionId: mkt.conditionId, upToken: mkt.upToken, downToken: mkt.downToken,
        meta: { postPrice: fill.price, side: ref.side, tDetect: nowMs, expectedFees: 0, staleWindowFill: true },
      });
      this.ledger.bookBuy(pair.id, ref.side, { shares: fill.shares, usdc: fill.usdc, avgPrice: fill.price });
      this.log(`maker STALE-WINDOW fill booked on its own pair ${pair.id} (${mkt.slug})`);
      return true;
    }
    this.ledger.bookBuy(st.attempt.pairId, ref.side, { shares: fill.shares, usdc: fill.usdc, avgPrice: fill.price });
    await this._driveAttempt(ref.series, books, nowMs);
    return true;
  }

  /** Completion-or-leash state machine, re-run on every tick/book update.
   *  Uses the attempt's PINNED market — after a window roll the current
   *  market has different tokens and must never be touched by this attempt.
   *  Re-entrancy guarded: a tick and a book update racing into the same
   *  attempt would double-fire the completion-take. */
  async _driveAttempt(series, books, nowMs) {
    const st = this._s(series);
    if (!st.attempt || st.attempt.driving) return;
    st.attempt.driving = true;
    try {
      await this._driveAttemptInner(series, books, nowMs);
    } finally {
      if (st.attempt) st.attempt.driving = false;
    }
  }

  async _driveAttemptInner(series, books, nowMs) {
    const st = this._s(series);
    if (!st.attempt) return;
    const pair = this.ledger.pairs.get(st.attempt.pairId);
    const mkt = st.attempt.mkt;
    if (!pair || !mkt) { st.attempt = null; return; }

    // Balanced -> attempt complete (strategy decides merge vs hold).
    if (pair.qty.up === pair.qty.down && pair.qty.up > 0) {
      await this._finishAttempt(series, pair);
      return;
    }

    const excessSide = pair.qty.up > pair.qty.down ? 'up' : 'down';
    const needSide = excessSide === 'up' ? 'down' : 'up';
    const needShares = Math.abs(pair.qty.up - pair.qty.down);
    const needToken = needSide === 'up' ? mkt.upToken : mkt.downToken;
    const book = books.get(needToken);
    const ask = book ? book.bestAsk() : null;

    // Completion-take: a completed arb beats waiting. Below the exchange
    // minimum the order would be rejected live (paper would happily fill it),
    // so leave sub-minimum imbalances to the leash / further resting fills.
    if (ask !== null && needShares >= (mkt.minOrderSize || 5)
        && st.attempt.fillPrice + ask <= this.cfg.trader.completeMaxSum + 1e-9) {
      const res = await this.venue.buyFAK({
        tokenId: needToken, price: ask, size: needShares,
        feeRateBps: this.cfg.trader.feeRateBps, tickSize: mkt.tickSize,
      });
      if (res.filledShares > 0) {
        this.ledger.bookBuy(pair.id, needSide, { shares: res.filledShares, usdc: res.usdc, avgPrice: res.avgPrice, ackMs: res.ackMs });
        this.log(`maker completion-take ${series}: ${res.filledShares} ${needSide} @ ${res.avgPrice}`);
      }
      if (pair.qty.up === pair.qty.down) { await this._finishAttempt(series, pair); return; }
    }

    // Leash expired -> sell the lone leg back at the bid.
    if (nowMs >= st.attempt.leashUntil) {
      const cutSide = excessSide;
      const cutToken = cutSide === 'up' ? mkt.upToken : mkt.downToken;
      const cutBook = books.get(cutToken);
      const bid = cutBook ? cutBook.bestBid() : null;
      const shares = Math.abs(pair.qty.up - pair.qty.down);
      if (bid !== null && shares >= (mkt.minOrderSize || 5)) {
        const res = await this.venue.sellFAK({
          tokenId: cutToken, price: bid, size: shares,
          feeRateBps: this.cfg.trader.feeRateBps, tickSize: mkt.tickSize,
        });
        if (res.filledShares > 0) {
          // Basis = the excess side's true average fill cost (there may have
          // been several fills at different prices), not the first fill's.
          const legBuys = pair.fills.filter((f) => f.op === 'buy' && f.side === cutSide);
          const legShares = legBuys.reduce((a, f) => a + f.shares, 0);
          const legUsdc = legBuys.reduce((a, f) => a + f.usdc, 0);
          const avg = legShares > 0 ? legUsdc / legShares : st.attempt.fillPrice;
          this.ledger.bookSell(pair.id, cutSide, {
            shares: res.filledShares, usdc: res.usdc, reason: 'unwind',
            basisUsdc: res.filledShares * avg,
          });
        }
      }
      if (pair.qty.up === 0 && pair.qty.down === 0) {
        this.ledger.settleIfFlat(pair.id);
        this.log(`maker leash cut ${series}: pair ${pair.id} ${pair.state} pnl=${pair.realizedPnl}`);
        await this._endAttempt(series, pair);
      } else if (nowMs >= st.attempt.leashUntil + 30_000) {
        // couldn't cut (no bid / below min size): stop trying, ride to resolution
        this.ledger.markStranded(pair.id, 'maker leash cut failed');
        await this._endAttempt(series, pair);
      }
    }
  }

  async _finishAttempt(series, pair) {
    this.log(`maker completed pair ${pair.id} (${series}): ${pair.qty.up} matched`);
    await this._endAttempt(series, pair);
  }

  async _endAttempt(series, pair) {
    const st = this._s(series);
    st.attempt = null;
    await this._cancelQuotes(series);
    // A losing cut means the flow was adverse — in a trending market instant
    // re-quoting catches the same falling knife every leash cycle. Cool off.
    if (pair.realizedPnl !== null && pair.realizedPnl < 0) {
      st.cooldownUntil = Date.now() + this.cfg.trader.makerCooldownSec * 1000;
      this.log(`maker cooldown ${series}: ${this.cfg.trader.makerCooldownSec}s after losing cut (pnl ${pair.realizedPnl})`);
    }
    if (this.onPairUpdate) this.onPairUpdate(pair);
  }

  /** Window rollover / shutdown: cancel quotes, expire leashes immediately. */
  async onWindowRoll(series, books, nowMs = Date.now()) {
    const st = this._s(series);
    await this._cancelQuotes(series);
    if (st.attempt) {
      st.attempt.leashUntil = 0; // force the cut on the next drive
      await this._driveAttempt(series, books, nowMs);
    }
  }

  quoteCount() {
    let n = 0;
    for (const st of this.state.values()) n += (st.quotes.up ? 1 : 0) + (st.quotes.down ? 1 : 0);
    return n;
  }
}

/** Round to the market's tick grid (0.01 or 0.001) without float dust. */
function roundTick(x, tick) {
  const dp = Math.max(0, Math.round(-Math.log10(tick)));
  return Number(x.toFixed(dp));
}

module.exports = { Maker };
