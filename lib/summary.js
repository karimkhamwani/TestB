'use strict';

// Shared aggregation over the data files — the single source for both the
// dashboard's /api/arb payload and the paste-able snapshot file
// (data/arb-snapshot.json, written by `npm run snapshot`).

const fs = require('node:fs');
const path = require('node:path');

const TAIL_BYTES = 4 * 1024 * 1024; // read at most the last 4MB of events

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** Last journal snapshot per pair id (append-only ndjson; highest seq wins —
 *  appendFile writes can land out of order). */
function readPairs(journalPath) {
  try {
    const pairs = new Map();
    for (const line of fs.readFileSync(journalPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.type === 'pair' && (!pairs.has(row.id) || (row.seq || 0) >= (pairs.get(row.id).seq || 0))) {
          pairs.set(row.id, row);
        }
      } catch {}
    }
    return [...pairs.values()].sort((a, b) => (b.detect.tDetect || b.t) - (a.detect.tDetect || a.t));
  } catch {
    return [];
  }
}

function readEventsTail(eventsPath) {
  try {
    const stat = fs.statSync(eventsPath);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(eventsPath, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // drop the partial first line
    const rows = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch {}
    }
    return rows;
  } catch {
    return [];
  }
}

function bucketize(values, edges) {
  const counts = new Array(edges.length + 1).fill(0);
  for (const v of values) {
    let i = 0;
    while (i < edges.length && v >= edges[i]) i++;
    counts[i]++;
  }
  return { edges, counts };
}

function summarize(rows) {
  const edge = rows.filter((r) => r.type === 'edge-event');
  const bySide = { buy: edge.filter((r) => r.side === 'buy'), sell: edge.filter((r) => r.side === 'sell') };
  const perSeries = {};
  for (const r of edge) {
    const s = (perSeries[r.series] ||= { buy: 0, sell: 0, buyGate: 0, sellGate: 0 });
    s[r.side]++;
    if (r.gateQualifying) s[r.side + 'Gate']++;
  }
  const durEdges = [100, 300, 1000, 3000, 10000];
  const summary = {};
  for (const side of ['buy', 'sell']) {
    const rs = bySide[side];
    summary[side] = {
      total: rs.length,
      gateQualifying: rs.filter((r) => r.gateQualifying).length,
      durationHistMs: bucketize(rs.map((r) => r.durationMs), durEdges),
      maxEdgeSeen: rs.length ? Math.max(...rs.map((r) => r.maxEdge)) : null,
      medianDurationMs: rs.length ? rs.map((r) => r.durationMs).sort((a, b) => a - b)[Math.floor(rs.length / 2)] : null,
    };
  }
  const nearRes = rows.filter((r) => r.type === 'near-resolution');
  const reversals = nearRes.filter((r) => r.reversal === true).length;
  return {
    perSeries,
    sides: summary,
    skewMoments: rows.filter((r) => r.type === 'skew').length,
    xtfDivergences: rows.filter((r) => r.type === 'xtf-divergence').length,
    nearResolution: {
      windows: nearRes.length,
      reversals,
      reversalRate: nearRes.length ? Math.round((reversals / nearRes.length) * 1000) / 10 : null,
    },
    recentEvents: edge.slice(-40).reverse(),
  };
}

/** Everything the dashboard shows, as one JSON-able object. */
function buildSnapshot(cfg, { maxPairs = 60 } = {}) {
  const status = readJsonSafe(path.join(cfg.dataDir, 'arb-status.json'));
  const rows = readEventsTail(path.join(cfg.dataDir, 'arb-events.jsonl'));
  const pairs = readPairs(path.join(cfg.dataDir, 'arb-journal.json'));
  return {
    generatedAt: new Date().toISOString(),
    dataDir: cfg.dataDir,
    config: {
      mode: cfg.mode,
      series: cfg.series,
      modules: cfg.trader.modules,
      detector: cfg.detector,
      trader: { ...cfg.trader, modules: undefined },
      observer: cfg.observer,
    },
    status,
    summary: summarize(rows),
    pairs: pairs.slice(0, maxPairs),
    pairsTotal: pairs.length,
  };
}

module.exports = { readJsonSafe, readPairs, readEventsTail, bucketize, summarize, buildSnapshot };
