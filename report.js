#!/usr/bin/env node
'use strict';

// report.js — go/no-go gate report from the observer's data files.
// Run on the box that collected the data:  node report.js [dataDir]
// Prints a compact, paste-able summary: gate verdict per side, durations,
// per-series breakdown, executability, and the archetype recorders.

const fs = require('node:fs');
const path = require('node:path');

const dataDir = process.argv[2] || process.env.ARB_DATA_DIR || path.join(process.cwd(), 'data');
const eventsPath = path.join(dataDir, 'arb-events.jsonl');
const statusPath = path.join(dataDir, 'arb-status.json');

function readNdjson(p) {
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function pct(sorted, q) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
}

const rows = readNdjson(eventsPath);
const edges = rows.filter((r) => r.type === 'edge-event');
if (!edges.length && !rows.length) {
  console.log(`no events in ${eventsPath} — is the data dir right?`);
  process.exit(1);
}

const status = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, 'utf8')) : null;
const tMin = Math.min(...rows.map((r) => r.t));
const tMax = Math.max(...rows.map((r) => r.t));
const spanH = (tMax - tMin) / 3600e3;
const gateTarget = Number(process.env.ARB_OBS_GATE_PER_DAY || 20);

console.log(`=== Arb gate report ===`);
console.log(`data: ${dataDir}`);
console.log(`span: ${new Date(tMin).toISOString()} -> ${new Date(tMax).toISOString()}  (${spanH.toFixed(1)}h)`);
if (status) console.log(`observer: mode=${status.mode} feed=${status.feedMode} uptime=${(status.uptimeSec / 3600).toFixed(1)}h${status.feedMode === 'rest-poll' ? '  ** REST-POLL — NOT GATE-VALID **' : ''}`);

for (const side of ['buy', 'sell']) {
  const es = edges.filter((e) => e.side === side);
  const gateEs = es.filter((e) => e.gateQualifying);
  const execEs = gateEs.filter((e) => e.execOk);
  const durs = es.map((e) => e.durationMs).sort((a, b) => a - b);
  const gPerDay = spanH > 0 ? (gateEs.length / spanH) * 24 : 0;
  const verdict = gPerDay >= gateTarget ? 'PASS' : 'fail';
  console.log(`\n--- ${side.toUpperCase()} side ---`);
  console.log(`events: ${es.length} total, ${gateEs.length} gate-qualifying (>=300ms+depth) -> ${gPerDay.toFixed(1)}/day vs target ${gateTarget}  [${verdict}]`);
  if (es.length) {
    console.log(`durations ms: p50=${pct(durs, 0.5)} p90=${pct(durs, 0.9)} max=${durs[durs.length - 1]}`);
    const best = [...es].sort((a, b) => b.maxEdge - a.maxEdge)[0];
    console.log(`best edge: ${best.maxEdge} (${best.series}, ${best.durationMs}ms, ${new Date(best.t).toISOString()})`);
  }
  console.log(`executable under our caps (clip>0, tau, band): ${execEs.length} of the gate-qualifying`);
  const bySeries = {};
  for (const e of gateEs) bySeries[e.series] = (bySeries[e.series] || 0) + 1;
  const top = Object.entries(bySeries).sort((a, b) => b[1] - a[1]);
  if (top.length) console.log(`gate events by series: ${top.map(([s, n]) => `${s}=${n}`).join('  ')}`);
}

const nearRes = rows.filter((r) => r.type === 'near-resolution' && r.outcome);
const reversals = nearRes.filter((r) => r.reversal).length;
console.log(`\n--- archetypes ---`);
console.log(`near-resolution: ${nearRes.length} resolved windows, ${reversals} reversals (${nearRes.length ? ((reversals / nearRes.length) * 100).toFixed(1) : '—'}%)`);
console.log(`skew moments (askSum<1, rate-limited): ${rows.filter((r) => r.type === 'skew').length}`);
console.log(`cross-timeframe divergences: ${rows.filter((r) => r.type === 'xtf-divergence').length}`);

if (status && status.trading) {
  const T = status.trading;
  const L = T.ledger;
  const lat = T.taker && T.taker.latency;
  console.log(`\n--- trading (${T.venue}) ---`);
  console.log(`modules: ${(T.modules || []).join(', ')} | skew κ=${T.skew ? T.skew.kappa : '—'}${T.skew && !T.skew.active ? ' (pinned)' : ''} | ctf ${T.ctf ? T.ctf.kind + (T.ctf.disabled ? ' DISABLED' : '') : '—'}`);
  console.log(`pairs: ${JSON.stringify(L.counts)} realized=$${L.realizedPnl} perPair=${L.perPair ?? '—'}`);
  if (L.bySource) console.log(`by source: ${Object.entries(L.bySource).map(([k,v]) => k + ' $' + v.realized + ' (' + v.pairs + ')').join('  ')}`);
  const D = L.decomposition;
  if (D) console.log(`decomp: sells $${D.sells} + merges $${D.merges} + redeems $${D.redeems} + unwinds $${D.unwindProceeds} - buys $${D.buys} - splits $${D.splits} - ctf $${D.ctfCosts}`);
  if (lat) console.log(`detect->ack ms: p50=${lat.p50} p95=${lat.p95} max=${lat.max} (n=${lat.n})   <- prices the C++ engine`);
}
console.log('');
