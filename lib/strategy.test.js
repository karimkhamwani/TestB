'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Strategy } = require('./strategy');
const { Maker } = require('./maker');
const { SellSide } = require('./sellside');
const { Skew } = require('./skew');
const { Allocator } = require('./allocator');
const { PaperCTF, MergeBatcher } = require('./ctf');
const { PairLedger } = require('./ledger');
const { PaperVenue } = require('./venue');
const { Observer } = require('./observer');
const { Book } = require('./books');

const FEES = { exponent: 1, rate: 0.07, takerOnly: true };

function cfg(over = {}) {
  return {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'arb-st-')),
    series: ['btc-updown-5m'],
    detector: {
      buySum: 0.985, sellSum: 1.015, shares: 5, maxActiveUsdc: 20,
      minTauSec: 20, freshnessMs: 1000, minDepth: 5,
      priceBandMin: 0.01, priceBandMax: 0.99,
    },
    observer: { minEventMs: 300, gateEventsPerDay: 20, sampleIntervalMs: 1000, xtfDivergence: 0.15, nearResWindowSec: 30 },
    trader: {
      modules: ['taker', 'maker', 'sellside', 'allocator', 'skew'],
      maxPairsPerWindow: 4, rearmMs: 1500, unwindRetries: 3, feeRateBps: 1000,
      postSum: 0.98, completeMaxSum: 0.99, leashSec: 15, requoteMs: 0,
      makerCooldownSec: 60,
      makerBandMin: 0.01, makerBandMax: 0.99, // legacy fixtures quote anywhere; band has its own tests
      makerMaxMove: 1, makerMoveWindowSec: 10, // breaker off in legacy fixtures
      makerStop: 0.05,
      presplitUsdc: 0, mergeCostUsdc: 0.01, mergeFlushSec: 30, skew: 0.5, maxLossUsdc: 3,
      ...over,
    },
  };
}

function world({ askUp = 0.55, askDown = 0.47, bidUp = 0.53, bidDown = 0.45, size = 50, trader = {} } = {}) {
  const c = cfg(trader);
  const observer = new Observer(c);
  const nowMs = Date.now();
  const mkt = {
    series: 'btc-updown-5m', slug: 'btc-updown-5m-100', windowStartMs: nowMs - 60_000,
    windowEndMs: nowMs + 240_000, conditionId: '0xcond', upToken: 'UP', downToken: 'DOWN',
    feeSchedule: FEES, minOrderSize: 5, tickSize: 0.01,
  };
  observer.setMarket('btc-updown-5m', mkt);
  const books = new Map();
  const up = new Book('UP'); const down = new Book('DOWN');
  up.applySnapshot({ bids: [{ price: bidUp, size }], asks: [{ price: askUp, size }] }, nowMs);
  down.applySnapshot({ bids: [{ price: bidDown, size }], asks: [{ price: askDown, size }] }, nowMs);
  books.set('UP', up); books.set('DOWN', down);
  const ledger = new PairLedger({ maxActiveUsdc: c.detector.maxActiveUsdc, maxPairsPerWindow: c.trader.maxPairsPerWindow, dataDir: null });
  const venue = new PaperVenue(books);
  const ctf = new PaperCTF({ txCostUsdc: 0.01 });
  const strategy = new Strategy({ cfg: c, observer, venue, ledger, ctf, log: () => {} });
  return { c, observer, books, ledger, venue, ctf, strategy, mkt, nowMs, up, down };
}

// ---------- skew ----------

test('skew: pinned at 0.50 without a verified calibration file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-skew-'));
  const s = new Skew({ kappa: 0.8, maxLossUsdc: 3, dataDir: dir });
  assert.equal(s.kappa, 0.5);
  assert.equal(s.active, false);
  assert.equal(s.autoMerge, true);
});

test('skew: verified calibration unlocks κ, capped at 0.85, flips merge policy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-skew-'));
  fs.writeFileSync(path.join(dir, 'calibration.json'), JSON.stringify({ verified: true }));
  const s = new Skew({ kappa: 0.9, maxLossUsdc: 3, dataDir: dir });
  assert.equal(s.kappa, 0.85);
  assert.equal(s.active, true);
  assert.equal(s.autoMerge, false);
});

test('skew: worst-case loss invariant gates entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-skew-'));
  fs.writeFileSync(path.join(dir, 'calibration.json'), JSON.stringify({ verified: true }));
  const s = new Skew({ kappa: 0.8, maxLossUsdc: 3, dataDir: dir });
  // 8 dom @0.60 + 2 hedge @0.35 = $5.50 cost, hedge pays $2 -> worst -$3.50 > cap
  const bad = s.entryAllowed({ dominantShares: 8, dominantPrice: 0.60, hedgeShares: 2, hedgePrice: 0.35 });
  assert.equal(bad.ok, false);
  assert.equal(bad.worstCase, 3.5);
  const good = s.entryAllowed({ dominantShares: 5, dominantPrice: 0.60, hedgeShares: 5, hedgePrice: 0.35 });
  assert.equal(good.ok, true); // 4.75 cost - 5 hedge = paid to hedge
});

// ---------- allocator ----------

test('allocator: equal split before data, edge-weighted with a floor after', () => {
  const a = new Allocator({ maxActiveUsdc: 20, series: ['a', 'b'], minAttemptUsdc: 0 });
  assert.equal(a.capFor('a'), 10);
  for (let i = 0; i < 5; i++) { a.record('a', 0.10); a.record('b', -0.05); }
  const capA = a.capFor('a');
  const capB = a.capFor('b');
  assert.ok(capA > 10, `winner grows: ${capA}`);
  assert.ok(capB >= 5, `loser floored at half the equal share: ${capB}`);
  assert.ok(Math.abs(capA + capB - 20) < 0.05);
});

test('allocator: per-series cap never drops below one minimum attempt', () => {
  // $10 across 10 series would be $1/series — silently untradeable without the floor.
  const a = new Allocator({ maxActiveUsdc: 10, series: Array.from({length: 10}, (_, i) => 's' + i), minAttemptUsdc: 6 });
  assert.equal(a.capFor('s0'), 6);
  // The floor never exceeds the global cap itself.
  const b = new Allocator({ maxActiveUsdc: 4, series: ['x', 'y'], minAttemptUsdc: 6 });
  assert.equal(b.capFor('x'), 4);
});

test('allocator: clip ladder steps with depth', () => {
  const a = new Allocator({ maxActiveUsdc: 20, series: ['a'] });
  assert.equal(a.clipLadder(5, 50, 45), 20); // depth 45 >= 5*4*2
  assert.equal(a.clipLadder(5, 25, 25), 10);
  assert.equal(a.clipLadder(5, 8, 8), 5);
});

// ---------- ctf ----------

test('ctf: paper ops and the merge batcher group by condition', async () => {
  const ctf = new PaperCTF({ txCostUsdc: 0.02 });
  const merged = [];
  const b = new MergeBatcher(ctf, (m) => merged.push(m));
  b.add('0xc1', 1, 5);
  b.add('0xc1', 2, 5);
  b.add('0xc2', 3, 7);
  assert.equal(b.pending, 3);
  await b.flush();
  assert.equal(b.pending, 0);
  assert.equal(merged.length, 3);
  assert.equal(ctf.ops.filter((o) => o.op === 'merge').length, 2); // one tx per condition
  assert.equal(merged[0].costShare, 0.01); // 0.02 split across 2 pairs
});

// ---------- maker ----------

test('maker: posts both bids under the post-sum constraint', async () => {
  const { strategy, books, venue, nowMs } = world({ bidUp: 0.53, bidDown: 0.47 }); // sum 1.00 > 0.98
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  assert.equal(venue.resting.size, 2);
  const quotes = [...venue.resting.values()];
  const sum = quotes[0].price + quotes[1].price;
  assert.ok(sum <= 0.98 + 1e-9, `posted sum ${sum} must clear 0.98`);
});

test('maker: lean pulls the losing-side bid when the market polarizes', async () => {
  const { strategy, books, venue, nowMs } = world({ bidUp: 0.85, askUp: 0.87, bidDown: 0.10, askDown: 0.13 });
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  const sides = [...venue.resting.values()].map((o) => o.tokenId);
  assert.ok(sides.includes('UP'), 'leaning-side bid rests');
  assert.ok(!sides.includes('DOWN'), 'losing-side bid pulled beyond 0.80 mid');
});

test('maker: completion-take finishes the pair after a lone fill', async () => {
  const { strategy, books, venue, ledger, nowMs, down } = world({ bidUp: 0.50, bidDown: 0.45, askDown: 0.47 });
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  const upQuote = [...venue.resting.values()].find((o) => o.tokenId === 'UP');
  assert.ok(upQuote);
  // Someone sells into our Up bid: ask drops to our price.
  const up = books.get('UP');
  up.applySnapshot({ bids: [{ price: 0.49, size: 50 }], asks: [{ price: upQuote.price, size: 50 }] }, nowMs + 10);
  await strategy.onBookUpdate('btc-updown-5m', books, nowMs + 10);
  const pair = [...ledger.pairs.values()].find((p) => p.source === 'maker');
  assert.ok(pair, 'maker pair opened on fill');
  // fillPrice + askDown(0.47) <= 0.99 -> completion take fired
  assert.equal(pair.qty.up, pair.qty.down);
  assert.ok(pair.qty.up > 0);
  assert.equal(pair.state, 'MATCHED');
});

test('maker: leash expiry sells the lone leg back', async () => {
  const { strategy, books, venue, ledger, nowMs } = world({
    bidUp: 0.50, bidDown: 0.45, askDown: 0.60, // completion impossible (0.5+0.6 > 0.99)
    trader: { leashSec: 0 },                    // leash expires immediately
  });
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  const upQuote = [...venue.resting.values()].find((o) => o.tokenId === 'UP');
  books.get('UP').applySnapshot({ bids: [{ price: 0.49, size: 50 }], asks: [{ price: upQuote.price, size: 50 }] }, nowMs + 10);
  await strategy.onBookUpdate('btc-updown-5m', books, nowMs + 10);
  await strategy.tick(books, nowMs + 20);
  const pair = [...ledger.pairs.values()].find((p) => p.source === 'maker');
  assert.equal(pair.state, 'UNWOUND');
  assert.ok(pair.unwindUsdc > 0);
});

// ---------- sellside ----------

test('sellside: rich pair -> split on signal -> sell both legs', async () => {
  const { strategy, books, ledger, ctf, nowMs } = world({ bidUp: 0.93, bidDown: 0.12, askUp: 0.96, askDown: 0.15 });
  await strategy.sellside.onBookUpdate('btc-updown-5m', books, nowMs, null);
  const pair = [...ledger.pairs.values()].find((p) => p.source === 'sellside');
  assert.ok(pair, 'sellside pair opened');
  assert.equal(ctf.ops.filter((o) => o.op === 'split').length, 1);
  assert.ok(pair.sellsUsdc > pair.splitsUsdc, `sold ${pair.sellsUsdc} above the $${pair.splitsUsdc} split`);
  assert.equal(pair.qty.up, 0);
  assert.equal(pair.qty.down, 0);
  assert.ok(pair.realizedPnl > 0);
});

test('sellside: window roll merges leftover inventory back', async () => {
  const { strategy, books, ledger, mkt } = world();
  // Pre-split inventory that only partially sold: 10 pairs held, 4 Up sold.
  const pair = ledger.openPair({
    source: 'sellside', series: 'btc-updown-5m', window: mkt.slug, windowEndMs: mkt.windowEndMs,
    conditionId: mkt.conditionId, upToken: 'UP', downToken: 'DOWN', meta: {},
  });
  ledger.bookSplit(pair.id, { shares: 10, usdc: 10 });
  ledger.bookSell(pair.id, 'up', { shares: 4, usdc: 3.8 });
  strategy.sellside.inv.set('btc-updown-5m', { pairId: pair.id, window: mkt.slug });
  await strategy.onWindowRoll('btc-updown-5m', books); // queues min(6,10)=6 + flushes
  assert.equal(pair.mergesUsdc, 6, 'leftover pairs merged back');
  assert.deepEqual(pair.qty, { up: 0, down: 4 }); // Down singles ride to resolution
});

// ---------- strategy integration ----------

test('strategy: taker MATCHED pair is auto-merged to cash via the batcher', async () => {
  const { strategy, books, ledger, nowMs } = world({ askUp: 0.85, askDown: 0.10, bidUp: 0.84, bidDown: 0.08 });
  await strategy.onBookUpdate('btc-updown-5m', books, nowMs);
  await new Promise((r) => setTimeout(r, 30));
  const pair = [...ledger.pairs.values()].find((p) => p.source === 'taker');
  assert.ok(pair, 'taker fired');
  assert.ok(strategy.batcher.pending > 0, 'merge queued');
  await strategy.batcher.flush();
  assert.equal(pair.state, 'MERGED');
  assert.ok(pair.realizedPnl > 0, `merged pair banks the edge: ${pair.realizedPnl}`);
});

test('strategy: modules can be disabled via config', () => {
  const { c, observer, books, ledger, venue, ctf } = world();
  c.trader.modules = ['taker'];
  const s = new Strategy({ cfg: c, observer, venue, ledger, ctf, log: () => {} });
  assert.ok(s.taker);
  assert.equal(s.maker, null);
  assert.equal(s.sellside, null);
  assert.equal(s.allocator, null);
});

// ---------- bug regression tests ----------

test('maker: attempt keeps using its PINNED market after a window roll', async () => {
  const { strategy, books, venue, ledger, observer, nowMs } = world({
    bidUp: 0.50, bidDown: 0.45, askDown: 0.60, trader: { leashSec: 0 },
  });
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  const upQuote = [...venue.resting.values()].find((o) => o.tokenId === 'UP');
  books.get('UP').applySnapshot({ bids: [{ price: 0.49, size: 50 }], asks: [{ price: upQuote.price, size: 50 }] }, nowMs + 10);
  await strategy.onBookUpdate('btc-updown-5m', books, nowMs + 10);
  const pair = [...ledger.pairs.values()].find((p) => p.source === 'maker');
  // Window rolls: observer now points at a NEW market with different tokens.
  observer.setMarket('btc-updown-5m', {
    series: 'btc-updown-5m', slug: 'btc-updown-5m-200', windowStartMs: nowMs, windowEndMs: nowMs + 540_000,
    conditionId: '0xnew', upToken: 'UP2', downToken: 'DOWN2', feeSchedule: FEES, minOrderSize: 5, tickSize: 0.01,
  });
  await strategy.tick(books, nowMs + 20); // leash cut fires against the OLD tokens
  assert.equal(pair.window, 'btc-updown-5m-100');
  assert.equal(pair.state, 'UNWOUND'); // sold the OLD Up token it actually holds
  assert.ok(!ledger.pairs.size || [...ledger.pairs.values()].every((p) => p.upToken !== 'UP2'), 'never touched new tokens');
});

test('maker: fill for a just-replaced order id still books (cancel/fill race)', async () => {
  const { strategy, books, venue, ledger, nowMs } = world({ bidUp: 0.50, bidDown: 0.45, askDown: 0.47 });
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  const upQuote = [...venue.resting.values()].find((o) => o.tokenId === 'UP');
  // The maker re-quotes (old order cancelled) — then the OLD order's fill arrives.
  await strategy.maker._cancelQuotes('btc-updown-5m');
  const handled = await strategy.maker.onFill(
    { orderId: upQuote.orderId, tokenId: 'UP', price: upQuote.price, shares: 5, usdc: 5 * upQuote.price },
    books, nowMs + 5,
  );
  assert.equal(handled, true, 'stale-order fill must not be dropped');
  const pair = [...ledger.pairs.values()].find((p) => p.source === 'maker');
  assert.ok(pair);
  assert.equal(pair.qty.up > 0 || pair.qty.down > 0 || pair.state === 'MATCHED', true);
});

test('ledger: stale IN_FLIGHT reservations are released by the GC', () => {
  const { ledger } = world();
  const p = ledger.openPair({
    source: 'taker', series: 'btc-updown-5m', window: 'w', windowEndMs: 0,
    conditionId: '0xc', upToken: 'UP', downToken: 'DOWN', meta: {}, estUsdc: 9.5,
  });
  assert.equal(ledger.committedUsdc(), 9.5);
  assert.equal(ledger.expireStaleReservations(Date.now() + 60_000).length, 0, 'young reservations survive');
  const expired = ledger.expireStaleReservations(Date.now() + 200_000);
  assert.equal(expired.length, 1);
  assert.equal(p.state, 'SCRATCH');
  assert.equal(ledger.committedUsdc(), 0);
  // A pair with real fills is never GC'd.
  const q = ledger.openPair({ source: 'taker', series: 'btc-updown-5m', window: 'w2', windowEndMs: 0, conditionId: '0xc', upToken: 'UP', downToken: 'DOWN', meta: {}, estUsdc: 5 });
  ledger.bookBuy(q.id, 'up', { shares: 5, usdc: 2.5 });
  assert.equal(ledger.expireStaleReservations(Date.now() + 200_000).length, 0);
});

test('maker: skew leg sizes never fall below the exchange minimum', () => {
  const { strategy } = world();
  strategy.skew.kappa = 0.85; // force active
  Object.defineProperty(strategy.skew, 'active', { get: () => true });
  const sizes = strategy.maker.legSizes(0.7, 5);
  assert.ok(sizes.up >= 5 && sizes.down >= 5, JSON.stringify(sizes));
});

test('maker: concurrent drives never double-fire the completion-take', async () => {
  const { strategy, books, venue, ledger, nowMs } = world({ bidUp: 0.50, bidDown: 0.45, askDown: 0.47 });
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  const upQuote = [...venue.resting.values()].find((o) => o.tokenId === 'UP');
  books.get('UP').applySnapshot({ bids: [{ price: 0.49, size: 50 }], asks: [{ price: upQuote.price, size: 50 }] }, nowMs + 10);
  // Slow the completion buy down so a second drive can race into it.
  const realBuy = venue.buyFAK.bind(venue);
  venue.buyFAK = async (a) => { await new Promise((r) => setTimeout(r, 20)); return realBuy(a); };
  await Promise.all([
    strategy.onBookUpdate('btc-updown-5m', books, nowMs + 10),
    strategy.onBookUpdate('btc-updown-5m', books, nowMs + 11),
    strategy.tick(books, nowMs + 12),
  ]);
  const pair = [...ledger.pairs.values()].find((p) => p.source === 'maker');
  assert.ok(pair.qty.down <= pair.qty.up, `over-hedged: ${JSON.stringify(pair.qty)}`);
  const completionBuys = pair.fills.filter((f) => f.op === 'buy' && f.side === 'down');
  assert.ok(completionBuys.length <= 1, `completion fired ${completionBuys.length} times`);
});

test('sellside: self-trade guard runs BEFORE any split (no orphaned inventory)', async () => {
  const { strategy, books, ledger, ctf, nowMs } = world({ bidUp: 0.93, bidDown: 0.12, askUp: 0.96, askDown: 0.15 });
  strategy.sellside.ownBidAtBest = () => true; // our maker bid is at best
  await strategy.sellside.onBookUpdate('btc-updown-5m', books, nowMs, null);
  assert.equal(ctf.ops.filter((o) => o.op === 'split').length, 0, 'no capital moved');
  assert.equal(ledger.pairs.size, 0, 'no pair opened');
});

test('sellside: split-on-signal inventory is registered even after partial sells', async () => {
  const { strategy, books, ledger, nowMs } = world({ bidUp: 0.93, bidDown: 0.12, askUp: 0.96, askDown: 0.15 });
  // Force partials on BOTH legs so mergeable pairs remain: Up fills 4 of 9,
  // Down fills nothing.
  strategy.venue.sellFAK = async (a) => (a.tokenId === 'UP'
    ? { ok: true, filledShares: 4, usdc: 4 * 0.93, avgPrice: 0.93, ackMs: 0 }
    : { ok: true, filledShares: 0, usdc: 0, avgPrice: null, ackMs: 0 });
  await strategy.sellside.onBookUpdate('btc-updown-5m', books, nowMs, null);
  const pair = [...ledger.pairs.values()].find((p) => p.source === 'sellside');
  assert.ok(pair.qty.up > 0 && pair.qty.down > 0, 'leftover inventory on both legs');
  assert.equal(strategy.sellside.inv.get('btc-updown-5m').pairId, pair.id, 'inventory registered');
  await strategy.onWindowRoll('btc-updown-5m', books);
  assert.ok(pair.mergesUsdc >= 5, `mergeable leftovers merged back at roll: ${pair.mergesUsdc}`);
});

test('ledger: late merge on a terminal pair never double-books', () => {
  const { ledger } = world();
  const p = ledger.openPair({ source: 'taker', series: 's', window: 'w', windowEndMs: 0, conditionId: '0xc', upToken: 'U', downToken: 'D', meta: {} });
  ledger.bookBuy(p.id, 'up', { shares: 5, usdc: 2.5 });
  ledger.bookBuy(p.id, 'down', { shares: 5, usdc: 2.4 });
  ledger.bookResolution(p.id, 'Up');
  const realizedBefore = p.realizedPnl;
  ledger.bookMerge(p.id, { shares: 5, usdc: 5 }); // stale flush after resolution
  assert.equal(p.realizedPnl, realizedBefore);
  assert.equal(p.mergesUsdc, 0);
  assert.equal(p.skippedMerges, 1);
});

test('ledger: float-dust fills still classify as MATCHED', () => {
  const { ledger } = world();
  const p = ledger.openPair({ source: 'taker', series: 's', window: 'w', windowEndMs: 0, conditionId: '0xc', upToken: 'U', downToken: 'D', meta: {} });
  ledger.bookBuy(p.id, 'up', { shares: 1.1, usdc: 0.5 });
  ledger.bookBuy(p.id, 'up', { shares: 3.9, usdc: 1.9 });   // 1.1+3.9 = 5.000000000000001 raw
  ledger.bookBuy(p.id, 'down', { shares: 5, usdc: 0.5 });
  assert.equal(p.qty.up, 5);
  assert.equal(p.state, 'MATCHED');
});

test('ledger: pair ids continue across restarts (journal readers dedupe by id)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-jr-'));
  const l1 = new PairLedger({ maxActiveUsdc: 10, maxPairsPerWindow: 9, dataDir: dir });
  l1.openPair({ source: 'taker', series: 's', window: 'w', windowEndMs: 0, conditionId: '0xc', upToken: 'U', downToken: 'D', meta: {} });
  l1.openPair({ source: 'taker', series: 's', window: 'w', windowEndMs: 0, conditionId: '0xc', upToken: 'U', downToken: 'D', meta: {} });
  // appendFile is async — give the journal a beat, then "restart".
  return new Promise((resolve) => setTimeout(() => {
    const l2 = new PairLedger({ maxActiveUsdc: 10, maxPairsPerWindow: 9, dataDir: dir });
    const p = l2.openPair({ source: 'taker', series: 's', window: 'w2', windowEndMs: 0, conditionId: '0xc', upToken: 'U', downToken: 'D', meta: {} });
    assert.ok(p.id >= 3, `new run must not reuse ids: got ${p.id}`);
    resolve();
  }, 100));
});

test('maker: resting exposure counts against the active-USDC cap', async () => {
  const { strategy, books, nowMs, c } = world({ bidUp: 0.53, bidDown: 0.45 });
  c.detector.maxActiveUsdc = 5; // two ~$2.45 bids would exceed this on a second series
  strategy.maker.state.set('other-series', {
    quotes: { up: { orderId: 'x', price: 0.5, size: 5, tokenId: 'OTHER' }, down: { orderId: 'y', price: 0.45, size: 5, tokenId: 'OTHER2' } },
    attempt: null, lastQuoteMs: 0,
  });
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  const st = strategy.maker.state.get('btc-updown-5m');
  assert.ok(!st.quotes.up && !st.quotes.down, 'must not quote past the fill-everything cap');
});

test('maker: never posts a lone bid whose completion is impossible', async () => {
  // Mid 0.85 -> Down bid pulled; lone Up bid at ~0.83 would need askDown <= 0.16
  // to ever complete. askDown is 0.19 -> no quote at all.
  const { strategy, books, venue, nowMs } = world({ bidUp: 0.83, askUp: 0.87, bidDown: 0.10, askDown: 0.19 });
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  assert.equal(venue.resting.size, 0, 'naked directional quote must not rest');
  // Tight ask (0.14): completion plausible -> the lone Up bid may rest.
  books.get('DOWN').applySnapshot({ bids: [{ price: 0.10, size: 50 }], asks: [{ price: 0.14, size: 50 }] }, nowMs + 1);
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs + strategy.cfg?.trader?.requoteMs ?? 2000, null);
  assert.equal([...venue.resting.values()].filter((o) => o.tokenId === 'UP').length, 1);
});

test('maker: losing cut triggers a per-series cooldown', async () => {
  const { strategy, books, venue, ledger, nowMs, c } = world({
    bidUp: 0.50, bidDown: 0.45, askDown: 0.60, trader: { leashSec: 0 },
  });
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  const upQuote = [...venue.resting.values()].find((o) => o.tokenId === 'UP');
  books.get('UP').applySnapshot({ bids: [{ price: 0.49, size: 50 }], asks: [{ price: upQuote.price, size: 50 }] }, nowMs + 10);
  await strategy.onBookUpdate('btc-updown-5m', books, nowMs + 10);
  await strategy.tick(books, nowMs + 20); // leash cut at a loss
  const pair = [...ledger.pairs.values()].find((p) => p.source === 'maker');
  assert.equal(pair.state, 'UNWOUND');
  assert.ok(pair.realizedPnl < 0);
  const st = strategy.maker.state.get('btc-updown-5m');
  assert.ok(st.cooldownUntil > Date.now() + 50_000, 'cooldown armed');
  // During cooldown: no re-quote even though books allow it.
  books.get('UP').applySnapshot({ bids: [{ price: 0.50, size: 50 }], asks: [{ price: 0.52, size: 50 }] }, nowMs + 30);
  await strategy.maker.onBookUpdate('btc-updown-5m', books, Date.now() + 5_000, null);
  assert.equal(venue.resting.size, 0, 'no quotes during cooldown');
});

test('skew active: worst-case loss cap blocks quoting when the hedge is too small', async () => {
  const { strategy, books, venue, nowMs, c } = world({ bidUp: 0.60, bidDown: 0.35, askUp: 0.62 });
  // Force skew active at κ=0.85 with a tiny loss cap.
  strategy.skew.kappa = 0.85;
  Object.defineProperty(strategy.skew, 'active', { get: () => true });
  strategy.skew.maxLossUsdc = 0.5; // 8 dom @~0.60 + 5 hedge @~0.35 -> worst ≈ -1.55 > 0.5
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  assert.equal(venue.resting.size, 0, 'entry blocked by the worst-case cap');
  strategy.skew.maxLossUsdc = 5; // now it fits
  const st = strategy.maker.state.get('btc-updown-5m');
  st.lastQuoteMs = 0;
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs + 1, null);
  assert.ok(venue.resting.size > 0, 'entry allowed under the cap');
});

test('maker: a rejected post is recorded and never becomes a phantom quote', async () => {
  const { strategy, books, nowMs } = world({ bidUp: 0.53, bidDown: 0.45 });
  // Venue rejects every GTC (insufficient balance / allowances / auth).
  strategy.maker.venue.postGTC = async () => ({ ok: false, orderId: null, status: 'error', error: 'not enough balance/allowance' });
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  const st = strategy.maker.state.get('btc-updown-5m');
  assert.ok(!st.quotes.up && !st.quotes.down, 'a rejected post must not be tracked as resting');
  const s = strategy.maker.stats();
  assert.equal(s.quotes, 0);
  assert.equal(s.postRejects['not enough balance/allowance'], 2, 'both legs recorded');
  assert.equal(s.lastPostError.why, 'not enough balance/allowance');
});

test('maker: ok-but-null-orderId is treated as a rejection, not a quote', async () => {
  const { strategy, books, nowMs } = world({ bidUp: 0.53, bidDown: 0.45 });
  // Fills route by order id — an order we cannot address is worse than none.
  strategy.maker.venue.postGTC = async () => ({ ok: true, orderId: null, status: 'live', error: null });
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  const st = strategy.maker.state.get('btc-updown-5m');
  assert.ok(!st.quotes.up && !st.quotes.down, 'unaddressable order must not be tracked');
  assert.ok(strategy.maker.stats().postRejects['accepted but no orderId returned'] > 0);
});

test('maker: own band keeps quotes out of the tails', async () => {
  const { strategy, books, venue, nowMs, c } = world({ bidUp: 0.85, askUp: 0.87, bidDown: 0.10, askDown: 0.13 });
  c.trader.makerBandMin = 0.25; c.trader.makerBandMax = 0.75;
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  assert.equal(venue.resting.size, 0, 'no quotes at 0.85/0.10 under a 0.25-0.75 band');
});

test('maker: volatility breaker pulls quotes during a fast move', async () => {
  const { strategy, books, venue, nowMs, c } = world({ bidUp: 0.50, bidDown: 0.45 });
  c.trader.makerMaxMove = 0.03;
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  assert.ok(venue.resting.size > 0, 'quotes rest in a calm market');
  // Mid jumps 6c inside the window -> breaker trips, quotes pulled.
  books.get('UP').applySnapshot({ bids: [{ price: 0.56, size: 50 }], asks: [{ price: 0.61, size: 50 }] }, nowMs + 2000);
  const st = strategy.maker.state.get('btc-updown-5m');
  st.lastQuoteMs = 0;
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs + 2000, null);
  assert.equal(venue.resting.size, 0, 'quotes pulled on the move');
  assert.equal(st.volPaused, true);
});

test('maker: hard stop cuts a bleeding lone leg before the leash expires', async () => {
  const { strategy, books, venue, ledger, nowMs, c } = world({ bidUp: 0.50, bidDown: 0.45, askDown: 0.60 });
  c.trader.leashSec = 60; // leash far away (vs the 0.5s stop) but inside the tau guard
  c.trader.makerStop = 0.05;
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  const upQuote = [...venue.resting.values()].find((o) => o.tokenId === 'UP');
  books.get('UP').applySnapshot({ bids: [{ price: 0.49, size: 50 }], asks: [{ price: upQuote.price, size: 50 }] }, nowMs + 10);
  await strategy.onBookUpdate('btc-updown-5m', books, nowMs + 10); // fill -> attempt opens
  const pair = [...ledger.pairs.values()].find((p) => p.source === 'maker');
  assert.equal(pair.state, 'PARTIAL');
  // Bid collapses 7c below our fill -> stop fires immediately.
  books.get('UP').applySnapshot({ bids: [{ price: upQuote.price - 0.07, size: 50 }], asks: [{ price: 0.60, size: 50 }] }, nowMs + 500);
  await strategy.tick(books, nowMs + 500);
  assert.equal(pair.state, 'UNWOUND', 'cut long before the 300s leash');
  assert.ok(pair.realizedPnl < 0 && pair.realizedPnl > -0.5, `bounded loss: ${pair.realizedPnl}`);
});

test('maker: attempt opening cancels every resting quote (no mid-attempt refills)', async () => {
  const { strategy, books, venue, nowMs } = world({ bidUp: 0.50, bidDown: 0.45, askDown: 0.60 });
  await strategy.maker.onBookUpdate('btc-updown-5m', books, nowMs, null);
  assert.equal(venue.resting.size, 2);
  const upQuote = [...venue.resting.values()].find((o) => o.tokenId === 'UP');
  books.get('UP').applySnapshot({ bids: [{ price: 0.49, size: 50 }], asks: [{ price: upQuote.price, size: 50 }] }, nowMs + 10);
  await strategy.onBookUpdate('btc-updown-5m', books, nowMs + 10);
  assert.equal(venue.resting.size, 0, 'all quotes cancelled the moment the attempt opened');
});

test('skew: UTF-16 calibration file (PowerShell default) still verifies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-skew-'));
  fs.writeFileSync(path.join(dir, 'calibration.json'),
    Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('{"verified": true}', 'utf16le')]));
  const s = new Skew({ kappa: 0.75, maxLossUsdc: 3, dataDir: dir });
  assert.equal(s.kappa, 0.75);
});
