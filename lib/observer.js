'use strict';

// Phase 0 observer (plan §5 Phase 0): measures whether the opportunities exist
// net of fees BEFORE any executor is built.
//
//  - Edge-event detection runs on every websocket book update (push, not on a
//    clock) — the gate cares about events lasting >= 300ms and 1 Hz sampling
//    would alias or miss them.
//  - A once-per-second sampler records askSum/bidSum/depth/fees time series.
//  - The same feeds also record three extra archetypes at zero cost:
//    cross-timeframe divergence, near-resolution pricing, and skew moments.
//
// Output files (append-only ndjson, one directory per plan §8):
//   data/arb-events.jsonl   — one row per opportunity event (open->close)
//   data/arb-samples-YYYYMMDD.jsonl — 1 Hz time series
//   data/arb-status.json    — heartbeat, rewritten every ~3s
//   data/arb-journal.json   — reserved for Phase 1 pair attempts (not written here)

const fs = require('node:fs');
const path = require('node:path');
const core = require('../arb-core');

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

class Observer {
  constructor(cfg) {
    this.cfg = cfg;
    this.dataDir = cfg.dataDir;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.eventsPath = path.join(this.dataDir, 'arb-events.jsonl');
    this.statusPath = path.join(this.dataDir, 'arb-status.json');

    this.startedMs = Date.now();
    this.markets = new Map();     // series -> current market descriptor (from gamma)
    this.open = new Map();        // `${series}:${side}` -> open event state
    this.counters = { buyEvents: 0, sellEvents: 0, buyGateEvents: 0, sellGateEvents: 0, samples: 0, rejects: {} };
    this.gateLog = [];            // {tMs, side} of gate-qualifying events (for /day projection)
    this.nearRes = new Map();     // series -> ring of final-30s snapshots
    this.xtfOpen = new Map();     // asset -> open divergence event
    this.skewLast = new Map();    // series -> last skew log ts (rate limit)
    this.wsState = 'init';
    this.feedMode = 'ws';
  }

  setMarket(series, market) {
    this.markets.set(series, market);
  }

  _append(row) {
    fs.appendFile(this.eventsPath, JSON.stringify(row) + '\n', () => {});
  }

  _appendSample(row) {
    const p = path.join(this.dataDir, `arb-samples-${utcDay(row.t)}.jsonl`);
    fs.appendFile(p, JSON.stringify(row) + '\n', () => {});
  }

  /** Build the detector input for a series from the two live books. */
  snapshot(series, books, nowMs) {
    const mkt = this.markets.get(series);
    if (!mkt) return null;
    const up = books.get(mkt.upToken);
    const down = books.get(mkt.downToken);
    if (!up || !down || !up.hasSnapshot || !down.hasSnapshot) return null;
    const u = up.top();
    const d = down.top();
    return {
      askUp: u.ask, askDown: d.ask, bidUp: u.bid, bidDown: d.bid,
      askUpSize: u.askSize, askDownSize: d.askSize,
      bidUpSize: u.bidSize, bidDownSize: d.bidSize,
      bookTsUpMs: u.tsMs, bookTsDownMs: d.tsMs,
      windowEndMs: mkt.windowEndMs, nowMs,
      feeSchedule: mkt.feeSchedule, minOrderSize: mkt.minOrderSize,
    };
  }

  /** Push path: called on EVERY book update touching this series. */
  onBookUpdate(series, books, nowMs = Date.now()) {
    const input = this.snapshot(series, books, nowMs);
    if (!input) return;
    const r = core.evaluatePair(input, this.cfg.detector);

    for (const side of ['buy', 'sell']) {
      const v = r[side];
      // For the gate we care about the trigger + depth (an event is "the book
      // showed a fee-adjusted, depth-backed opportunity"), regardless of our
      // own tau/cap constraints — those are executor concerns and are recorded
      // on the event row for later slicing.
      const triggered = v.edge !== null && !v.reasons.includes('no-edge')
        && !v.reasons.includes('empty-book') && !v.reasons.includes('stale-book');
      const depthOk = !v.reasons.includes('depth');
      const key = `${series}:${side}`;
      const openEv = this.open.get(key);

      if (triggered && depthOk && !openEv) {
        this.open.set(key, {
          series, side, tOpen: nowMs,
          window: this.markets.get(series)?.slug,
          openSnapshot: {
            askUp: input.askUp, askDown: input.askDown,
            bidUp: input.bidUp, bidDown: input.bidDown,
            askUpSize: input.askUpSize, askDownSize: input.askDownSize,
            bidUpSize: input.bidUpSize, bidDownSize: input.bidDownSize,
          },
          maxEdge: v.edge, minFeeAdjSum: v.feeAdjSum, maxFeeAdjSum: v.feeAdjSum,
          clip: v.clip, execOk: v.ok, tauSecAtOpen: r.tauSec,
        });
      } else if (openEv) {
        if (triggered && depthOk) {
          openEv.maxEdge = Math.max(openEv.maxEdge, v.edge);
          openEv.minFeeAdjSum = Math.min(openEv.minFeeAdjSum, v.feeAdjSum);
          openEv.maxFeeAdjSum = Math.max(openEv.maxFeeAdjSum, v.feeAdjSum);
        } else {
          this._closeEvent(key, openEv, nowMs);
        }
      }

      if (v.edge !== null && !v.ok) {
        for (const reason of v.reasons) {
          this.counters.rejects[reason] = (this.counters.rejects[reason] || 0) + 1;
        }
      }
    }

    // Skew recorder (archetype type 2): any sub-$1 raw ask sum, rate-limited
    // to one row per series per 5s so bait moments don't flood the file.
    if (input.askUp != null && input.askDown != null && input.askUp + input.askDown < 1.0) {
      const last = this.skewLast.get(series) || 0;
      if (nowMs - last > 5000) {
        this.skewLast.set(series, nowMs);
        this._append({
          type: 'skew', t: nowMs, series, window: this.markets.get(series)?.slug,
          askUp: input.askUp, askDown: input.askDown,
          askUpSize: input.askUpSize, askDownSize: input.askDownSize,
          rawSum: core.round6(input.askUp + input.askDown),
        });
      }
    }
  }

  _closeEvent(key, ev, nowMs) {
    this.open.delete(key);
    const durationMs = nowMs - ev.tOpen;
    const gate = durationMs >= this.cfg.observer.minEventMs;
    this.counters[ev.side === 'buy' ? 'buyEvents' : 'sellEvents']++;
    if (gate) {
      this.counters[ev.side === 'buy' ? 'buyGateEvents' : 'sellGateEvents']++;
      this.gateLog.push({ tMs: ev.tOpen, side: ev.side });
      if (this.gateLog.length > 50_000) this.gateLog.splice(0, 10_000);
    }
    this._append({
      type: 'edge-event', t: ev.tOpen, series: ev.series, side: ev.side,
      window: ev.window, durationMs, gateQualifying: gate,
      maxEdge: ev.maxEdge, minFeeAdjSum: ev.minFeeAdjSum, maxFeeAdjSum: ev.maxFeeAdjSum,
      clip: ev.clip, execOk: ev.execOk, tauSecAtOpen: ev.tauSecAtOpen,
      openSnapshot: ev.openSnapshot,
    });
  }

  /** Force-close any open events for a series (window rollover). */
  closeSeriesEvents(series, nowMs = Date.now()) {
    for (const side of ['buy', 'sell']) {
      const key = `${series}:${side}`;
      const ev = this.open.get(key);
      if (ev) this._closeEvent(key, ev, nowMs);
    }
  }

  /** 1 Hz sampler: time-series rows + near-resolution ring + cross-timeframe. */
  sampleAll(books, nowMs = Date.now()) {
    const mids = new Map(); // series -> mid of Up
    for (const [series] of this.markets) {
      const input = this.snapshot(series, books, nowMs);
      if (!input) continue;
      const fees = input.feeSchedule;
      const row = {
        type: 'sample', t: nowMs, series, window: this.markets.get(series)?.slug,
        askUp: input.askUp, askDown: input.askDown, bidUp: input.bidUp, bidDown: input.bidDown,
        askUpSize: input.askUpSize, askDownSize: input.askDownSize,
        bidUpSize: input.bidUpSize, bidDownSize: input.bidDownSize,
        askSum: input.askUp != null && input.askDown != null ? core.round6(input.askUp + input.askDown) : null,
        bidSum: input.bidUp != null && input.bidDown != null ? core.round6(input.bidUp + input.bidDown) : null,
        feeAdjBuySum: input.askUp != null && input.askDown != null
          ? core.round6(core.feeAdjustedBuySum(input.askUp, input.askDown, fees)) : null,
        feeAdjSellSum: input.bidUp != null && input.bidDown != null
          ? core.round6(core.feeAdjustedSellSum(input.bidUp, input.bidDown, fees)) : null,
        tauSec: Math.round((input.windowEndMs - nowMs) / 1000),
      };
      this._appendSample(row);
      this.counters.samples++;

      if (input.bidUp != null && input.askUp != null) {
        mids.set(series, (input.bidUp + input.askUp) / 2);
      }

      // Near-resolution ring (archetype type 6): final N seconds.
      if (row.tauSec <= this.cfg.observer.nearResWindowSec && row.tauSec >= 0) {
        let ring = this.nearRes.get(series);
        const win = this.markets.get(series)?.slug;
        if (!ring || ring.window !== win) {
          ring = { window: win, series, startSec: this.markets.get(series)?.windowStartMs / 1000, snaps: [] };
          this.nearRes.set(series, ring);
        }
        ring.snaps.push({
          tauSec: row.tauSec,
          leading: input.bidUp != null && input.bidDown != null && input.bidUp >= input.bidDown ? 'Up' : 'Down',
          leadingAsk: (input.bidUp ?? 0) >= (input.bidDown ?? 0) ? input.askUp : input.askDown,
          bidUp: input.bidUp, bidDown: input.bidDown,
        });
      }
    }

    // Cross-timeframe divergence (archetype type 4): 15m Up-mid vs the live
    // 5m Up-mid of the same asset.
    const byAsset = new Map();
    for (const [series, mid] of mids) {
      const m = series.match(/^([a-z0-9]+)-updown-(\d+)m$/);
      if (!m) continue;
      const rec = byAsset.get(m[1]) || {};
      rec[m[2] + 'm'] = { series, mid };
      byAsset.set(m[1], rec);
    }
    for (const [asset, rec] of byAsset) {
      if (!rec['5m'] || !rec['15m']) continue;
      const div = core.round6(Math.abs(rec['15m'].mid - rec['5m'].mid));
      const openEv = this.xtfOpen.get(asset);
      if (div >= this.cfg.observer.xtfDivergence && !openEv) {
        this.xtfOpen.set(asset, { tOpen: nowMs, maxDiv: div, mid5: rec['5m'].mid, mid15: rec['15m'].mid });
      } else if (openEv) {
        if (div >= this.cfg.observer.xtfDivergence) {
          openEv.maxDiv = Math.max(openEv.maxDiv, div);
        } else {
          this.xtfOpen.delete(asset);
          this._append({
            type: 'xtf-divergence', t: openEv.tOpen, asset,
            durationMs: nowMs - openEv.tOpen, maxDivergence: openEv.maxDiv,
            mid5AtOpen: core.round6(openEv.mid5), mid15AtOpen: core.round6(openEv.mid15),
          });
        }
      }
    }
  }

  /** Window rolled: flush the near-resolution ring for outcome lookup. */
  takeNearResRing(series) {
    const ring = this.nearRes.get(series);
    this.nearRes.delete(series);
    return ring && ring.snaps.length ? ring : null;
  }

  recordNearResOutcome(ring, outcome) {
    const last = ring.snaps[ring.snaps.length - 1];
    this._append({
      type: 'near-resolution', t: Date.now(), series: ring.series, window: ring.window,
      outcome,
      leadingAtClose: last.leading,
      reversal: outcome !== null ? last.leading !== outcome : null,
      snaps: ring.snaps,
    });
  }

  /** Gate projection over the trailing 24h (or since start if shorter). */
  gateStatus(nowMs = Date.now()) {
    const horizonMs = Math.min(nowMs - this.startedMs, 24 * 3600 * 1000) || 1;
    const cutoff = nowMs - horizonMs;
    let buy = 0, sell = 0;
    for (const g of this.gateLog) {
      if (g.tMs >= cutoff) (g.side === 'buy' ? buy++ : sell++);
    }
    const scale = (24 * 3600 * 1000) / horizonMs;
    const perDay = { buy: Math.round(buy * scale * 10) / 10, sell: Math.round(sell * scale * 10) / 10 };
    return {
      target: this.cfg.observer.gateEventsPerDay,
      observedInHorizon: { buy, sell },
      horizonHours: Math.round(horizonMs / 36000) / 100,
      projectedPerDay: perDay,
      pass: { buy: perDay.buy >= this.cfg.observer.gateEventsPerDay, sell: perDay.sell >= this.cfg.observer.gateEventsPerDay },
    };
  }

  /** Tuesday 07:00 ET maintenance guard (risk register). */
  static isMaintenanceWindow(nowMs = Date.now()) {
    const et = new Date(new Date(nowMs).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return et.getDay() === 2 && et.getHours() === 7 && et.getMinutes() < 5;
  }

  writeStatus(books, feedState, nowMs = Date.now(), extra = {}) {
    const perSeries = {};
    for (const [series, mkt] of this.markets) {
      const up = books.get(mkt.upToken);
      const down = books.get(mkt.downToken);
      perSeries[series] = {
        window: mkt.slug,
        windowEndsInSec: Math.round((mkt.windowEndMs - nowMs) / 1000),
        bookAgeMsUp: up && up.tsMs ? nowMs - up.tsMs : null,
        bookAgeMsDown: down && down.tsMs ? nowMs - down.tsMs : null,
        feeRate: mkt.feeSchedule ? mkt.feeSchedule.rate : 0,
      };
    }
    const status = {
      t: nowMs,
      mode: 'observe',
      phase: 0,
      engine: 'node',
      feedMode: this.feedMode,
      uptimeSec: Math.round((nowMs - this.startedMs) / 1000),
      ws: feedState,
      series: perSeries,
      counters: this.counters,
      openEvents: [...this.open.keys()],
      gate: this.gateStatus(nowMs),
      alerts: {
        wsDown: !feedState.connected,
        maintenanceWindow: Observer.isMaintenanceWindow(nowMs),
        restPollMode: this.feedMode === 'rest-poll',
      },
      ...extra,
    };
    const tmp = this.statusPath + '.tmp';
    fs.writeFile(tmp, JSON.stringify(status, null, 1), (err) => {
      if (!err) fs.rename(tmp, this.statusPath, () => {});
    });
    return status;
  }
}

module.exports = { Observer };
