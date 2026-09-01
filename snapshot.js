#!/usr/bin/env node
'use strict';

// snapshot.js — dump everything the dashboard shows into ONE paste-able JSON
// file: config, status (heartbeat, gate, modules, ledger, allocator, latency),
// observer summary (per-series events, duration histograms, archetypes), and
// the recent pair rows.
//
//   npm run snapshot            -> writes data/arb-snapshot.json + prints it
//   node snapshot.js [dataDir]  -> same, against another data dir

const fs = require('node:fs');
const path = require('node:path');
const { parseConfig } = require('./lib/config');
const { buildSnapshot } = require('./lib/summary');

const cfg = parseConfig({ argv: [] });
if (process.argv[2]) cfg.dataDir = process.argv[2];

const snap = buildSnapshot(cfg);
const out = path.join(cfg.dataDir, 'arb-snapshot.json');
const json = JSON.stringify(snap, null, 1);
fs.writeFileSync(out, json);
console.log(json);
console.error(`\n[written to ${out} — ${(json.length / 1024).toFixed(0)}KB]`);
