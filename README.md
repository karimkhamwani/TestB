# arb-bot — bi-directional pair arb, Phase 0 build

Implementation of [bidirectional-arb-plan.md](bidirectional-arb-plan.md), work
items **1, 2 and 2b** (plan §8b). Per the plan's most important line, nothing
past the observer exists yet: *"nothing gets built past the observer until the
observer proves the opportunities exist net of fees."* `ARB_MODE=live` refuses
to start.

## What's here

| File | Plan section | What it is |
|---|---|---|
| `arb-core.js` | §4 detector | Pure detector math: V2 fee curve `rate·(p(1−p))^exp`, fee-adjusted buy/sell edges, dynamic clip sizing, all gates. No I/O. |
| `arb-core.test.js` | §8b item 2 | 24 unit tests for the detector. |
| `test/dump-vectors.js` | §4b guardrail 1 | Dumps `arb-core.vectors.json` (315 golden vectors, 6dp) — the C++ engine's build-gating test input. |
| `arb-bot.js` | §5 Phase 0 | Supervisor: gamma discovery per window, CLOB market-ws books, observer. Standalone (`npm run arb`), never pm2. |
| `lib/gamma.js` | §4 feeds | Window discovery. Slugs are deterministic: `{asset}-updown-{tf}-{unixWindowStart}` (verified live). |
| `lib/books.js` | §4 feeds | L2 book maintenance over the market ws; 5s PING keepalive; connection swap on window rollover. |
| `lib/observer.js` | §5 Phase 0 | Push-driven edge-event detection (not sampled — the gate needs ≥300ms event durations), 1 Hz sampler, plus the three free archetype recorders (cross-timeframe, near-resolution, skew). |
| `lib/config.js` | §7 | Env config + the runtime `UPDOWN_SLUG_PREFIX` collision assert (refuses to start on overlap). |
| `dashboard-server.js` | §8 | `GET /api/arb` + the Arb tab (observer view) on :3210. |

## Run (Windows trading box — CLOB websockets are blocked on the Mac)

```
npm install
npm test                 # 37 tests
npm run vectors          # regenerate arb-core.vectors.json
npm run observe          # Phase 0 observer (or: npm run arb -- --observe)
npm run dashboard        # http://localhost:3210
```

Copy `.env.example` to `.env` and set `UPDOWN_SLUG_PREFIX` to whatever the
updown bot uses so the collision assert has teeth.

Leave the observer running 2–3 days, then read the **gate blocks** on the
dashboard: the go/no-go is ≥ 20 gate-qualifying events/day per side
(fee-adjusted trigger, ≥ 5×5 depth at best, ≥ 300ms duration, all series
combined). Whichever side clears gets built first; if neither clears, the
strategy is dead at our latency (plan §5, Phase 0 gate).

`--rest-poll` exists for smoke-testing plumbing on the Mac only. It samples
REST books at 1 Hz, which aliases sub-second events — **never** valid for the
gate; the dashboard shows a warning pill when it's active.

## Data files (`data/`)

- `arb-events.jsonl` — one row per event: `edge-event` (open→close, with
  duration, max edge, min fee-adjusted sum, open snapshot, whether our own
  exec constraints would also have passed), `skew`, `xtf-divergence`,
  `near-resolution` (final-30s leader vs eventual outcome → reversal rate).
- `arb-samples-YYYYMMDD.jsonl` — 1 Hz time series (sums, fee-adjusted sums, depths, τ).
- `arb-status.json` — heartbeat, rewritten every 3s; the dashboard reads it.

## Facts verified against the live exchange (2026-08-31)

- Fee schedule on updown markets: `{rate: 0.07, exponent: 1, takerOnly: true}`
  (feeType `crypto_fees_v2`) → taker ≈ 1.75¢/share/leg at p=0.50, ~0 polarized.
  Makers exempt. **The base of the formula (shares vs notional) is still
  secondhand** — verify against one real charged fill before Phase 1 goes live
  (plan §2 work item).
- `orderMinSize = 5` shares, tick 0.01 — encoded as a clip floor.
- 5m windows resolve on the Chainlink **TWAP** stream; "≥ open" resolves Up,
  so there is no separate tie outcome (risk-register tie item: rules read, no
  tie exposure on these series).
- Book REST/ws shapes, slug determinism, endDate = windowStart + tf.

## What is deliberately NOT built yet (plan gates)

Phase 1 executor, pair ledger, CTF split/merge, C++ engine — all blocked
behind the Phase 0 numbers. The golden-vector file and the `ARB_ENGINE`
config knob exist so the later phases slot in without rework.
