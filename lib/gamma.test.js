'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gamma = require('./gamma');
const { parseConfig } = require('./config');

test('parseSeries: asset + timeframe', () => {
  assert.deepEqual(gamma.parseSeries('btc-updown-5m'), { asset: 'btc', tfSec: 300 });
  assert.deepEqual(gamma.parseSeries('doge-updown-15m'), { asset: 'doge', tfSec: 900 });
  assert.throws(() => gamma.parseSeries('btc-5m'));
});

test('windowStartSec aligns to the timeframe', () => {
  // 1788205500 is a real live slug timestamp (btc-updown-5m, 19:45:00Z).
  assert.equal(gamma.windowStartSec(300, 1788205712 * 1000), 1788205500);
  assert.equal(gamma.windowStartSec(900, 1788205712 * 1000), 1788205500);
  assert.equal(gamma.windowSlug('btc-updown-5m', 1788205500), 'btc-updown-5m-1788205500');
});

test('config: refuses to start when ARB_SERIES overlaps UPDOWN_SLUG_PREFIX', () => {
  const oldEnv = { ...process.env };
  try {
    process.env.UPDOWN_SLUG_PREFIX = 'btc-updown-5m';
    process.env.ARB_SERIES = 'btc-updown-5m,eth-updown-5m';
    assert.throws(() => parseConfig({ argv: [] }), /REFUSING TO START/);
  } finally {
    process.env = oldEnv;
  }
});

test('config: starts clean when series are disjoint', () => {
  const oldEnv = { ...process.env };
  try {
    process.env.UPDOWN_SLUG_PREFIX = 'btc-updown-1h';
    process.env.ARB_SERIES = 'eth-updown-5m';
    const cfg = parseConfig({ argv: ['node', 'arb-bot.js', '--observe'] });
    assert.equal(cfg.mode, 'observe');
    assert.deepEqual(cfg.series, ['eth-updown-5m']);
    assert.equal(cfg.detector.buySum, 0.985);
  } finally {
    process.env = oldEnv;
  }
});
