'use strict';

// Strategy — the whole thing as ONE strategy. Owns the shared ledger, venue
// and CTF, and coordinates the modules:
//
//   taker     take-take cheap pairs (buy both asks, merge to cash)
//   maker     passive bids on both legs + completion engine + leash
//   sellside  split $1 -> sell rich pairs, pre-split inventory, merge-back
//   allocator spreads the USDC cap across series by realized edge
//   skew      the directional dial — hard-pinned at 0.50 (pure arb) until a
//             verified calibration file exists
//   ctf       split/merge/redeem; matched pairs auto-merge to cash in batches
//             (in skew mode pairs are hedge inventory and are NOT auto-merged)
//
// Every module books through the same pair ledger; the strategy is the only
// writer of merges and resolutions, so no two modules can double-book a flow.

const { Taker } = require('./trader');
const { Maker } = require('./maker');
const { SellSide } = require('./sellside');
const { Allocator } = require('./allocator');
const { Skew } = require('./skew');
const { MergeBatcher } = require('./ctf');

class Strategy {
  constructor({ cfg, observer, venue, ledger, ctf, log = () => {} }) {
    this.cfg = cfg;
    this.observer = observer;
    this.venue = venue;
    this.ledger = ledger;
    this.ctf = ctf;
    this.log = log;
    this.modules = new Set(cfg.trader.modules);

    this.skew = new Skew({ kappa: cfg.trader.skew, maxLossUsdc: cfg.trader.maxLossUsdc, dataDir: cfg.dataDir, log });
    this.allocator = this.modules.has('allocator')
      ? new Allocator({
          maxActiveUsdc: cfg.detector.maxActiveUsdc,
          series: cfg.series,
          minAttemptUsdc: Math.ceil(cfg.detector.shares * 1.2), // one base clip must always fit
        })
      : null;

    this.batcher = new MergeBatcher(ctf, (m) => this._onMerged(m), log);
    const onPairUpdate = (pair) => this.onPairUpdate(pair);

    this.taker = this.modules.has('taker')
      ? new Taker({ cfg, ledger, venue, observer, onPairUpdate, log }) : null;
    this.maker = this.modules.has('maker')
      ? new Maker({ cfg, ledger, venue, observer, skew: this.skew, onPairUpdate, log }) : null;
    this.sellside = this.modules.has('sellside')
      ? new SellSide({
          cfg, ledger, venue, observer, ctf, onPairUpdate, log,
          // Self-trade oracle: our own maker bid resting at a token's best bid
          // (checked against maker STATE, so it works in live mode too).
          ownBidAtBest: (tokenId) => this._ownBidAtBest(tokenId),
        }) : null;

    this.lastMergeFlush = 0;
    this.halted = false;
  }

  halt(why) {
    this.halted = true;
    if (this.taker) this.taker.halt(why);
    this.log(`STRATEGY HALTED: ${why}`);
  }

  _seriesCap(series) {
    return this.allocator ? this.allocator.capFor(series) : null;
  }

  _ownBidAtBest(tokenId) {
    if (!this.maker) return false;
    for (const st of this.maker.state.values()) {
      for (const side of ['up', 'down']) {
        const q = st.quotes[side];
        if (!q || q.tokenId !== tokenId) continue;
        const book = this.books ? this.books.get(tokenId) : null;
        if (book && book.bestBid() === q.price) return true;
        if (!book) return true; // no book to check against — err on caution
      }
    }
    return false;
  }

  /** Single funnel into the allocator: a pair's realized P&L is recorded once. */
  _recordAlloc(pair) {
    if (!this.allocator || pair.realizedPnl === null || pair.allocRecorded) return;
    pair.allocRecorded = true;
    this.allocator.record(pair.series, pair.realizedPnl);
  }

  async onBookUpdate(series, books, nowMs = Date.now()) {
    if (this.halted) return;
    this.books = books; // kept for the self-trade oracle
    const cap = this._seriesCap(series);
    if (this.taker) this.taker.onBookUpdate(series, books, nowMs, cap);
    if (this.maker) {
      // paper resting fills are discovered on book movement; live fills arrive
      // via the user websocket and are routed to onFill directly
      const mkt = this.observer.markets.get(series);
      if (mkt && this.venue.checkResting) {
        for (const tok of [mkt.upToken, mkt.downToken]) {
          for (const fill of this.venue.checkResting(tok)) {
            await this.maker.onFill(fill, books, nowMs);
          }
        }
      }
      await this.maker.onBookUpdate(series, books, nowMs, cap);
    }
    if (this.sellside) await this.sellside.onBookUpdate(series, books, nowMs, cap);
  }

  /** Live-mode user-ws fills route here. */
  async onUserFill(fill, books) {
    if (this.maker) await this.maker.onFill(fill, books);
  }

  /** A module finished (or advanced) a pair attempt. */
  onPairUpdate(pair) {
    this._recordAlloc(pair);
    // Auto-merge matched pairs to cash — the pure-arb rule. Sell-side pairs
    // are working inventory (they exist to be SOLD); skew mode holds pairs as
    // the hedge and merges only as a tool.
    if (pair.state === 'MATCHED' && pair.source !== 'sellside' && this.skew.autoMerge) {
      const n = Math.min(pair.qty.up, pair.qty.down);
      if (n > 0) {
        this.batcher.add(pair.conditionId, pair.id, n);
        this.log(`queued merge: pair ${pair.id} ${n} shares (batch now ${this.batcher.pending})`);
      }
    }
  }

  _onMerged({ pairId, shares, usdc, costShare }) {
    const pair = this.ledger.bookMerge(pairId, { shares, usdc, costUsdc: costShare });
    this._recordAlloc(pair);
  }

  /** Discovery rolled a series to a new window. */
  async onWindowRoll(series, books) {
    if (this.maker) await this.maker.onWindowRoll(series, books);
    if (this.sellside) await this.sellside.onWindowRoll(series, this.batcher);
    await this.batcher.flush(); // window boundary is the natural batch point
  }

  async onWindowStart(series, mkt) {
    if (this.sellside) await this.sellside.onWindowStart(series, mkt);
  }

  /** 1s housekeeping: leashes, periodic merge flush. */
  async tick(books, nowMs = Date.now()) {
    if (this.halted) return;
    if (this.maker) {
      for (const series of this.observer.markets.keys()) {
        await this.maker._driveAttempt(series, books, nowMs);
      }
    }
    if (this.batcher.pending > 0 && nowMs - this.lastMergeFlush > this.cfg.trader.mergeFlushSec * 1000) {
      this.lastMergeFlush = nowMs;
      await this.batcher.flush();
    }
    for (const p of this.ledger.expireStaleReservations(nowMs)) {
      this.log(`released stale reservation: pair ${p.id} (${p.series}) — attempt died before any booking`);
    }
  }

  /** Book outcomes for pairs holding inventory past window end. A balanced
   *  pair pays $1 regardless, so UNKNOWN is bookable after ~10 min; an
   *  IMBALANCED pair has money riding on the outcome and waits (loudly). */
  async drainResolutions(fetchOutcome, nowMs = Date.now()) {
    for (const p of this.ledger.pendingResolutions(nowMs)) {
      const startSec = Number(p.window.split('-').pop());
      let outcome = null;
      try { outcome = await fetchOutcome(p.series, startSec); } catch {}
      if (outcome === null) {
        p.outcomeAttempts = (p.outcomeAttempts || 0) + 1;
        const outcomeMatters = p.qty.up !== p.qty.down;
        if (outcomeMatters) {
          if (p.outcomeAttempts % 20 === 0) {
            this.log(`pair ${p.id} still unresolved after ${p.outcomeAttempts} lookups — imbalanced inventory rides on it`);
          }
          continue;
        }
        if (p.outcomeAttempts < 40) continue;
      }
      const done = this.ledger.bookResolution(p.id, outcome);
      this.log(`pair ${p.id} RESOLVED ${outcome ?? 'UNKNOWN'} pnl=${done.realizedPnl}`);
      this._recordAlloc(done);
      // Redeem whenever value was booked — redeemPositions claims whatever the
      // oracle reported, so it works even when WE don't know the outcome.
      // Booking cash without attempting the claim leaves phantom proceeds.
      if (this.ctf.kind === 'live' && done.redeemUsdc > 0) {
        const res = await this.ctf.redeem(p.conditionId);
        if (!res.ok) this.log(`redeem failed for pair ${p.id}: ${res.error} — claim manually / via reconcile`);
      }
    }
  }

  /** Clean stop: cancel every resting quote, flush pending merges. Positions
   *  are NOT force-closed — matched pairs are riskless and resolve to $1. */
  async shutdown(books) {
    if (this.maker) {
      for (const series of this.maker.state.keys()) {
        await this.maker._cancelQuotes(series);
      }
    }
    await this.batcher.flush();
  }

  stats() {
    return {
      modules: [...this.modules],
      halted: this.halted,
      skew: { kappa: this.skew.kappa, active: this.skew.active, autoMerge: this.skew.autoMerge },
      ctf: { kind: this.ctf.kind, disabled: this.ctf.disabledWhy || null, pendingMerges: this.batcher.pending },
      taker: this.taker ? { attempts: this.taker.attempts, latency: this.taker.latencyStats() } : null,
      maker: this.maker ? { quotes: this.maker.quoteCount() } : null,
      sellside: this.sellside ? { splitLatency: this.sellside.splitLatencyStats() } : null,
      allocator: this.allocator ? this.allocator.snapshot() : null,
      ledger: this.ledger.stats(),
    };
  }
}

module.exports = { Strategy };
