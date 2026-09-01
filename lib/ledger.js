'use strict';

// Pair-level ledger: every pair attempt is CREATED as a unit and every cash
// flow is booked against it (all four mm-bot accounting bugs were leg-level
// bookkeeping errors; pair-level state is the structural fix).
//
// Inventory model per pair: qty {up, down} shares held, cost (buys + splits),
// proceeds (sells + unwinds + merges + redeems). The full-flow P&L formula the
// V2 article warns most trackers get wrong:
//
//   PnL = sells + merges + redeems + unwinds − buys − splits − ctfCosts
//
// Split/merge cash flows are NOT trades and are booked as their own legs —
// otherwise the books show phantom profit.
//
// Sources: 'taker' (take-take buys), 'maker' (passive completion),
// 'sellside' (split -> sell rich pairs).
//
// Journal: data/arb-journal.json — append-only ndjson, one full snapshot per
// state change, seq-numbered (appendFile can land out of order).

const fs = require('node:fs');
const path = require('node:path');

const STATES = ['IN_FLIGHT', 'MATCHED', 'PARTIAL', 'MERGED', 'UNWOUND', 'SCRATCH', 'STRANDED', 'RESOLVED'];

function round6(x) { return Math.round(x * 1e6) / 1e6; }

function nextIdsFromJournal(journalPath) {
  let id = 0, seq = 0;
  if (journalPath && fs.existsSync(journalPath)) {
    for (const line of fs.readFileSync(journalPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.type === 'pair') {
          if (row.id > id) id = row.id;
          if ((row.seq || 0) > seq) seq = row.seq;
        }
      } catch {}
    }
  }
  return { id: id + 1, seq: seq + 1 };
}

class PairLedger {
  constructor({ maxActiveUsdc, maxPairsPerWindow, dataDir, mode = null }) {
    this.maxActiveUsdc = maxActiveUsdc;
    this.maxPairsPerWindow = maxPairsPerWindow;
    this.mode = mode; // 'dry' | 'live' — stamped on journal rows so reconcile can skip paper pairs
    this.journalPath = dataDir ? path.join(dataDir, 'arb-journal.json') : null;
    this.pairs = new Map();
    // The journal is append-only ACROSS runs and its readers dedupe by pair
    // id — restarting ids at 1 would let this run's pairs shadow last run's
    // (a stranded pair still holding tokens would vanish from reconcile).
    ({ id: this.nextId, seq: this.nextSeq } = nextIdsFromJournal(this.journalPath));
    this.windowCounts = new Map(); // `${series}:${window}` -> attempts
  }

  _journal(pair) {
    if (!this.journalPath) return;
    fs.appendFile(this.journalPath, JSON.stringify({ type: 'pair', t: Date.now(), seq: this.nextSeq++, ...pair }) + '\n', () => {});
  }

  _isTerminal(p) { return ['MERGED', 'UNWOUND', 'SCRATCH', 'RESOLVED'].includes(p.state); }

  committedUsdc(series = null) {
    let sum = 0;
    for (const p of this.pairs.values()) {
      if (this._isTerminal(p)) continue;
      if (series && p.series !== series) continue;
      sum += Math.max(0, p.cost - p.proceeds);
    }
    return round6(sum);
  }

  canOpen(series, window, estUsdc, seriesCapUsdc = null) {
    if ((this.windowCounts.get(`${series}:${window}`) || 0) >= this.maxPairsPerWindow) return { ok: false, why: 'pairs-per-window cap' };
    if (this.committedUsdc() + estUsdc > this.maxActiveUsdc) return { ok: false, why: 'active-USDC cap' };
    if (seriesCapUsdc !== null && this.committedUsdc(series) + estUsdc > seriesCapUsdc) return { ok: false, why: 'series allocation cap' };
    return { ok: true };
  }

  openPair({ source, series, window, windowEndMs, conditionId, upToken, downToken, meta, estUsdc = 0 }) {
    const key = `${series}:${window}`;
    this.windowCounts.set(key, (this.windowCounts.get(key) || 0) + 1);
    const pair = {
      id: this.nextId++,
      mode: this.mode,
      tOpen: Date.now(),
      source, series, window, windowEndMs, conditionId, upToken, downToken,
      state: 'IN_FLIGHT',
      detect: meta || {},
      estUsdc,             // reserved estimate until real flows land
      qty: { up: 0, down: 0 },
      cost: 0,             // buys + splits
      proceeds: 0,         // sells + unwinds + merges + redeems
      buysUsdc: 0, splitsUsdc: 0, sellsUsdc: 0, unwindUsdc: 0, mergesUsdc: 0, redeemUsdc: 0,
      ctfCostUsdc: 0, unwindLossUsdc: 0,
      fills: [],
      realizedPnl: null,
      latencyMs: null,
      resolution: null,
    };
    // Until fills arrive, the estimate is the committed capital.
    pair.cost = estUsdc;
    this.pairs.set(pair.id, pair);
    this._journal(pair);
    return pair;
  }

  _get(id) {
    const p = this.pairs.get(id);
    if (!p) throw new Error(`ledger: unknown pair ${id}`);
    return p;
  }

  /** First real flow replaces the reservation estimate. */
  _absorbEstimate(p) {
    if (p.estUsdc > 0) { p.cost -= p.estUsdc; p.estUsdc = 0; }
  }

  _refreshHoldingState(p) {
    if (this._isTerminal(p) || p.state === 'STRANDED') return;
    const { up, down } = p.qty;
    if (up === 0 && down === 0) return; // IN_FLIGHT until settleIfFlat/terminal op
    p.state = up === down ? 'MATCHED' : 'PARTIAL';
  }

  bookBuy(id, side, { shares, usdc, ackMs = null, avgPrice = null, error = null }) {
    const p = this._get(id);
    this._absorbEstimate(p);
    p.qty[side] = round6(p.qty[side] + shares); // keep qty exact at 6dp: state checks use ===
    p.cost += usdc;
    p.buysUsdc += usdc;
    p.fills.push({ op: 'buy', side, shares, usdc, avgPrice, ackMs, error, t: Date.now() });
    this._refreshHoldingState(p);
    this._journal(p);
    return p;
  }

  bookSplit(id, { shares, usdc, costUsdc = 0 }) {
    const p = this._get(id);
    this._absorbEstimate(p);
    p.qty.up = round6(p.qty.up + shares);
    p.qty.down = round6(p.qty.down + shares);
    p.cost += usdc;
    p.splitsUsdc += usdc;
    p.ctfCostUsdc += costUsdc;
    p.fills.push({ op: 'split', shares, usdc, t: Date.now() });
    this._refreshHoldingState(p);
    this._journal(p);
    return p;
  }

  /** reason: 'sell' (sell-side proceeds) | 'unwind' (excess cut). basisUsdc
   *  lets unwinds book their loss exactly against the leg's fill cost. */
  bookSell(id, side, { shares, usdc, reason = 'sell', basisUsdc = null }) {
    const p = this._get(id);
    if (p.qty[side] + 1e-9 < shares) throw new Error(`ledger: selling ${shares} ${side} but pair ${id} holds ${p.qty[side]}`);
    p.qty[side] = round6(p.qty[side] - shares);
    p.proceeds += usdc;
    if (reason === 'unwind') {
      p.unwindUsdc += usdc;
      if (basisUsdc !== null) p.unwindLossUsdc = round6(p.unwindLossUsdc + basisUsdc - usdc);
    } else {
      p.sellsUsdc += usdc;
    }
    p.fills.push({ op: reason, side, shares, usdc, t: Date.now() });
    this._refreshHoldingState(p);
    this._journal(p);
    return p;
  }

  bookMerge(id, { shares, usdc, costUsdc = 0 }) {
    const p = this._get(id);
    if (this._isTerminal(p)) {
      // Late merge on an already-settled pair: never double-book the cash.
      p.skippedMerges = (p.skippedMerges || 0) + 1;
      this._journal(p);
      return p;
    }
    const n = Math.min(shares, p.qty.up, p.qty.down);
    p.qty.up = round6(p.qty.up - n);
    p.qty.down = round6(p.qty.down - n);
    p.proceeds += usdc;
    p.mergesUsdc += usdc;
    p.ctfCostUsdc += costUsdc;
    p.fills.push({ op: 'merge', shares: n, usdc, t: Date.now() });
    this._maybeFinalize(p);
    this._refreshHoldingState(p);
    this._journal(p);
    return p;
  }

  /** Modules call this when their attempt's lifecycle is over; if the pair is
   *  flat it becomes terminal with realized P&L. */
  settleIfFlat(id) {
    const p = this._get(id);
    this._absorbEstimate(p);
    this._maybeFinalize(p, true);
    this._journal(p);
    return p;
  }

  _maybeFinalize(p, explicit = false) {
    if (this._isTerminal(p)) return;
    if (p.qty.up !== 0 || p.qty.down !== 0) return;
    if (!explicit && p.mergesUsdc === 0) return; // merges auto-finalize; sells wait for the module
    if (p.cost === 0 && p.proceeds === 0) p.state = 'SCRATCH';
    else if (p.mergesUsdc > 0) p.state = 'MERGED';
    else p.state = 'UNWOUND';
    p.realizedPnl = round6(p.proceeds - p.cost - p.ctfCostUsdc);
  }

  markStranded(id, why) {
    const p = this._get(id);
    p.state = 'STRANDED';
    p.strandedWhy = why;
    this._journal(p);
    return p;
  }

  setLatency(id, latencyMs) {
    const p = this._get(id);
    p.latencyMs = latencyMs;
    return p;
  }

  /** Terminal: window resolved. outcome 'Up'|'Down'|null. Winner shares pay $1;
   *  with an unknown outcome only balanced pairs (riskless $1/pair) are booked. */
  bookResolution(id, outcome) {
    const p = this._get(id);
    if (this._isTerminal(p)) return p;
    let redeem = 0;
    if (outcome === 'Up') redeem = p.qty.up;
    else if (outcome === 'Down') redeem = p.qty.down;
    else redeem = Math.min(p.qty.up, p.qty.down);
    p.redeemUsdc = round6(redeem);
    p.proceeds += redeem;
    p.qty = { up: 0, down: 0 };
    p.resolution = { outcome, t: Date.now() };
    p.state = 'RESOLVED';
    p.realizedPnl = round6(p.proceeds - p.cost - p.ctfCostUsdc);
    this._journal(p);
    return p;
  }

  /** Reservation GC: an attempt that crashed between openPair and its first
   *  booking leaves an IN_FLIGHT pair whose estimate is committed forever,
   *  silently eating the caps. Any real fill/split lands within seconds, so a
   *  reservation with zero flows after maxAgeMs is dead — release it. */
  expireStaleReservations(nowMs = Date.now(), maxAgeMs = 120_000) {
    const expired = [];
    for (const p of this.pairs.values()) {
      if (p.state !== 'IN_FLIGHT' || p.fills.length > 0) continue;
      if (nowMs - p.tOpen < maxAgeMs) continue;
      this._absorbEstimate(p);
      p.state = 'SCRATCH';
      p.realizedPnl = 0;
      p.expiredReservation = true;
      this._journal(p);
      expired.push(p);
    }
    return expired;
  }

  pendingResolutions(nowMs, graceMs = 90_000) {
    const out = [];
    for (const p of this.pairs.values()) {
      if (!this._isTerminal(p) && (p.qty.up > 0 || p.qty.down > 0) && nowMs >= p.windowEndMs + graceMs) out.push(p);
    }
    return out;
  }

  /** Realized P&L per series (drives the allocator). */
  realizedBySeries() {
    const out = {};
    for (const p of this.pairs.values()) {
      if (p.realizedPnl === null) continue;
      out[p.series] = round6((out[p.series] || 0) + p.realizedPnl);
    }
    return out;
  }

  stats() {
    const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
    const bySource = {};
    let realized = 0, terminal = 0;
    const d = { buys: 0, splits: 0, sells: 0, unwindProceeds: 0, merges: 0, redeems: 0, ctfCosts: 0, unwindLosses: 0, expectedFees: 0 };
    for (const p of this.pairs.values()) {
      counts[p.state]++;
      const s = (bySource[p.source] ||= { pairs: 0, realized: 0 });
      s.pairs++;
      d.expectedFees += p.detect.expectedFees || 0;
      if (p.realizedPnl !== null) { realized += p.realizedPnl; terminal++; s.realized = round6(s.realized + p.realizedPnl); }
      d.buys += p.buysUsdc; d.splits += p.splitsUsdc; d.sells += p.sellsUsdc;
      d.unwindProceeds += p.unwindUsdc; d.merges += p.mergesUsdc; d.redeems += p.redeemUsdc;
      d.ctfCosts += p.ctfCostUsdc; d.unwindLosses += p.unwindLossUsdc;
    }
    for (const k of Object.keys(d)) d[k] = round6(d[k]);
    return {
      pairs: this.pairs.size,
      counts,
      bySource,
      committedUsdc: this.committedUsdc(),
      realizedPnl: round6(realized),
      perPair: terminal ? round6(realized / terminal) : null,
      decomposition: d,
    };
  }
}

module.exports = { PairLedger, STATES, round6 };
