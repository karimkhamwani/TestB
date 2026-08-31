# arb-bot — bi-directional pair arb, Phases 0–1

Implementation of [bidirectional-arb-plan.md](bidirectional-arb-plan.md): the
Phase 0 observer (work items 1, 2, 2b) **plus the Phase 1 take-take buy-side
executor** (work items 4, 4a) with a paper venue for dry runs and a real-order
venue on the Polymarket CLOB. The plan's gate still applies operationally:
run the observer 2–3 days first, and go live only after a clean dry week.

## Modes

```
npm run arb -- --observe    # Phase 0 recorder only (no keys needed)
npm run arb -- --dry        # Phase 1 executor, PAPER fills from live books
npm run arb -- --live       # REAL ORDERS — needs POLY_PRIVATE_KEY + ARB_LIVE_CONFIRM=yes
node reconcile.js           # journal vs live positions — run after EVERY live session
```

Live safety rails: refuses without `ARB_LIVE_CONFIRM=yes` and a key; caps
enforced through the pair ledger (`ARB_MAX_ACTIVE_USDC`, pairs-per-window,
one in-flight per series, re-arm cooldown); the executor only fires when every
detector gate is green (fee-adjusted trigger, depth, freshness, τ, clip).
Dry-run fills are **optimistic** (full displayed depth, no race) — treat dry
P&L as an upper bound, not a forecast.

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
| `dashboard-server.js` | §8 | `GET /api/arb` + the Arb tab on :3210 — observer view, P&L strip, pair rows, latency. |
| `lib/venue.js` | §5 Phase 1 | Order venues: `PaperVenue` (simulated FAK fills) and `LiveVenue` (real FAK orders via `@polymarket/clob-client`, EIP-712 signed, proxy-wallet signature type 1). |
| `lib/ledger.js` | §4 ledger | Pair-level ledger + `data/arb-journal.json` (append-only ndjson, one snapshot per state change). Books only exchange-confirmed `makingAmount`/`takingAmount`. |
| `lib/trader.js` | §5 Phase 1 | Take-take executor: two concurrent FAK buys on trigger; immediate sell-back of any excess at the bid (no leash in take mode); stranded (< min size) rides to resolution; hold-to-resolution v1; detect→ack latency (work item 4a). |
| `reconcile.js` | §8b item 4 | Journal vs live positions via the data API. Non-zero drift = do not raise caps. |

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

## Going live (plan §5 Phase 1 / §8b item 5)

1. Observer 2–3 days on Windows → gate decision from the dashboard.
2. `--dry` for a week; watch the P&L strip decomposition and the detect→ack
   p95 (that number prices the C++ engine, work item 4a).
3. Fill in `POLY_PRIVATE_KEY` / `POLY_FUNDER_ADDRESS` in `.env` **on the
   trading box only** (never commit), set `ARB_LIVE_CONFIRM=yes`, start at
   the $10 cap.
4. After the first session: `node reconcile.js`, and **verify one real fill's
   charged fee** against the journal's expected fee before trusting the
   detector's arithmetic (plan §2 — formula base is still secondhand).
5. Gate to keep running: after 100 live pairs, P&L/pair > 0 and unwind rate < 25%.

Known Phase 1 v1 limitations (by design, per the plan):
- **Hold-to-resolution**: no CTF merge yet (work item 4b), so matched pairs
  tie up capital until the window resolves and winners sit unredeemed until
  the redeem module exists — `reconcile.js` lists them.
- Sell side (rich pairs, splits) is Phase 3; passive quoting is Phase 2.
- Live FAK acks include `createOrder`'s local signing only; order posting is
  one HTTPS round-trip per leg on a shared keep-alive agent.

## What is deliberately NOT built yet (plan gates)

CTF split/merge/redeem (4b), Phase 2 completion engine, Phase 3 sell side,
C++ engine (4c). The golden-vector file and the `ARB_ENGINE` config knob
exist so those slot in without rework.
