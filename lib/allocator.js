'use strict';

// Allocator — spreads the active-USDC cap across series by realized edge
// (plan: "capital manager that allocates the active-USDC cap across series by
// realized edge") and drives the clip ladder from measured depth.
//
// Weights: exponentially-smoothed realized P&L per series, floored so no
// series is starved below half its equal share (a series with no data yet
// deserves its shot; a series that keeps losing decays toward the floor).

class Allocator {
  constructor({ maxActiveUsdc, series, halfLife = 20, minAttemptUsdc = 6 }) {
    this.maxActiveUsdc = maxActiveUsdc;
    this.series = series;
    // A per-series cap below the cost of one minimum clip would silently
    // block every module on every series (the global active-USDC cap still
    // binds overall — this floor only stops the split from being self-defeating).
    this.minAttemptUsdc = minAttemptUsdc;
    this.alpha = 1 - Math.pow(0.5, 1 / halfLife); // per-observation smoothing
    this.edge = new Map(series.map((s) => [s, 0])); // smoothed realized per pair
    this.seen = new Map(series.map((s) => [s, 0]));
  }

  /** Feed one terminal pair's realized P&L. */
  record(series, realizedPnl) {
    if (!this.edge.has(series)) return;
    const prev = this.edge.get(series);
    this.edge.set(series, prev + this.alpha * (realizedPnl - prev));
    this.seen.set(series, (this.seen.get(series) || 0) + 1);
  }

  /** Per-series USDC cap. Equal split until data exists; then edge-weighted
   *  with a floor of half the equal share. */
  capFor(series) {
    const n = this.series.length || 1;
    const equal = this.maxActiveUsdc / n;
    const lift = (x) => Math.round(Math.max(x, Math.min(this.minAttemptUsdc, this.maxActiveUsdc)) * 100) / 100;
    const floor = equal / 2;
    const anyData = [...this.seen.values()].some((c) => c >= 3);
    if (!anyData) return lift(equal);
    const scores = this.series.map((s) => Math.max(0, this.edge.get(s) || 0));
    const total = scores.reduce((a, b) => a + b, 0);
    if (total <= 0) return lift(equal);
    const idx = this.series.indexOf(series);
    if (idx < 0) return lift(equal);
    const bonusPool = this.maxActiveUsdc - floor * n;
    return lift(floor + (scores[idx] / total) * bonusPool);
  }

  /** Clip ladder (5 → 10 → 20) driven by measured depth at best on both legs:
   *  step up only when depth comfortably covers the bigger clip. */
  clipLadder(baseShares, depthUp, depthDown) {
    const depth = Math.min(depthUp, depthDown);
    for (const mult of [4, 2]) {
      if (depth >= baseShares * mult * 2) return baseShares * mult;
    }
    return baseShares;
  }

  snapshot() {
    const out = {};
    for (const s of this.series) {
      out[s] = { edge: Math.round((this.edge.get(s) || 0) * 1e4) / 1e4, pairs: this.seen.get(s) || 0, capUsdc: this.capFor(s) };
    }
    return out;
  }
}

module.exports = { Allocator };
