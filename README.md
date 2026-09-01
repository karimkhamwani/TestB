# arb-bot — bi-directional pair arb on Polymarket updown markets

Implementation of [bidirectional-arb-plan.md](bidirectional-arb-plan.md): one
strategy, all modules, behind one command. In a binary market `Up + Down`
always pays $1.00 at resolution; every module harvests a different route to
that identity, and they all book through one pair-level ledger.

## Run

```
npm install
npm test                    # 69 tests
npm run arb -- --observe    # recorder only (no keys)
npm run arb -- --dry        # FULL strategy, paper venue + paper CTF
npm run arb -- --live       # REAL ORDERS — POLY_PRIVATE_KEY + ARB_LIVE_CONFIRM=yes
npm run dashboard           # http://localhost:3210
node report.js              # paste-able gate/P&L report from the data files
node reconcile.js           # journal vs live positions — after EVERY live session
```

Run on the Windows trading box — CLOB websockets are blocked on the Mac
(`--rest-poll` exists there for plumbing smoke tests only; its 1 Hz books alias
sub-second events and are never valid for the go/no-go gate).

## The strategy's modules (`ARB_MODULES`, all on by default)

| Module | What it does | Key files |
|---|---|---|
| **observer** (always on) | Push-driven edge-event detection, 1 Hz sampling, the go/no-go gate instrument, plus free recorders: cross-timeframe divergence, near-resolution reversal rate, skew moments. | [lib/observer.js](lib/observer.js) |
| **taker** | Cheap pairs: fee-adjusted `askUp+askDown ≤ ARB_BUY_SUM` with depth → two concurrent FAK buys; excess sold back immediately at the bid; matched pairs auto-merge to cash. | [lib/trader.js](lib/trader.js) |
| **maker** | Rests bids on both legs summing ≤ `ARB_POST_SUM` (maker fills pay zero fees). On a lone fill: completion-take under `ARB_COMPLETE_MAX_SUM`, else leash then sell back. Lean-aware: the losing-side bid widens/pulls first as the market polarizes, so accidents strand us on the probable winner. | [lib/maker.js](lib/maker.js) |
| **sellside** | Rich pairs: `bidUp+bidDown ≥ ARB_SELL_SUM` → CTF-split $1/share into pairs, FAK-sell both legs. Optional pre-split inventory per window (`ARB_PRESPLIT_USDC`) takes the on-chain tx off the critical path; leftovers merge back at window roll. | [lib/sellside.js](lib/sellside.js) |
| **ctf** (always on with the strategy) | `splitPosition` / `mergePositions` / `redeemPositions`. Matched pairs merge to cash in per-condition batches (gas amortized). Live CTF requires an EOA signer; with a proxy wallet it stays disabled (hold-to-resolution fallback) until `ARB_PROXY_EXEC=direct` is verified on-box. | [lib/ctf.js](lib/ctf.js) |
| **allocator** | Spreads `ARB_MAX_ACTIVE_USDC` across series by exponentially-smoothed realized edge (floored at half the equal share) and steps the clip ladder 5→10→20 with measured depth. | [lib/allocator.js](lib/allocator.js) |
| **skew** | The directional-hedge dial κ. **Hard-pinned at 0.50 (pure arb)** unless `data/calibration.json` has `verified: true`. When active: dominant/hedge leg sizing, worst-case loss computed before entry and capped by `ARB_MAX_LOSS_USDC`, and auto-merge switches off (pairs become the hedge's working inventory; merge is a de-risk/exit tool). | [lib/skew.js](lib/skew.js) |

Shared spine: [arb-core.js](arb-core.js) (pure detector math + golden vectors
for the future C++ engine), [lib/ledger.js](lib/ledger.js) (pair-level
inventory accounting, `PnL = sells + merges + redeems + unwinds − buys −
splits − ctfCosts`), [lib/venue.js](lib/venue.js) (paper/live order venues
behind one interface), [lib/strategy.js](lib/strategy.js) (the orchestrator).

## Safety rails

- `--live` refuses without `ARB_LIVE_CONFIRM=yes` **and** a key in `.env` (never commit it; `.gitignore` covers it).
- Caps enforced in one place (the ledger): active-USDC, pairs-per-window, per-series allocation, one in-flight per series, re-arm cooldowns.
- Every fill books only exchange-confirmed `makingAmount`/`takingAmount`.
- Dry-run fills are **optimistic** (no race, full displayed depth) — dry P&L is an upper bound.
- Journal rows are seq-numbered; readers take the highest (async appends land out of order).
- Refuses to start if `ARB_SERIES` overlaps `UPDOWN_SLUG_PREFIX`.

## The gate still gates

Building everything doesn't skip the plan's measurement discipline — it just
moves it from "what gets built" to "what stays enabled":

1. Observe/dry for 2–3 days on Windows → `node report.js` → the go/no-go
   verdict per side (≥ 20 gate-qualifying events/day; duration p50 vs ~300ms).
2. Disable modules whose side of the market doesn't show up
   (`ARB_MODULES=taker,maker` if rich pairs never appear, etc.).
3. Dry week clean → live at the $10 cap → `node reconcile.js` after every
   session → **verify one real fill's charged fee** against the journal
   (the fee formula base is still secondhand) → raise caps stepwise.

## Facts verified against the live exchange (2026-08-31)

- Updown event slugs are deterministic: `{asset}-updown-{tf}-{unixWindowStart}`.
- Fee schedule `{rate: 0.07, exponent: 1, takerOnly: true}` (feeType
  `crypto_fees_v2`): taker ≈ 1.75¢/share/leg at p=0.50, ~0 polarized, makers free.
- `orderMinSize = 5` shares, tick 0.01.
- 5m markets resolve on the Chainlink TWAP stream; "≥ open" resolves Up (no tie outcome).
- Gamma takes minutes to finalize outcomes to 1/0 — resolution booking retries,
  and imbalanced pairs wait for a real outcome (money rides on it).

## Still open (known, deliberate)

- **User-ws field names need one live verification** — the user-channel feed
  ([lib/userws.js](lib/userws.js)) derives maker fills from order-update
  deltas and logs every raw message to `data/arb-userws-raw.jsonl`; check that
  log against the first live fills. Until the feed is connected the maker
  module refuses to quote (resting orders we can't see fill are unmanaged risk).
- **CTF via proxy wallet** is unverified (the plan's own flagged unknown):
  live split/merge currently requires an EOA signer (`POLY_SIGNATURE_TYPE=0`).
- **Fee formula base** (shares vs notional) unverified against a real charged fill.
- **C++ engine**: golden vectors (`arb-core.vectors.json`, `npm run vectors`)
  are ready; build it only if the taker's measured detect→ack p95 says it pays.
