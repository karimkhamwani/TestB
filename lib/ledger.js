'use strict';

// Pair-level ledger (plan §4): every pair is CREATED as a unit and every leg's
// fill/cut/settle is booked against it. All four mm-bot accounting bugs were
// leg-level bookkeeping errors; pair-level state is the structural fix.
//
// Phase 1 v1: no split/merge legs yet (that's work item 4b). P&L here is
//   PnL = sells(unwinds) + redeems - buys
// per pair, realized only at a terminal state. Fees are booked as EXPECTED
// (from the fee curve) until the real-fill fee verification lands.
//
// Journal: data/arb-journal.json — append-only ndjson, one row per pair state
// change (full snapshot; last row per id wins).

const fs = require('node:fs');
const path = require('node:path');

const STATES = ['IN_FLIGHT', 'MATCHED', 'PARTIAL', 'UNWOUND', 'SCRATCH', 'STRANDED', 'RESOLVED'];

class PairLedger {
  constructor({ maxActiveUsdc, maxPairsPerWindow, dataDir }) {
    this.maxActiveUsdc = maxActiveUsdc;
    this.maxPairsPerWindow = maxPairsPerWindow;
    this.journalPath = dataDir ? path.join(dataDir, 'arb-journal.json') : null;
    this.pairs = new Map();       // id -> pair
    this.nextId = 1;
    this.nextSeq = 1;             // journal write order (appendFile is async and can land out of order)
    this.windowCounts = new Map(); // `${series}:${window}` -> attempts
  }

  _journal(pair) {
    if (!this.journalPath) return;
    fs.appendFile(this.journalPath, JSON.stringify({ type: 'pair', t: Date.now(), seq: this.nextSeq++, ...pair }) + '\n', () => {});
  }

  /** USDC committed to non-terminal pairs (cap enforcement). */
  committedUsdc() {
    let sum = 0;
    for (const p of this.pairs.values()) {
      if (!['SCRATCH', 'UNWOUND', 'RESOLVED'].includes(p.state)) sum += p.committedUsdc;
    }
    return Math.round(sum * 1e6) / 1e6;
  }

  canOpen(series, window, estUsdc) {
    if ((this.windowCounts.get(`${series}:${window}`) || 0) >= this.maxPairsPerWindow) return { ok: false, why: 'pairs-per-window cap' };
    if (this.committedUsdc() + estUsdc > this.maxActiveUsdc) return { ok: false, why: 'active-USDC cap' };
    return { ok: true };
  }

  openPair({ series, window, windowEndMs, upToken, downToken, askUp, askDown, clip, expectedFees, tDetect }) {
    const key = `${series}:${window}`;
    this.windowCounts.set(key, (this.windowCounts.get(key) || 0) + 1);
    const pair = {
      id: this.nextId++,
      series, window, windowEndMs, upToken, downToken,
      state: 'IN_FLIGHT',
      detect: { askUp, askDown, clip, expectedFees, tDetect },
      legs: null,
      unwinds: [],
      committedUsdc: askUp !== null && askDown !== null ? clip * (askUp + askDown) : 0,
      matchedShares: 0,
      excess: null,          // {tokenId, sideName, shares, costUsdc}
      buysUsdc: 0,
      unwindUsdc: 0,
      redeemUsdc: 0,
      realizedPnl: null,
      latencyMs: null,
      resolution: null,
    };
    this.pairs.set(pair.id, pair);
    this._journal(pair);
    return pair;
  }

  /** Book the two FAK results. upFill/downFill: {filledShares, usdc, ackMs, ...} */
  bookLegs(id, upFill, downFill, latencyMs) {
    const p = this.pairs.get(id);
    if (!p) throw new Error(`ledger: unknown pair ${id}`);
    p.legs = { up: upFill, down: downFill };
    p.latencyMs = latencyMs;
    p.buysUsdc = (upFill.usdc || 0) + (downFill.usdc || 0);
    p.committedUsdc = p.buysUsdc;
    p.matchedShares = Math.min(upFill.filledShares, downFill.filledShares);
    const diff = upFill.filledShares - downFill.filledShares;
    if (upFill.filledShares === 0 && downFill.filledShares === 0) {
      p.state = 'SCRATCH';
      p.committedUsdc = 0;
      p.realizedPnl = 0;
    } else if (diff === 0) {
      p.state = 'MATCHED';
    } else {
      p.state = 'PARTIAL';
      const excessUp = diff > 0;
      const fill = excessUp ? upFill : downFill;
      const shares = Math.abs(diff);
      // Excess cost attributed at that leg's average fill price.
      const avg = fill.filledShares > 0 ? fill.usdc / fill.filledShares : 0;
      p.excess = { tokenId: excessUp ? p.upToken : p.downToken, sideName: excessUp ? 'Up' : 'Down', shares, costUsdc: shares * avg };
    }
    this._journal(p);
    return p;
  }

  /** Book an unwind sell of excess shares. */
  bookUnwind(id, { shares, usdc }) {
    const p = this.pairs.get(id);
    if (!p || !p.excess) throw new Error(`ledger: no excess to unwind on pair ${id}`);
    p.unwinds.push({ shares, usdc, t: Date.now() });
    p.unwindUsdc += usdc;
    const avgCost = p.excess.costUsdc / p.excess.shares;
    p.unwindLossUsdc = round6((p.unwindLossUsdc || 0) + shares * avgCost - usdc);
    p.excess.shares -= shares;
    p.excess.costUsdc -= shares * avgCost;
    if (p.excess.shares <= 1e-9) {
      p.excess = null;
      if (p.matchedShares > 0) {
        p.state = 'MATCHED'; // matched core still rides to resolution
      } else {
        p.state = 'UNWOUND';
        p.committedUsdc = 0;
        p.realizedPnl = round6(p.unwindUsdc - p.buysUsdc);
      }
    }
    this._journal(p);
    return p;
  }

  /** Excess we could not sell (e.g. below exchange min size): rides to resolution. */
  markStranded(id, why) {
    const p = this.pairs.get(id);
    if (!p) return null;
    p.state = 'STRANDED';
    p.strandedWhy = why;
    this._journal(p);
    return p;
  }

  /** Terminal: window resolved. outcome = 'Up' | 'Down' | null (unknown/void). */
  bookResolution(id, outcome) {
    const p = this.pairs.get(id);
    if (!p) return null;
    if (['SCRATCH', 'UNWOUND', 'RESOLVED'].includes(p.state)) return p;
    let redeem = p.matchedShares * 1.0; // a matched pair pays $1 regardless of outcome
    if (p.excess && outcome !== null && p.excess.sideName === outcome) {
      redeem += p.excess.shares * 1.0;
    }
    p.redeemUsdc = round6(redeem);
    p.resolution = { outcome, t: Date.now() };
    p.state = 'RESOLVED';
    p.committedUsdc = 0;
    p.realizedPnl = round6(p.redeemUsdc + p.unwindUsdc - p.buysUsdc);
    this._journal(p);
    return p;
  }

  /** Pairs past their window end that still need an outcome. */
  pendingResolutions(nowMs, graceMs = 90_000) {
    const out = [];
    for (const p of this.pairs.values()) {
      if (['MATCHED', 'PARTIAL', 'STRANDED'].includes(p.state) && nowMs >= p.windowEndMs + graceMs) out.push(p);
    }
    return out;
  }

  /** P&L strip decomposition (plan §8 block 1). */
  stats() {
    const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
    let realized = 0, redeems = 0, buys = 0, unwindProceeds = 0, unwindLosses = 0, expectedFees = 0;
    let terminal = 0;
    for (const p of this.pairs.values()) {
      counts[p.state]++;
      expectedFees += p.detect.expectedFees || 0;
      if (p.realizedPnl !== null) { realized += p.realizedPnl; terminal++; }
      redeems += p.redeemUsdc;
      buys += p.buysUsdc;
      unwindProceeds += p.unwindUsdc;
      unwindLosses += p.unwindLossUsdc || 0;
    }
    return {
      pairs: this.pairs.size,
      counts,
      committedUsdc: this.committedUsdc(),
      realizedPnl: round6(realized),
      perPair: terminal ? round6(realized / terminal) : null,
      decomposition: {
        redeems: round6(redeems),
        buys: round6(buys),
        unwindProceeds: round6(unwindProceeds),
        unwindLosses: round6(unwindLosses),
        expectedFees: round6(expectedFees),
      },
    };
  }
}

function round6(x) { return Math.round(x * 1e6) / 1e6; }

module.exports = { PairLedger, STATES };
