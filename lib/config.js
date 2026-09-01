'use strict';

// Config loader: tiny .env parser (no dotenv dependency) + typed defaults from
// plan §7, + the runtime collision assert from the risk register ("runtime
// assert, not a comment").

const fs = require('node:fs');
const path = require('node:path');

function loadDotEnv(dir) {
  const file = path.join(dir, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    // Quoted values are taken verbatim (a # inside quotes is data); unquoted
    // values drop inline comments — .env.example ships with them.
    const quoted = value.match(/^(["'])(.*)\1/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function num(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name}=${v} is not a number`);
  return n;
}

function parseConfig({ argv = process.argv } = {}) {
  loadDotEnv(process.cwd());

  const mode = argv.includes('--observe') ? 'observe'
    : argv.includes('--dry') ? 'dry'
    : argv.includes('--live') ? 'live'
    : (process.env.ARB_MODE || 'observe');
  if (!['observe', 'dry', 'live'].includes(mode)) {
    throw new Error(`ARB_MODE=${mode} — must be observe | dry | live`);
  }
  const series = (process.env.ARB_SERIES ||
    'btc-updown-5m,eth-updown-5m,sol-updown-5m,xrp-updown-5m,doge-updown-5m,' +
    'btc-updown-15m,eth-updown-15m,sol-updown-15m,xrp-updown-15m,doge-updown-15m')
    .split(',').map((s) => s.trim()).filter(Boolean);

  // Risk-register assert: this bot must never trade the updown bot's series.
  const updownPrefix = (process.env.UPDOWN_SLUG_PREFIX || '').trim();
  if (updownPrefix) {
    const clash = series.filter((s) => s.startsWith(updownPrefix) || updownPrefix.startsWith(s));
    if (clash.length) {
      throw new Error(
        `REFUSING TO START: ARB_SERIES overlaps UPDOWN_SLUG_PREFIX="${updownPrefix}": ${clash.join(', ')}. ` +
        'The two bots would compete with and unwind into each other.');
    }
  }

  return {
    mode,
    series,
    // Fee assumption: 'schedule' prices the gamma crypto_fees_v2 curve into
    // every edge; 'zero' trusts the live verification (2026-09-01: 102 real
    // fills, all charged fee_rate_bps=0). Re-verify after any exchange fee
    // announcement — 'zero' with fees ON would overstate every edge.
    feeMode: (process.env.ARB_FEE_MODE || 'schedule').toLowerCase(),
    detector: {
      buySum: num('ARB_BUY_SUM', 0.985),
      sellSum: num('ARB_SELL_SUM', 1.015),
      shares: num('ARB_SHARES', 5),
      maxActiveUsdc: num('ARB_MAX_ACTIVE_USDC', 10),
      minTauSec: num('ARB_MIN_TAU_SEC', 20),
      freshnessMs: num('ARB_FRESHNESS_MS', 1000),
      minDepth: num('ARB_MIN_DEPTH', 5),
      priceBandMin: num('ARB_PRICE_BAND_MIN', 0.01),
      priceBandMax: num('ARB_PRICE_BAND_MAX', 0.99),
    },
    trader: {
      modules: (process.env.ARB_MODULES || 'taker,maker,sellside,allocator,skew')
        .split(',').map((s) => s.trim()).filter(Boolean),
      maxPairsPerWindow: num('ARB_MAX_PAIRS_PER_WINDOW', 2),
      rearmMs: num('ARB_REARM_MS', 1500),        // pause after an attempt before re-firing a series
      unwindRetries: num('ARB_UNWIND_RETRIES', 3),
      // Max fee rate (bps) signed into orders. The exchange charges
      // min(actual, signed); too-low values get orders rejected. Observed
      // taker_base_fee on updown markets: 1000.
      feeRateBps: num('ARB_FEE_RATE_BPS', 1000),
      // maker module
      postSum: num('ARB_POST_SUM', 0.98),          // resting bids priced so the pair sum clears this
      completeMaxSum: num('ARB_COMPLETE_MAX_SUM', 0.99), // completion-take ceiling after a lone fill
      leashSec: num('ARB_LEASH_SEC', 15),          // sell-back leash after a lone fill
      requoteMs: num('ARB_REQUOTE_MS', 1000),      // min interval between re-quotes per series
      makerCooldownSec: num('ARB_MAKER_COOLDOWN_SEC', 60), // quiet period per series after a losing cut
      // Maker's own price band: never quote the tails — completion there needs
      // a sub-5c hedge fill (impossible) and adverse moves are violent.
      makerBandMin: num('ARB_MAKER_BAND_MIN', 0.25),
      makerBandMax: num('ARB_MAKER_BAND_MAX', 0.75),
      // Volatility breaker: pull quotes when the mid moved more than this in
      // the lookback window (live pair 7 lost 30c/share to one such move).
      makerMaxMove: num('ARB_MAKER_MAX_MOVE', 0.03),
      makerMoveWindowSec: num('ARB_MAKER_MOVE_WINDOW_SEC', 10),
      // Hard stop on a lone leg: cut immediately when the bid falls this far
      // below our fill, never wait out the full leash.
      makerStop: num('ARB_MAKER_STOP', 0.05),
      // sell-side module
      presplitUsdc: num('ARB_PRESPLIT_USDC', 0),   // per series per window; 0 = split on signal only
      // ctf
      mergeCostUsdc: num('ARB_MERGE_COST_USDC', 0.01), // simulated per-tx cost in dry runs
      mergeFlushSec: num('ARB_MERGE_FLUSH_SEC', 30),
      // skew dial — pinned to 0.50 unless data/calibration.json is verified
      skew: num('ARB_SKEW', 0.5),
      maxLossUsdc: num('ARB_MAX_LOSS_USDC', 3),
    },
    observer: {
      minEventMs: num('ARB_OBS_MIN_EVENT_MS', 300),  // gate counts events >= this duration
      gateEventsPerDay: num('ARB_OBS_GATE_PER_DAY', 20),
      sampleIntervalMs: num('ARB_OBS_SAMPLE_MS', 1000),
      xtfDivergence: num('ARB_OBS_XTF_DIV', 0.15),   // |mid15 - mid5| to log a divergence event
      nearResWindowSec: num('ARB_OBS_NEARRES_SEC', 30),
    },
    verbose: process.env.ARB_VERBOSE === '1' || process.env.ARB_VERBOSE === 'true',
    dataDir: process.env.ARB_DATA_DIR || path.join(process.cwd(), 'data'),
    dashPort: num('ARB_DASH_PORT', 3210),
    gammaBase: process.env.ARB_GAMMA_BASE || 'https://gamma-api.polymarket.com',
    clobBase: process.env.ARB_CLOB_BASE || 'https://clob.polymarket.com',
    clobWs: process.env.ARB_CLOB_WS || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    // Debug-only REST book polling for machines where the CLOB ws is blocked
    // (the Mac). 1 Hz sampling ALIASES sub-second events — never valid for the
    // go/no-go gate; it exists only to smoke-test plumbing.
    restPoll: argv.includes('--rest-poll'),
  };
}

module.exports = { parseConfig };
