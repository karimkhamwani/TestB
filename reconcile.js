#!/usr/bin/env node
'use strict';

// reconcile.js — journal vs actual Polymarket positions. Mandatory after
// EVERY live session, and before raising any cap (risk register: accounting
// drift).
//
// Usage:  node reconcile.js [address]
// Address defaults to POLY_FUNDER_ADDRESS from .env. Reads data/arb-journal.json
// (last row per pair id wins), derives expected net token positions from
// non-terminal pairs, fetches live positions from the data API, and prints
// per-token discrepancies. Any drift is a stop-trading signal, not a rounding
// nuisance (plan: accounting drift risk).

const fs = require('node:fs');
const path = require('node:path');
const { parseConfig } = require('./lib/config');

async function main() {
  const cfg = parseConfig({ argv: [] });
  const address = process.argv[2] || process.env.POLY_FUNDER_ADDRESS;
  if (!address) {
    console.error('usage: node reconcile.js <address>   (or set POLY_FUNDER_ADDRESS in .env)');
    process.exit(1);
  }

  const journalPath = path.join(cfg.dataDir, 'arb-journal.json');
  if (!fs.existsSync(journalPath)) {
    console.error(`no journal at ${journalPath} — nothing to reconcile`);
    process.exit(1);
  }

  // Last snapshot per pair id wins.
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

  // Expected net shares per token from non-terminal pairs' live inventory
  // (pair.qty). RESOLVED pairs may hold winner shares on-chain until the
  // redeem lands — reported separately.
  const expected = new Map(); // tokenId -> shares
  const redeemable = new Map();
  const add = (m, tok, n) => m.set(tok, (m.get(tok) || 0) + n);
  let paper = 0;
  for (const p of pairs.values()) {
    if (p.mode && p.mode !== 'live') { paper++; continue; }
    if (['MERGED', 'UNWOUND', 'SCRATCH'].includes(p.state)) continue;
    if (p.state === 'RESOLVED') {
      if (p.redeemUsdc > 0) {
        const winnerTok = p.resolution && p.resolution.outcome === 'Up' ? p.upToken
          : p.resolution && p.resolution.outcome === 'Down' ? p.downToken : null;
        if (winnerTok) add(redeemable, winnerTok, p.redeemUsdc); // $1/share -> shares
        // Outcome unknown to the journal: the cash was booked from balanced
        // pairs — value is real but the winning token is unidentified. Flag
        // BOTH tokens so the drift is attributable, not invisible.
        else { add(redeemable, p.upToken, p.redeemUsdc); add(redeemable, p.downToken, 0); }
      }
      continue;
    }
    if (p.qty) { add(expected, p.upToken, p.qty.up); add(expected, p.downToken, p.qty.down); }
  }
  if (paper) console.log(`note: skipped ${paper} dry-run (paper) pairs — nothing on-chain to reconcile for those\n`);

  console.log(`fetching live positions for ${address} ...`);
  const res = await fetch(`https://data-api.polymarket.com/positions?user=${address}&limit=500`);
  if (!res.ok) throw new Error(`data-api ${res.status}`);
  const positions = await res.json();
  const actual = new Map();
  for (const pos of positions) add(actual, pos.asset, Number(pos.size) || 0);

  const tokens = new Set([...expected.keys(), ...actual.keys()]);
  let drift = 0;
  console.log('\ntoken (last 8)      expected     actual       diff');
  for (const tok of tokens) {
    const e = expected.get(tok) || 0;
    const a = actual.get(tok) || 0;
    const d = a - e;
    if (Math.abs(d) > 1e-6) drift++;
    console.log(`...${tok.slice(-8)}   ${e.toFixed(2).padStart(10)} ${a.toFixed(2).padStart(10)} ${d.toFixed(2).padStart(10)}${Math.abs(d) > 1e-6 ? '  <-- DRIFT' : ''}`);
  }
  if (redeemable.size) {
    console.log('\nresolved, possibly not yet redeemed (verify the redeem txs landed):');
    for (const [tok, usdc] of redeemable) console.log(`  ...${tok.slice(-8)}  $${usdc.toFixed(2)} redeemable`);
  }
  console.log(drift === 0
    ? '\nCLEAN: journal matches live positions.'
    : `\nDRIFT on ${drift} token(s). Do NOT raise caps; find the booking error first.`);
  process.exit(drift === 0 ? 0 : 2);
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
