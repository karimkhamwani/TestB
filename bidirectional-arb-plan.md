# Bi-Directional Arbitrage Bot — Plan

**Target:** Polymarket crypto up/down markets (btc/eth/sol/xrp/doge × 5m/15m).
**Machine:** Windows trading box only (CLOB websockets are blocked on the Mac).
**Posture:** standalone script (`npm run arb`), never in pm2 / `npm run up`, dry-run
first, hard capital caps.

---

## 1. What "bi-directional" means here

In a binary market, `Up + Down` always pays exactly **$1.00** at resolution.
That gives two mirror-image arbs, both **model-free** — no fair-value formula,
no volatility estimate, no calibration risk. Price sums are the entire signal:

| Direction | Condition | Action | Profit |
|---|---|---|---|
| **BUY side** ("cheap pair") | `askUp + askDown < 1.00 − fees` | buy both legs | `1.00 − sum − fees` per share |
| **SELL side** ("rich pair") | `bidUp + bidDown > 1.00 + fees` | split $1 USDC into 1 Up + 1 Down (CTF `splitPosition`), sell both legs | `sum − 1.00 − fees` per share |

Why we believe the sell side exists at all: the analyzed wallet
(0xeebde7a0, see `wallet-analysis-0xeebde7a0.md`) traded 2,017 paired markets
whose **median combined price was 1.018** — the crowd routinely pays more than
$1.00 for a pair. Someone is collecting that 1.8¢. The buy side we already
harvest occasionally via the updown bot's `UPDOWN_TAKE_SUM` path; the same
wallet's p25 pair sum was 0.971, so sub-$1 moments exist too.

Each direction has a passive and an aggressive variant:

- **Take-take** (aggressive): both conditions visible in the book *right now*,
  fire two FAK orders in the same instant. Zero legging risk if both fill.
  Rare, latency-sensitive, but the cleanest money in the system.
- **Post-post** (passive): rest orders on both sides priced so the sum clears
  the threshold; earn the spread instead of paying it. Bigger edge per share,
  but introduces **legging risk** (one side fills, the other doesn't) — the
  exact failure mode the updown watchdog already handles.

## 2. What we already know (from this repo's data and live runs)

- Completed buy-side pair at 0.98 = **$0.02/share locked** — and it does NOT
  need to be held to resolution: CTF `mergePositions` converts 1 Up + 1 Down
  back into $1.00 collateral **immediately** (split/merge are contract ops,
  not trades: no order book, no fees, cents of relayed Polygon gas). Buy the
  pair, merge, bank the cash in the same second.
- One-legged fills are common and expensive: our live btc/eth run saw both
  markets go one-legged in the same window; the BTC unwind cost **−$1.30** —
  13 completed pairs of profit. Legging risk is *the* cost center.
- The pro wallet cuts stranded legs at median **54s** and holds matched pairs;
  its all-in edge was 2.37¢/share bought. Pure-arb subsets of its flow are
  necessarily thinner than that.
- Sub-$1 ask-sums are often **bait**: the pair looks cheap because one book is
  stale mid-move, and the leg you fill is the one about to lose. Depth checks
  and a book-freshness gate are mandatory, not optional.
- Fee model (per the Polymarket V2 architecture write-up, rootdata #630704):
  **only takers pay; makers are exempt.** Taker fee = `C x feeRate x p x (1-p)`
  — maximal at p=0.50, near zero at the extremes. Consequences:
  - passive (post-post) legs pay **zero fees** — the maker route is
    structurally cheaper, not just better-priced;
  - take-take pairs near 0.50/0.50 sit at the fee curve's PEAK — the worst
    possible fee zone — while polarized pairs (0.90/0.08) are nearly free;
  - the detector must price each leg's fee with the p(1-p) curve, not a flat
    rate. Rates stay queryable per token (`client.feeRates` / `FeeInfos`);
  - the formula's base (shares vs notional) and the exact `C` are secondhand —
    **verify against one real fill's charged fee before the detector's
    arithmetic is trusted** (work item in Phase 1, before the live gate).

## 3. Economics envelope (honest version)

Per completed pair, per share: `edge − fees`. With 5-share clips:

- buy-side at sum 0.98, zero fees → $0.10/pair; at 20 completed pairs/day → $2/day
- sell-side at sum 1.02, zero fees → $0.10/pair, same math
- capital recycles in **seconds, not minutes**: completed buy-side pairs are
  merged straight back to cash (see above), so the same $10 can in principle
  work every opportunity of the day. The binding constraint is purely
  **opportunity frequency × depth**
- merge is cheap but not free: a 5-share pair earns ~$0.10, so even 2–3¢ of
  per-tx relay/gas cost eats 20–30% of it. **Batch merges** — accumulate a
  window's completed pairs and merge once — and measure the real per-merge
  cost before assuming the instant-recycle math

We do not know opportunity frequency. That is why Phase 0 exists. If
measurement shows (say) sum < 0.985 with 5×5 depth occurs 40×/day across 10
series and persists ≥ 500ms, the take-take bot alone clears a few dollars a
day at 5-share clips and scales linearly with clip size until depth runs out.
If it occurs 3×/day for 80ms, only the passive variants are worth building.
**The plan's first deliverable is that number, not a trading bot.**

## 4. Architecture

Two processes — a Node **supervisor** (brains, books) and a C++ **execution
engine** (the latency-critical hot path). Everything that decides or records
money stays in the tested Node core; C++ owns only the race:

```
NODE SUPERVISOR (arb-bot.js)                 C++ ENGINE (arb-engine)
  market discovery (gamma REST)               ws book ingestion (simdjson parse)
  fee rates per window                        edge detection (mirror of arb-core)
  pair LEDGER (arb-core.js, 37 tests)   <---  fill/ack events (ndjson over pipe)
  journal + reconciliation              --->  window config: tokens, thresholds,
  CTF split/merge/redeem, settlement          clip sizes, caps (ndjson over pipe)
  observer mode (Phase 0)                     EIP-712 sign (libsecp256k1) + POST
  watchdog: restarts/halts the engine         over a kept-alive TLS session
```

The engine is deliberately dumb: it receives per-window instructions
("these two tokens, fire take-take if fee-adjusted sum ≤ X, clip N, stop at
cap C"), races, and reports what happened. It holds no books, computes no
P&L, and can be killed at any moment without corrupting state — the Node
ledger is always the source of truth.

Original single-process layout (kept as the v1 executor and permanent
fallback — see the C++ section for why):

```
feeds:   CLOB market ws  -> live L2 books for all subscribed tokens (push)
         CLOB user ws    -> our fills (push; REST getOrder reconciliation sweep)
         gamma REST      -> per-window market discovery (slug -> token ids)
         client.feeRates -> per-token fee, refreshed per window
detector (pure functions, unit-testable):
         buyEdge  = 1 - (askUp + askDown) - feeBuy(askUp) - feeBuy(askDown)
         sellEdge = (bidUp + bidDown) - 1 - feeSell(bidUp) - feeSell(bidDown)
         gated by: min depth on BOTH legs, book freshness (< 1s), price band,
         $1 marketable minimum per leg, time remaining > 20s.
         NOTE the interaction: the fee curve makes POLARIZED pairs (0.88+0.09)
         the most attractive, but a 5-share clip on a $0.09 leg is $0.45 —
         under the $1 minimum, auto-rejected. Clip size must therefore be
         DYNAMIC: shares = max(ARB_SHARES, ceil(1 / cheapLegPrice)), capped by
         depth and the active-USDC cap. A fixed 5-share clip silently locks
         the bot out of exactly the pairs the fee model favors
executor: per phase (below)
ledger:   pair-level accounting — every pair is CREATED as a unit and every
          leg's fill/cut/settle is booked against it (all four mm-bot
          accounting bugs were leg-level bookkeeping errors; pair-level state
          is the structural fix). P&L uses the full-flow formula the V2
          article warns most trackers get wrong:
          PnL = sells + merges + redeems - buys - splits + open value
          (split/merge cash flows are NOT trades and must be booked as their
          own legs or the books show phantom profit)
journal:  arb-journal.json — one row per pair attempt with prices, depths,
          fees, latency (detect -> both acks), and outcome
```

Explicitly reused from the existing codebase: Binance strike/vol code is NOT
needed (pure arb is model-free); ws book maintenance, preflight, orphan-order
sweep, settlement-via-`market-resolution.js`, and the partial-fill FAK
accounting all come from mm-bot patterns as reviewed and tested this week.

## 4b. C++ execution engine — scope, honesty, and guardrails

**Where C++ actually buys speed here.** The take-take race is: book event →
parse → detect → sign EIP-712 → HTTPS POST. Network RTT and the exchange's
~250–300ms taker settlement dominate the total, and no language shortens
those. What C++ removes is OUR contribution: V8 GC pauses (1–10ms jitter at
the worst moments — precisely when books churn), JSON parse cost, and ~1–2ms
ECDSA signing in JS vs ~0.1ms with libsecp256k1. Realistic gain: **a few ms
average, tens of ms off the tail**. Against "microsecond-level HFT" rivals
(post-V2, speed bumps removed) we still lose pure races — the C++ engine
makes us fast enough to catch leftovers competitively, not to win front-runs.

**Stack (Windows-native, no WSL dependency):**
- CMake + vcpkg; MSVC build
- `uWebSockets`/Boost.Beast (ws + HTTPS with persistent TLS), `simdjson`,
  `libsecp256k1` + Keccak-256 for EIP-712 order signing
- pre-computed EIP-712 domain separator + order-struct template per window:
  at detect time only amounts are patched in, hashed, signed (~0.1ms), POSTed
  over the already-open TLS session
- IPC with the supervisor: newline-delimited JSON over a named pipe (same
  transport the copier already uses on Windows)

**Guardrails — the two real dangers of a second implementation:**
1. **Divergent math.** The C++ detector re-implements `arb-core.js` logic.
   Both MUST pass the same **golden test vectors**: the Node test suite dumps
   `arb-core.vectors.json` (inputs → expected edges/clips/fees to 6dp), and
   the C++ build runs them as its unit tests. A vector mismatch fails the
   build. No hand-waved "it's the same formula".
2. **A fast bug is a fast money-loser.** The engine enforces its own hard
   caps (max clip, max in-flight, max USDC per window) *independently* of the
   supervisor's, and halts itself on any ledger-reject from the supervisor
   (an exchange-confirmed fill the ledger refuses to book = state divergence
   = stop trading, loudly).

**Sequencing (does not block anything).** Phase 1 ships on the Node executor
first — same detector, same ledger, just slower. The engine is built in
parallel and swapped in behind the same IPC interface once it (a) passes the
golden vectors, (b) beats the Node executor's measured detect→ack latency in
an A/B benchmark on the Windows box, and (c) runs a full dry week with zero
state divergences. The Node executor remains the permanent fallback: if the
engine crashes or diverges, the supervisor falls back and trading continues
slower rather than stopping.

**Measure before believing.** Work item 4a logs the Node executor's
detect→ack histogram. If p95 is already dominated by network RTT (likely
30–80ms), the C++ engine's priority drops accordingly — it is an
optimization, not a prerequisite, and the observer's opportunity-duration
data (Phase 0) decides how much tail latency actually costs us.

## 5. Phases with go/no-go gates

### Phase 0 — Measure (build first, ~a day; runs unattended)
`arb-bot.js --observe`: subscribe books for all 10 series. **Edge-event
detection runs on every websocket book update (push), not on a clock** — the
gate cares about events lasting ≥ 300ms, and 1 Hz sampling would alias or
miss them entirely. A once-per-second sampler additionally records `askSum`,
`bidSum`, depth and fees for the time-series histograms. No orders. Runs on
Windows for 2–3 days.

The same feeds carry the data for THREE more archetypes at zero extra cost,
so the observer records them too and Phase 0 doubles as strategy selection:

- **cross-timeframe divergence** (taxonomy type 4): implied probability of the
  15m contract vs the live 5m contracts inside it — log divergence events;
- **near-resolution pricing** (type 6): best ask on the leading side in the
  final 30s vs eventual outcome — measures the real reversal rate behind the
  "buy at 0.99" style (high win rate, tail risk — this is the data that
  answers the earlier 0.95-limit-order idea with numbers instead of theory);
- **skew opportunities** (type 2, see Phase 5): moments where one leg is
  buyable below the model fair while the pair still sums < 1.00.

**Gate to Phase 1:** fee-adjusted buy-side events with ≥ 5×5 depth and
≥ 300ms duration occur often enough to matter (target: ≥ 20/day across all
series). Same test separately for sell-side. Whichever side clears its gate
gets built first; if neither clears, stop — the strategy is dead at our
latency and the effort moves elsewhere.

### Phase 1 — Take-take buy side (the safe core)
Both asks visible, fee-adjusted sum ≤ threshold (start 0.985), both FAKs fired
concurrently. Note the fee curve: both legs are taker fills, and near
0.50/0.50 that is the most expensive fee zone on the platform — the
fee-adjusted detector will naturally prefer polarized pairs (e.g. 0.88+0.09),
where taker fees collapse toward zero. Handle the three outcomes:

- both fill → **merge immediately** (`mergePositions`: pair -> $1.00 cash, no
  fee, no order book). No resolution wait, no tie/void exposure, capital free
  for the next opportunity within seconds.
  **Dependency fix:** merging is CTF contract machinery, which the original
  draft scheduled in Phase 3 — Phase 1 must not silently depend on Phase 3
  work. So: Phase 1 v1 ships with hold-to-resolution (capital recycles per
  window, tie risk stays in the register), and the CTF split/merge/redeem
  module is built as **work item 4b**, immediately after the v1 executor.
  Merge-on-fill turns on the moment it exists. Also verify early whether the
  proxy wallet (SIGNATURE_TYPE=1) needs Polymarket's relayer for CTF calls —
  that is an unknown that could delay 4b, not a reason to delay Phase 1
- one fills / partial imbalance → **immediate** sell-back at the bid (reuse
  the watchdog's unwind, but fired instantly — no 50s wait; we were never
  entitled to rest)
- neither fills → nothing happened

Caps: `ARB_MAX_ACTIVE_USDC` (start $10 live after a clean dry week),
per-window pair cap, one in-flight attempt per market.

Executor: Node first; the C++ engine (section 4b) replaces the hot path once
it passes golden vectors + A/B benchmark + a clean dry week. Detection
thresholds and books do not change — only the reaction time.

**Gate to keep running:** after 100 live pairs, realized P&L per pair > 0 and
unwind rate < 25%. Reconcile journal vs actual Polymarket positions after the
first live session before raising any cap.

### Phase 2 — Passive buy side with a completion engine
This is the current updown bot's strategy with its one-legged problem attacked
directly instead of merely time-boxed:

- post both legs at sum ≤ target (0.98), re-quote as books move (mm-bot logic)
- **on any leg fill (push, from the user ws): immediately check whether taking
  the other side's ask still completes the pair under $0.99. If yes, FAK it —
  a completed arb beats waiting. If no, start a short leash (15–20s), then
  sell back.**
- matched pairs are merged back to cash immediately (same as Phase 1); the
  ledger tracks pairs, not legs

**Lean-aware legging control (refinement, same phase).** Sizing is never
skewed by side — a deliberate one-sided buy is a directional bet, not arb.
But *stranding* risk is skewed on purpose: live data shows the leg that fills
alone is usually the LOSING side (holders dump the dying token into resting
bids). So as the market polarizes, the losing-side bid is pulled or widened
first, while the leaning-side bid may rest longer — if an accident happens,
it should strand us on the probable winner, which the completion engine can
usually still finish into a full pair. Every completed position remains a
true both-sides arb; the asymmetry only chooses which accidents we accept.

This phase can either live in `arb-bot.js` or be back-ported to
`updown-5m.js`/copier later — decide when we see Phase 1 results. Do not run
Phase 2 and the updown bot on the same series at the same time (they would
compete with and unwind into each other).

**Gate:** completion rate (both legs matched, by post or by completion-take)
> 60% of pairs that get any fill, and per-pair P&L beats Phase 1's.

### Phase 3 — Sell side (rich pairs)
New machinery: on-chain `splitPosition` (USDC → Up+Down via the CTF contract,
Polygon gas ≈ negligible) to obtain inventory, then post/take asks on both
legs when `bidSum` clears `1.00 + fees + margin`. The V2 article confirms this
is exactly how professional makers source inventory ("Split to obtain tokens
without paying trading fees") — and that when two BUYs match at bids summing
>= $1.00 the exchange itself MINTs, meaning rich-pair moments are structural,
not anomalies:

- take-take variant first: both bids visible with depth → split, FAK-sell both
- **pre-split inventory (removes the on-chain tx from the critical path):**
  split $N into pairs at window open and hold them — a full pair is riskless
  inventory worth $1 regardless of outcome. When a rich moment appears, the
  sells fire instantly with no split latency; unsold pairs merge back (or ride
  to resolution) at window end. Cost: $N parked per market per window; the
  observer's rich-pair frequency data decides if it pays
- unsold/partial inventory: `mergePositions` back to USDC, or let it ride to
  resolution (a full pair is $1 either way — the *inventory itself is hedged*,
  which makes this direction's failure mode gentler than the buy side's)
- needs: CTF contract wiring (ethers is already a dependency), allowance
  setup, split/merge latency measured before trusting the take path

**Gate:** Phase 0 showed rich-pair events ≥ as frequent as cheap-pair ones
(the wallet's median 1.018 sum suggests they are), and split→sell round-trip
< 2s measured on Windows.

### Phase 4 — Scale
All 10 series, clip size ladder (5 → 10 → 20 shares) driven by measured depth,
capital manager that allocates the active-USDC cap across series by realized
edge. Only after Phases 1–3 each have ≥ a week of clean reconciled books.

### Phase 5 — Directional-hedge mode (skewed pairs) — optional, gated hardest
The archetype the taxonomy calls a "directional arbitrage bot" (example:
`ohanism`; the sports version, `tradecraft`, turned $17,403 of deposits into
+$213,295 on tennis with a **median 82.8% of volume on the dominant side**).
It is NOT pure arb — it is directional trading wearing an arb exoskeleton.

The structure decomposes exactly into what this bot already builds:

```
D dominant shares + H hedge shares  (D > H)
  = H matched pairs        <- locked $1 payouts; our pair ledger, unchanged
  + (D - H) naked shares   <- a directional bet, sized by the skew dial
```

Worked example (dominant @ 0.60, hedge @ 0.35, 82.8/17.2 volume split, $100):
win **+$38**, lose **−$51** — versus +$67 / **−$100** naked. The hedge gives
back ~40% of the upside to cut the catastrophe in half, and because both legs
are passive fills below fair with the pair summing 0.95, the "insurance" has
positive expected value on its own: **you are paid to hedge.**

Implementation is one dial on the existing machinery:

- `ARB_SKEW` κ ∈ [0.50 … 0.85]: target dominant share of volume. κ = 0.50 is
  today's pure arb (equal legs). κ only rises above 0.50 when a **calibrated**
  fair-value signal says one side is underpriced — this phase is hard-gated on
  the model-calibration exercise (the delta bot's dry-run scoring); an
  uncalibrated model with κ > 0.5 is just the losing-side-buying bias with
  extra steps.
- entries stay gradual (clips across the window — "enters in parts"), both
  legs passive, dominant leg only below its model fair.
- **hard risk invariant** — the entire point of the hedge: worst-case loss per
  market = `cost − H` is a computable number BEFORE entry, capped by
  `ARB_MAX_LOSS_USDC`. Pure directional bots hope; this structure knows.
- lean flips → rebalance by MERGING pairs back to cash (fee-free, no order
  book, no market impact) — the hedge doubles as an exit route through thin
  books, which is exactly why the tennis bot can carry size the book couldn't
  absorb as a sell.
- **merge policy differs from Phases 1–2 on purpose.** Auto-merge is the
  PURE-ARB rule: there, pairs are the product and cashing them is the point.
  In skew mode, matched pairs are the hedge's working inventory and are NOT
  auto-merged. Payoff at resolution is identical either way (a matched pair is
  riskless, so pair-vs-cash changes no outcome), but holding the pairs keeps
  every adjustment cheap: shrink = merge some (free, no market impact), add
  skew = sell only the hedge leg, panic exit = merge (needs no buyers).
  Once merged, every one of those becomes a spread-paying order-book trade.
  Merge in skew mode is therefore a TOOL — fired on de-risk, on exit, and at
  window end — never an automatic reflex. The naked excess rides to
  resolution or is cut on a fair-value stop, as before.

**Gate:** delta-model calibration verified on ≥ 1 week of dry-run data
(predicted probabilities within ~5pts of realized frequencies), AND Phases 1–2
running clean. Until both hold, κ stays pinned at 0.50 and this phase does not
exist.

## 6. Risk register

| Risk | Mitigation |
|---|---|
| Legging (one side fills) | instant completion-or-unwind on fill push; never wait a fixed timer in take mode |
| Stale-book bait (sum < 1 because one book lags a move) | book freshness gate (< 1s), require depth on both legs, threshold margin below 1.00 |
| Fees eat the edge | per-token fee query each window; edges computed net of fees; Phase 0 gate is fee-adjusted |
| Partial FAK fills | book only `makingAmount/takingAmount` actually returned (mm-bot fix #3); imbalance sold immediately |
| Failed cancels | orphan tracker with retry + loud give-up (mm-bot fix #6) |
| Accounting drift | pair-level ledger; mandatory journal-vs-positions reconciliation after every live session |
| Tie/void resolution (price unchanged at close) | read the market rules once and encode the tie outcome; if ambiguous, exclude the final N seconds where a tie is live risk |
| API rate limits at 10 series | ws-first design; REST only for discovery, fees, reconciliation |
| Ghost fills (off-chain match fails on-chain; ~0.17% in V2) | book only exchange-confirmed amounts (`makingAmount`/`takingAmount`), reconcile vs positions after every session |
| Tuesday 07:00 ET maintenance (~90s, ALL orders force-cancelled) | calendar guard: pull quotes before the window, re-quote after, never alarm on the mass-cancel |
| Heartbeat timeout (10s silence -> disconnect + order clear) | keep-alive on every ws; treat the auto-clear as a safety net, not an error |
| Taker latency (~250-300ms on-chain settle vs ~25ms maker acks) | take-take must assume a ~300ms race window; prefer maker routes when the edge allows |
| Both bots colliding | **runtime assert, not a comment**: arb-bot reads `UPDOWN_SLUG_PREFIX` from the same `.env` at startup and refuses to start if `ARB_SERIES` overlaps it |
| Us being the slow ones | accept it: thresholds wide enough that we don't need to win races, only to catch leftovers; Phase 0 tells us if leftovers exist |
| Skew mode with a wrong model (Phase 5) | κ hard-pinned to 0.50 until calibration is proven; worst-case loss per market computed at entry and capped by `ARB_MAX_LOSS_USDC` |
| C++/Node math divergence | shared golden test vectors (`arb-core.vectors.json`) gate the C++ build; any supervisor ledger-reject halts the engine |
| C++ engine crash / bad deploy | supervisor owns all state; auto-fallback to the Node executor, trading degrades to slower instead of stopping |
| Windows C++ toolchain overhead | CMake+vcpkg pinned deps; engine is optional at every stage — no phase blocks on it |

## 7. Config sketch

```
ARB_MODE=observe|live          # Phase 0 vs trading
ARB_SERIES=btc-updown-5m,eth-updown-5m,...   # never overlapping UPDOWN_SLUG_PREFIX
ARB_BUY_SUM=0.985              # fee-adjusted trigger, buy side
ARB_SELL_SUM=1.015             # fee-adjusted trigger, sell side (Phase 3)
ARB_SHARES=5
ARB_MAX_ACTIVE_USDC=10
ARB_MAX_PAIRS_PER_WINDOW=2
ARB_MIN_TAU_SEC=20
ARB_COMPLETE_MAX_SUM=0.99      # Phase 2 completion-take ceiling
ARB_LEASH_SEC=15               # Phase 2 unwind leash after a lone fill
ARB_SKEW=0.50                  # Phase 5 dial: 0.50 = pure arb; rises only with a calibrated model
ARB_MAX_LOSS_USDC=3            # Phase 5 hard cap on per-market worst case (cost - hedge payout)
ARB_ENGINE=node                # node | cpp — execution hot path (cpp requires passing golden vectors)
ARB_ENGINE_PIPE=arb-engine     # named-pipe suffix for supervisor <-> engine IPC
```

## 8. Monitoring dashboard

Reuses the existing dashboard stack (`dashboard-server.js` on :3210 + the
React panel) — one new data source, one new view, no second web app:

- **`arb-status.json`** (heartbeat, written every few seconds by the
  supervisor): mode/phase, engine in use (node|cpp) and its health, ws
  connection states, caps in use (`committed / ARB_MAX_ACTIVE_USDC`), orphan
  count, settling count, and — in observe mode — live opportunity counters.
- **`arb-journal.json`** (already in the plan): one row per pair attempt.
- Dashboard server gains `GET /api/arb` (serves both files); the dashboard
  gains an **Arb tab** with three blocks:

  1. **P&L strip** — realized total and its decomposition, which is the
     number that actually diagnoses the strategy:
     `merged pairs P&L + resolved pairs P&L − unwind losses − fees − gas`,
     plus win/unwind/scratch counts and P&L per pair. Each component maps to
     a plan assumption, so a sick component points at the sick assumption
     (e.g. unwind losses ballooning = the stale-book-bait gate is too loose).
  2. **Pair rows** — per attempt: market, prices, fee-adjusted sum, clip
     size, outcome badge (`MERGED` / `RESOLVED` / `UNWOUND` / `PARTIAL` /
     `IN-FLIGHT`), realized $, and detect→ack latency. The latency column is
     the live version of work item 4a's histogram.
  3. **Phase 0 observer view** — while observing: opportunity events per
     series (buy-side and sell-side separately), duration and depth
     histograms, and a running "would the gate pass?" indicator. The
     go/no-go decision gets made by looking at this panel, not by grepping
     logs.

- **Alert states surfaced as header pills** (same pattern as the copier's
  GATED/OFFLINE pills): ledger-reject / state divergence (red — engine
  halted), orphan orders present, user-ws down (fills degraded to REST
  reconciliation), heartbeat stale, Tuesday-maintenance window active.

Work item: lands with Phase 0 (the observer view IS the gate instrument), and
the trade views activate with Phase 1. Journals are append-only JSON like the
copier's, so the dashboard needs no new plumbing beyond the endpoint.

## 8b. Order of work

1. `arb-bot.js` skeleton from mm-bot plumbing + `--observe` recorder — first
2. Fee reader + fee-adjusted detector with unit tests (pure functions)
2b. Dashboard: `/api/arb` + Arb tab with the observer view (section 8) — the
    Phase 0 gate is decided from this panel
3. 2–3 days of Windows observation → **decision meeting with the numbers**
4. Phase 1 executor in Node (hold-to-resolution v1) + pair ledger + reconciliation script
4a. Latency instrumentation: detect→ack histogram for the Node executor — this
    number decides how much the C++ engine is worth
4b. CTF module: split / merge (batched) / redeem via the proxy wallet — merge-on-fill
    and Phase 3 both depend on this; verify relayer requirements here
4c. C++ execution engine (section 4b): golden vectors -> A/B benchmark vs Node ->
    dry week -> swap in behind the same IPC interface; Node stays as fallback
5. Dry week → live at $10 cap → reconcile → verify one real fee charge → raise caps stepwise
6. Phase 2 completion engine; Phase 3 split/merge wiring; Phase 4 scale

The single most important line in this plan: **nothing gets built past the
observer until the observer proves the opportunities exist net of fees.** The
downside of skipping that step isn't wasted code — it's a bot that pays fees
and spreads all day to harvest an edge that was never there.
