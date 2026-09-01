'use strict';

// Skew module — the directional-hedge dial (plan: "directional arbitrage"
// archetype). κ ∈ [0.50 … 0.85] is the target dominant share of volume.
// κ = 0.50 is pure arb (equal legs) and is the HARD-PINNED default:
//
//   κ only rises above 0.50 when a CALIBRATED fair-value signal exists. An
//   uncalibrated model with κ > 0.5 is just losing-side-buying bias with
//   extra steps. Calibration proof lives in data/calibration.json:
//     { "verified": true, "checkedAt": "...", "brierOrNote": "..." }
//   written by the (separate) model-calibration exercise — ≥1 week of dry
//   scoring with predicted probabilities within ~5pts of realized.
//
// Also owns the two structural rules that make skew survivable:
//   - worst-case loss per market = cost − hedgePayout, computed BEFORE entry
//     and capped by ARB_MAX_LOSS_USDC (pure directional bots hope; this knows)
//   - merge policy: in skew mode matched pairs are the hedge's working
//     inventory and are NOT auto-merged (merge is a de-risk/exit TOOL);
//     at κ = 0.50 auto-merge stays on (pairs are the product; cash them).

const fs = require('node:fs');
const path = require('node:path');

class Skew {
  constructor({ kappa, maxLossUsdc, dataDir, log = () => {} }) {
    this.requestedKappa = kappa;
    this.maxLossUsdc = maxLossUsdc;
    this.calibrationPath = path.join(dataDir, 'calibration.json');
    this.log = log;
    this.kappa = this._resolveKappa();
  }

  _resolveKappa() {
    if (this.requestedKappa <= 0.5) return 0.5;
    try {
      const cal = JSON.parse(fs.readFileSync(this.calibrationPath, 'utf8'));
      if (cal.verified === true) {
        const k = Math.min(this.requestedKappa, 0.85);
        this.log(`skew: calibration verified (${cal.checkedAt || 'undated'}) — κ=${k}`);
        return k;
      }
    } catch {}
    this.log(`skew: ARB_SKEW=${this.requestedKappa} requested but no verified ${this.calibrationPath} — κ PINNED at 0.50 (pure arb)`);
    return 0.5;
  }

  get active() { return this.kappa > 0.5; }

  /** Auto-merge matched pairs? Pure arb: yes. Skew mode: merge is a tool. */
  get autoMerge() { return !this.active; }

  /** Leg sizing for a target total volume V at the current κ.
   *  dominant = κV, hedge = (1−κ)V; at κ=0.5 the legs are equal (pure arb). */
  legSizes(totalShares) {
    const dominant = Math.floor(totalShares * this.kappa);
    return { dominant, hedge: totalShares - dominant };
  }

  /** Hard risk invariant: worst-case loss = cost − hedge payout. The hedge leg
   *  pays $1/share when the dominant side loses. Entry is allowed only if the
   *  worst case fits under the cap. */
  worstCaseLoss({ dominantShares, dominantPrice, hedgeShares, hedgePrice }) {
    const cost = dominantShares * dominantPrice + hedgeShares * hedgePrice;
    return Math.round((cost - hedgeShares) * 1e6) / 1e6;
  }

  entryAllowed(sizing) {
    if (!this.active) return { ok: true, worstCase: null }; // pure arb has no naked excess
    const worstCase = this.worstCaseLoss(sizing);
    return worstCase <= this.maxLossUsdc
      ? { ok: true, worstCase }
      : { ok: false, worstCase, why: `worst-case loss $${worstCase} > ARB_MAX_LOSS_USDC $${this.maxLossUsdc}` };
  }
}

module.exports = { Skew };
