'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PairLedger } = require('./ledger');

function ledger(over = {}) {
  return new PairLedger({ maxActiveUsdc: 10, maxPairsPerWindow: 2, dataDir: null, ...over });
}

function open(l, over = {}) {
  return l.openPair({
    series: 'btc-updown-5m', window: 'btc-updown-5m-100', windowEndMs: 1_000_000,
    upToken: 'UP', downToken: 'DOWN', askUp: 0.85, askDown: 0.10,
    clip: 10, expectedFees: 0.02, tDetect: 900_000, ...over,
  });
}

const fill = (shares, usdc) => ({ filledShares: shares, usdc, ackMs: 50 });

test('both legs fill -> MATCHED, committed = actual spend', () => {
  const l = ledger();
  const p = open(l);
  l.bookLegs(p.id, fill(10, 8.5), fill(10, 1.0), { detectToPost: 1, detectToLastAck: 60 });
  assert.equal(p.state, 'MATCHED');
  assert.equal(p.matchedShares, 10);
  assert.equal(p.excess, null);
  assert.equal(l.committedUsdc(), 9.5);
});

test('resolution of a matched pair pays $1/share regardless of outcome', () => {
  const l = ledger();
  const p = open(l);
  l.bookLegs(p.id, fill(10, 8.5), fill(10, 1.0), {});
  l.bookResolution(p.id, 'Down');
  assert.equal(p.state, 'RESOLVED');
  assert.equal(p.redeemUsdc, 10);
  assert.equal(p.realizedPnl, 0.5); // 10 - 9.5
  assert.equal(l.committedUsdc(), 0);
});

test('neither fills -> SCRATCH, zero committed, zero pnl', () => {
  const l = ledger();
  const p = open(l);
  l.bookLegs(p.id, fill(0, 0), fill(0, 0), {});
  assert.equal(p.state, 'SCRATCH');
  assert.equal(p.realizedPnl, 0);
  assert.equal(l.committedUsdc(), 0);
});

test('one-legged fill -> PARTIAL with excess, full unwind -> UNWOUND with loss booked', () => {
  const l = ledger();
  const p = open(l);
  l.bookLegs(p.id, fill(10, 8.5), fill(0, 0), {}); // only Up filled at 0.85
  assert.equal(p.state, 'PARTIAL');
  assert.deepEqual({ tok: p.excess.tokenId, sh: p.excess.shares }, { tok: 'UP', sh: 10 });
  l.bookUnwind(p.id, { shares: 10, usdc: 8.2 }); // sold back at 0.82
  assert.equal(p.state, 'UNWOUND');
  assert.equal(p.realizedPnl, -0.3);
  assert.equal(p.unwindLossUsdc, 0.3);
  assert.equal(l.committedUsdc(), 0);
});

test('partial imbalance: matched core survives the unwind and resolves', () => {
  const l = ledger();
  const p = open(l);
  l.bookLegs(p.id, fill(10, 8.5), fill(6, 0.6), {}); // 6 matched, 4 Up excess
  assert.equal(p.state, 'PARTIAL');
  assert.equal(p.matchedShares, 6);
  assert.equal(p.excess.shares, 4);
  l.bookUnwind(p.id, { shares: 4, usdc: 3.3 }); // excess cost 4*0.85=3.4, sold 3.3
  assert.equal(p.state, 'MATCHED'); // core rides to resolution
  assert.equal(p.unwindLossUsdc, 0.1);
  l.bookResolution(p.id, 'Up');
  assert.equal(p.redeemUsdc, 6);
  // pnl = redeem 6 + unwind 3.3 - buys 9.1 = 0.2
  assert.equal(p.realizedPnl, 0.2);
});

test('stranded excess on the winning side redeems at $1', () => {
  const l = ledger();
  const p = open(l);
  l.bookLegs(p.id, fill(10, 8.5), fill(6, 0.6), {});
  l.markStranded(p.id, 'below min size');
  l.bookResolution(p.id, 'Up');
  assert.equal(p.redeemUsdc, 10); // 6 matched + 4 excess Up winners
  assert.equal(p.realizedPnl, 0.9); // 10 - 9.1
});

test('stranded excess on the losing side redeems nothing', () => {
  const l = ledger();
  const p = open(l);
  l.bookLegs(p.id, fill(10, 8.5), fill(6, 0.6), {});
  l.markStranded(p.id, 'below min size');
  l.bookResolution(p.id, 'Down');
  assert.equal(p.redeemUsdc, 6);
  assert.equal(p.realizedPnl, -3.1);
});

test('caps: pairs-per-window and active-USDC are enforced', () => {
  const l = ledger();
  assert.equal(l.canOpen('s', 'w', 5).ok, true);
  const a = open(l, { series: 's', window: 'w' });
  const b = open(l, { series: 's', window: 'w' });
  assert.match(l.canOpen('s', 'w', 1).why, /pairs-per-window/);
  // Even IN_FLIGHT pairs commit their estimate: two $9.5 opens breach the cap.
  assert.match(l.canOpen('s', 'w2', 1).why, /active-USDC/);
  l.bookLegs(a.id, fill(0, 0), fill(0, 0), {}); // scratches release the estimate
  l.bookLegs(b.id, fill(0, 0), fill(0, 0), {});
  assert.equal(l.canOpen('s', 'w2', 1).ok, true);
  // Commit $9.5 on an open pair; a further $1 breaches the $10 cap.
  const p = l.openPair({ series: 's', window: 'w2', windowEndMs: 0, upToken: 'U', downToken: 'D', askUp: 0.85, askDown: 0.10, clip: 10, expectedFees: 0, tDetect: 0 });
  l.bookLegs(p.id, fill(10, 8.5), fill(10, 1.0), {});
  assert.match(l.canOpen('s', 'w3', 1).why, /active-USDC/);
});

test('stats decomposition adds up', () => {
  const l = ledger();
  const p1 = open(l);
  l.bookLegs(p1.id, fill(10, 8.5), fill(10, 1.0), {});
  l.bookResolution(p1.id, 'Up');
  const p2 = open(l, { window: 'btc-updown-5m-200' });
  l.bookLegs(p2.id, fill(10, 8.5), fill(0, 0), {});
  l.bookUnwind(p2.id, { shares: 10, usdc: 8.2 });
  const s = l.stats();
  assert.equal(s.realizedPnl, 0.2); // +0.5 - 0.3
  assert.equal(s.decomposition.redeems, 10);
  assert.equal(s.decomposition.buys, 18);
  assert.equal(s.decomposition.unwindProceeds, 8.2);
  assert.equal(s.decomposition.unwindLosses, 0.3);
  assert.equal(s.counts.RESOLVED, 1);
  assert.equal(s.counts.UNWOUND, 1);
});

test('pendingResolutions returns holders past window end + grace', () => {
  const l = ledger();
  const p = open(l, { windowEndMs: 1000 });
  l.bookLegs(p.id, fill(10, 8.5), fill(10, 1.0), {});
  assert.equal(l.pendingResolutions(1000 + 89_000).length, 0);
  assert.equal(l.pendingResolutions(1000 + 91_000).length, 1);
  l.bookResolution(p.id, 'Up');
  assert.equal(l.pendingResolutions(1000 + 91_000).length, 0);
});
