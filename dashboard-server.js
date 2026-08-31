#!/usr/bin/env node
'use strict';

// Minimal dashboard for the arb observer (plan §8). Serves:
//   GET /api/arb  -> { status, gate, events summary, recent events }
//   GET /         -> the Arb tab (observer view active; trade views appear in Phase 1)
//
// NOTE for the main repo: this file is standalone here because TestB has no
// existing dashboard-server.js. When merging into the trading repo, port ONLY
// the /api/arb handler + the Arb tab block into the existing :3210 server.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { parseConfig } = require('./lib/config');

const cfg = parseConfig({ argv: [] });
const statusPath = path.join(cfg.dataDir, 'arb-status.json');
const eventsPath = path.join(cfg.dataDir, 'arb-events.jsonl');
const journalPath = path.join(cfg.dataDir, 'arb-journal.json');

const TAIL_BYTES = 4 * 1024 * 1024; // read at most the last 4MB of events

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** Last journal snapshot per pair id (append-only ndjson, snapshots win). */
function readPairs() {
  try {
    const pairs = new Map();
    for (const line of fs.readFileSync(journalPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        // Highest seq wins — appendFile writes can land out of order.
        if (row.type === 'pair' && (!pairs.has(row.id) || (row.seq || 0) >= (pairs.get(row.id).seq || 0))) {
          pairs.set(row.id, row);
        }
      } catch {}
    }
    return [...pairs.values()].sort((a, b) => b.detect.tDetect - a.detect.tDetect);
  } catch {
    return [];
  }
}

function readEventsTail() {
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

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/arb')) {
    const status = readJsonSafe(statusPath);
    const rows = readEventsTail();
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ status, summary: summarize(rows), pairs: readPairs().slice(0, 60) }));
    return;
  }
  if (req.url === '/' || req.url.startsWith('/index')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(cfg.dashPort, () => {
  console.log(`arb dashboard on http://localhost:${cfg.dashPort}  (data: ${cfg.dataDir})`);
});

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Arb Observer</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0d1117; color:#c9d1d9; font:13px/1.5 ui-monospace,Menlo,monospace; margin:0; padding:16px 20px; }
  h1 { font-size:15px; margin:0 0 4px; color:#e6edf3; }
  .pills { margin:6px 0 14px; }
  .pill { display:inline-block; padding:2px 10px; border-radius:10px; margin-right:6px; font-size:11px; background:#21262d; }
  .pill.ok { background:#0f2d1c; color:#3fb950; } .pill.bad { background:#3d1418; color:#f85149; }
  .pill.warn { background:#3a2d10; color:#d29922; }
  .grid { display:grid; grid-template-columns: 1fr 1fr; gap:14px; max-width:1200px; }
  .card { background:#161b22; border:1px solid #21262d; border-radius:8px; padding:12px 14px; }
  .card h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:#8b949e; margin:0 0 8px; }
  table { border-collapse:collapse; width:100%; }
  th,td { text-align:right; padding:2px 8px; border-bottom:1px solid #21262d; font-size:12px; }
  th { color:#8b949e; font-weight:normal; } td:first-child, th:first-child { text-align:left; }
  .big { font-size:22px; color:#e6edf3; } .sub { color:#8b949e; font-size:11px; }
  .pass { color:#3fb950; } .fail { color:#f85149; }
  .buy { color:#58a6ff; } .sell { color:#d2a8ff; }
  .full { grid-column: 1 / -1; }
  .bar { display:inline-block; height:9px; background:#58a6ff55; border:1px solid #58a6ff; vertical-align:middle; }
</style>
<h1>Arb — Phase 0 observer</h1>
<div class="pills" id="pills"></div>
<div class="grid">
  <div class="card"><h2>Gate — buy side (cheap pairs)</h2><div id="gateBuy"></div></div>
  <div class="card"><h2>Gate — sell side (rich pairs)</h2><div id="gateSell"></div></div>
  <div class="card full"><h2>P&amp;L strip</h2><div id="pnl"><div class="sub">observe mode — no trades.</div></div></div>
  <div class="card full"><h2>Pair rows</h2><div id="pairs"><div class="sub">no pair attempts yet</div></div></div>
  <div class="card"><h2>Events per series</h2><div id="series"></div></div>
  <div class="card"><h2>Books / windows</h2><div id="books"></div></div>
  <div class="card"><h2>Duration histograms (ms)</h2><div id="hist"></div></div>
  <div class="card"><h2>Other archetypes</h2><div id="arch"></div></div>
  <div class="card full"><h2>Recent edge events</h2><div id="events"></div></div>
</div>
<script>
const fmt = (x, d=3) => x == null ? '—' : Number(x).toFixed(d);
function gateBlock(side, gate, sum) {
  if (!gate) return '<div class="sub">no status yet</div>';
  const per = gate.projectedPerDay[side], pass = gate.pass[side];
  return '<div class="big ' + (pass ? 'pass' : 'fail') + '">' + per + ' / day' +
    ' <span class="sub">(target ' + gate.target + ')</span></div>' +
    '<div class="sub">' + gate.observedInHorizon[side] + ' gate-qualifying events in last ' +
    gate.horizonHours + 'h · total seen: ' + (sum ? sum.total : 0) +
    ' · median duration: ' + (sum && sum.medianDurationMs != null ? sum.medianDurationMs + 'ms' : '—') +
    ' · max edge: ' + (sum ? fmt(sum.maxEdgeSeen) : '—') + '</div>' +
    '<div style="margin-top:6px" class="' + (pass ? 'pass' : 'fail') + '">' +
    (pass ? 'WOULD PASS' : 'would not pass') + ' the Phase 0 gate</div>';
}
function histBlock(sides) {
  let h = '';
  for (const side of ['buy','sell']) {
    const H = sides[side].durationHistMs, labels = ['<100','100-300','300-1k','1k-3k','3k-10k','>10k'];
    const max = Math.max(1, ...H.counts);
    h += '<div class="sub" style="margin-top:4px">' + side + '</div><table>';
    H.counts.forEach((c,i) => {
      h += '<tr><td>' + labels[i] + '</td><td><span class="bar" style="width:' + Math.round(120*c/max) + 'px"></span> ' + c + '</td></tr>';
    });
    h += '</table>';
  }
  return h;
}
async function tick() {
  try {
    const r = await fetch('/api/arb'); const d = await r.json();
    const s = d.status, sum = d.summary;
    const pills = [];
    if (s) {
      const modeCls = s.mode === 'live' ? 'bad' : s.mode === 'dry' ? 'warn' : '';
      pills.push('<span class="pill ' + modeCls + '">mode: ' + s.mode + (s.mode === 'live' ? ' — REAL ORDERS' : '') + '</span>');
      if (s.trading && s.trading.halted) pills.push('<span class="pill bad">TRADER HALTED</span>');
      pills.push('<span class="pill">engine: ' + s.engine + '</span>');
      pills.push('<span class="pill ' + (s.alerts.wsDown ? 'bad' : 'ok') + '">market ws ' + (s.alerts.wsDown ? 'DOWN' : 'up') + '</span>');
      if (s.alerts.restPollMode) pills.push('<span class="pill warn">REST-POLL DEBUG — NOT GATE-VALID</span>');
      if (s.alerts.maintenanceWindow) pills.push('<span class="pill warn">Tuesday maintenance window</span>');
      const stale = (Date.now() - s.t) > 15000;
      pills.push('<span class="pill ' + (stale ? 'bad' : 'ok') + '">heartbeat ' + (stale ? 'STALE' : 'ok') + '</span>');
      pills.push('<span class="pill">uptime ' + Math.round(s.uptimeSec/60) + 'm</span>');
      pills.push('<span class="pill">samples ' + s.counters.samples + '</span>');
    } else pills.push('<span class="pill bad">no status file — observer not running?</span>');
    document.getElementById('pills').innerHTML = pills.join('');

    document.getElementById('gateBuy').innerHTML = gateBlock('buy', s && s.gate, sum.sides.buy);
    document.getElementById('gateSell').innerHTML = gateBlock('sell', s && s.gate, sum.sides.sell);

    // P&L strip (plan §8 block 1): realized total + decomposition.
    if (s && s.trading) {
      const L = s.trading.ledger, D = L.decomposition, lat = s.trading.latency;
      const cls = L.realizedPnl > 0 ? 'pass' : L.realizedPnl < 0 ? 'fail' : '';
      document.getElementById('pnl').innerHTML =
        '<div class="big ' + cls + '">$' + fmt(L.realizedPnl, 4) + ' realized' +
        (L.perPair != null ? ' <span class="sub">($' + fmt(L.perPair, 4) + '/pair)</span>' : '') + '</div>' +
        '<div class="sub">redeems $' + fmt(D.redeems, 2) + ' + unwind proceeds $' + fmt(D.unwindProceeds, 2) +
        ' − buys $' + fmt(D.buys, 2) + ' · unwind losses $' + fmt(D.unwindLosses, 4) +
        ' · expected fees $' + fmt(D.expectedFees, 4) + '</div>' +
        '<div class="sub">pairs: ' + Object.entries(L.counts).filter(([,v]) => v).map(([k,v]) => k + ' ' + v).join(' · ') +
        ' · committed $' + fmt(L.committedUsdc, 2) + ' / cap' +
        (lat ? ' · detect→ack p50 ' + lat.p50 + 'ms p95 ' + lat.p95 + 'ms (n=' + lat.n + ')' : '') + '</div>';
    }

    // Pair rows (plan §8 block 2).
    if (d.pairs && d.pairs.length) {
      let p = '<table><tr><th>t</th><th>id</th><th>series</th><th>askUp</th><th>askDown</th><th>clip</th><th>state</th><th>matched</th><th>realized $</th><th>ack ms</th></tr>';
      for (const q of d.pairs) {
        const badge = { MATCHED:'pass', RESOLVED:'pass', SCRATCH:'', IN_FLIGHT:'buy', PARTIAL:'fail', UNWOUND:'fail', STRANDED:'fail' }[q.state] || '';
        p += '<tr><td>' + new Date(q.detect.tDetect).toISOString().slice(11,19) + '</td><td>' + q.id +
             '</td><td>' + q.series + '</td><td>' + fmt(q.detect.askUp,2) + '</td><td>' + fmt(q.detect.askDown,2) +
             '</td><td>' + q.detect.clip + '</td><td class="' + badge + '">' + q.state +
             '</td><td>' + q.matchedShares + '</td><td>' + (q.realizedPnl == null ? '—' : fmt(q.realizedPnl,4)) +
             '</td><td>' + (q.latencyMs ? q.latencyMs.detectToLastAck : '—') + '</td></tr>';
      }
      document.getElementById('pairs').innerHTML = p + '</table>';
    }

    let t = '<table><tr><th>series</th><th class="buy">buy</th><th class="buy">gate</th><th class="sell">sell</th><th class="sell">gate</th></tr>';
    for (const [k,v] of Object.entries(sum.perSeries)) {
      t += '<tr><td>' + k + '</td><td>' + v.buy + '</td><td>' + v.buyGate + '</td><td>' + v.sell + '</td><td>' + v.sellGate + '</td></tr>';
    }
    document.getElementById('series').innerHTML = t + '</table>';

    let b = '<table><tr><th>series</th><th>window ends</th><th>age up</th><th>age down</th><th>fee</th></tr>';
    if (s) for (const [k,v] of Object.entries(s.series)) {
      b += '<tr><td>' + k + '</td><td>' + v.windowEndsInSec + 's</td><td>' + (v.bookAgeMsUp ?? '—') +
           '</td><td>' + (v.bookAgeMsDown ?? '—') + '</td><td>' + v.feeRate + '</td></tr>';
    }
    document.getElementById('books').innerHTML = b + '</table>';

    document.getElementById('hist').innerHTML = histBlock(sum.sides);
    document.getElementById('arch').innerHTML =
      '<table><tr><td>skew moments (askSum &lt; 1)</td><td>' + sum.skewMoments + '</td></tr>' +
      '<tr><td>cross-timeframe divergences</td><td>' + sum.xtfDivergences + '</td></tr>' +
      '<tr><td>near-resolution windows</td><td>' + sum.nearResolution.windows + '</td></tr>' +
      '<tr><td>reversal rate (final ' + '30s leader lost)</td><td>' +
      (sum.nearResolution.reversalRate == null ? '—' : sum.nearResolution.reversalRate + '%') + '</td></tr></table>';

    let e = '<table><tr><th>t</th><th>series</th><th>side</th><th>dur ms</th><th>gate</th><th>max edge</th><th>min feeAdjSum</th><th>clip</th></tr>';
    for (const r2 of sum.recentEvents) {
      e += '<tr><td>' + new Date(r2.t).toISOString().slice(11,19) + '</td><td>' + r2.series +
           '</td><td class="' + r2.side + '">' + r2.side + '</td><td>' + r2.durationMs +
           '</td><td>' + (r2.gateQualifying ? 'Y' : '') + '</td><td>' + fmt(r2.maxEdge) +
           '</td><td>' + fmt(r2.minFeeAdjSum) + '</td><td>' + r2.clip + '</td></tr>';
    }
    document.getElementById('events').innerHTML = e + '</table>';
  } catch (err) { /* dashboard keeps polling */ }
}
tick(); setInterval(tick, 2000);
</script>`;
