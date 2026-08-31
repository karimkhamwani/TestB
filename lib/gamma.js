'use strict';

// Market discovery via the gamma REST API (plan §4 feeds).
//
// Updown windows are addressable deterministically: the event slug is
//   {asset}-updown-{tf}-{unixWindowStart}
// where unixWindowStart is aligned to the timeframe (verified live 2026-08-31:
// btc-updown-5m-1788205500 -> "Bitcoin Up or Down - 3:45PM-3:50PM ET",
// eventStartTime == slug timestamp, endDate == start + tf).

function parseSeries(series) {
  const m = series.match(/^([a-z0-9]+)-updown-(\d+)m$/);
  if (!m) throw new Error(`unrecognized series slug: ${series}`);
  return { asset: m[1], tfSec: Number(m[2]) * 60 };
}

function windowStartSec(tfSec, nowMs) {
  const nowSec = Math.floor(nowMs / 1000);
  return Math.floor(nowSec / tfSec) * tfSec;
}

function windowSlug(series, startSec) {
  return `${series}-${startSec}`;
}

/** Fetch one updown window's market. Returns null when gamma has no event for
 *  the slug (window not yet deployed, or series naming changed). */
async function fetchWindowMarket(gammaBase, series, startSec) {
  const slug = windowSlug(series, startSec);
  const res = await fetch(`${gammaBase}/events?slug=${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`gamma ${res.status} for ${slug}`);
  const events = await res.json();
  if (!Array.isArray(events) || events.length === 0) return null;
  const mkt = events[0].markets && events[0].markets[0];
  if (!mkt) return null;

  let tokenIds;
  let outcomes;
  try {
    tokenIds = JSON.parse(mkt.clobTokenIds);
    outcomes = JSON.parse(mkt.outcomes);
  } catch {
    return null;
  }
  const upIdx = outcomes.findIndex((o) => /up/i.test(o));
  const downIdx = outcomes.findIndex((o) => /down/i.test(o));
  if (upIdx < 0 || downIdx < 0) return null;

  return {
    series,
    slug,
    windowStartMs: startSec * 1000,
    windowEndMs: Date.parse(mkt.endDate),
    conditionId: mkt.conditionId,
    upToken: tokenIds[upIdx],
    downToken: tokenIds[downIdx],
    feeSchedule: mkt.feesEnabled ? mkt.feeSchedule : null,
    feeType: mkt.feeType || null,
    minOrderSize: Number(mkt.orderMinSize) || 5,
    tickSize: Number(mkt.orderPriceMinTickSize) || 0.01,
    acceptingOrders: !!mkt.acceptingOrders,
  };
}

/** Fetch a resolved window's outcome ("Up"/"Down"/null). Used by the observer's
 *  near-resolution recorder after the window closes. */
async function fetchWindowOutcome(gammaBase, series, startSec) {
  const slug = windowSlug(series, startSec);
  const res = await fetch(`${gammaBase}/events?slug=${encodeURIComponent(slug)}`);
  if (!res.ok) return null;
  const events = await res.json();
  const mkt = events?.[0]?.markets?.[0];
  if (!mkt) return null;
  try {
    const outcomes = JSON.parse(mkt.outcomes);
    const prices = JSON.parse(mkt.outcomePrices).map(Number);
    const winIdx = prices.findIndex((p) => p === 1);
    if (winIdx < 0) return null; // not resolved yet (or split resolution)
    return outcomes[winIdx];
  } catch {
    return null;
  }
}

module.exports = { parseSeries, windowStartSec, windowSlug, fetchWindowMarket, fetchWindowOutcome };
