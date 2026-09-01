'use strict';

// Live L2 book maintenance over the CLOB market websocket (plan §4 feeds).
//
// Design notes:
//  - Updown token sets change every window rollover; the CLOB market channel
//    subscription is fixed at connect time, so we SWAP connections: open a new
//    socket with the new asset list, and close the old one once the new one
//    has delivered its book snapshots. Books survive the swap.
//  - Keepalive: the exchange disconnects after 10s of silence (risk register),
//    so we send a text PING every 5s and treat the resulting order-clear
//    semantics as a safety net, not an error.
//  - Every book carries tsMs = last update time; the detector's freshness gate
//    reads it. A book we haven't heard about is stale by construction.

const EventEmitter = require('node:events');
let WebSocket;
try { WebSocket = require('ws'); } catch { WebSocket = globalThis.WebSocket; }

class Book {
  constructor(assetId) {
    this.assetId = assetId;
    this.bids = new Map(); // price(number) -> size(number)
    this.asks = new Map();
    this.tsMs = 0;          // last CHANGE to this book (activity)
    this.feedClock = null;  // shared {t} bumped on ANY message from the
                            // connection that delivered our snapshot
    this.hasSnapshot = false;
  }

  /** Freshness for the detector: an UNCHANGED book on a live connection is
   *  current — the exchange pushes every change, so silence means "no change",
   *  not "unknown". A quiet series must not trip the stale-book gate. */
  freshTs() {
    return this.feedClock ? Math.max(this.tsMs, this.feedClock.t) : this.tsMs;
  }

  applySnapshot(msg, nowMs) {
    this.bids.clear();
    this.asks.clear();
    for (const l of msg.bids || []) this.bids.set(Number(l.price), Number(l.size));
    for (const l of msg.asks || []) this.asks.set(Number(l.price), Number(l.size));
    this.tsMs = nowMs;
    this.hasSnapshot = true;
  }

  applyLevel(side, price, size, nowMs) {
    const m = side === 'BUY' ? this.bids : this.asks;
    const p = Number(price);
    const s = Number(size);
    if (s > 0) m.set(p, s);
    else m.delete(p);
    this.tsMs = nowMs;
  }

  bestBid() {
    let best = null;
    for (const [p, s] of this.bids) if (s > 0 && (best === null || p > best)) best = p;
    return best;
  }

  bestAsk() {
    let best = null;
    for (const [p, s] of this.asks) if (s > 0 && (best === null || p < best)) best = p;
    return best;
  }

  sizeAt(side, price) {
    const m = side === 'BUY' ? this.bids : this.asks;
    return price === null ? 0 : (m.get(price) || 0);
  }

  top() {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    return {
      bid, ask,
      bidSize: this.sizeAt('BUY', bid),
      askSize: this.sizeAt('SELL', ask),
      tsMs: this.freshTs(),
    };
  }
}

class BookFeed extends EventEmitter {
  constructor(wsUrl) {
    super();
    this.wsUrl = wsUrl;
    this.books = new Map(); // assetId -> Book
    this.ws = null;
    this.oldWs = null;
    this.assetIds = [];
    this.pingTimer = null;
    this.reconnectDelayMs = 1000;
    this.closed = false;
    this.connectedSince = 0;
  }

  /** (Re)subscribe to exactly this asset set, swapping the connection. */
  setAssets(assetIds) {
    const next = [...new Set(assetIds)].sort();
    if (next.join(',') === this.assetIds.join(',') && this.ws) return;
    this.assetIds = next;
    for (const id of next) if (!this.books.has(id)) this.books.set(id, new Book(id));
    for (const id of [...this.books.keys()]) if (!next.includes(id)) this.books.delete(id);
    this._connect();
  }

  _connect() {
    if (this.closed || this.assetIds.length === 0) return;
    if (this.oldWs) { try { this.oldWs.close(); } catch {} this.oldWs = null; }
    if (this.ws) this.oldWs = this.ws; // keep serving until the new one snapshots

    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    // Per-connection clock: bumped on EVERY inbound message (PONGs included).
    // Books snapshotted by this connection share it — a dead socket stops the
    // clock and its books go stale together, exactly as they should.
    const clock = { t: 0 };
    let snapshotsSeen = 0;

    ws.on('open', () => {
      this.connectedSince = Date.now();
      this.reconnectDelayMs = 1000;
      ws.send(JSON.stringify({ assets_ids: this.assetIds, type: 'market' }));
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === 1) ws.send('PING');
      }, 5000);
      this.emit('ws', 'open');
    });

    ws.on('message', (raw) => {
      const nowMs = Date.now();
      clock.t = nowMs;
      const text = raw.toString();
      if (text === 'PONG' || text === 'PING') return;
      let parsed;
      try { parsed = JSON.parse(text); } catch { return; }
      const msgs = Array.isArray(parsed) ? parsed : [parsed];
      for (const msg of msgs) {
        const type = msg.event_type;
        if (type === 'book') {
          const book = this.books.get(msg.asset_id);
          if (!book) continue;
          book.applySnapshot(msg, nowMs);
          book.feedClock = clock;
          snapshotsSeen++;
          this.emit('update', msg.asset_id);
          if (snapshotsSeen >= this.assetIds.length && this.oldWs) {
            try { this.oldWs.close(); } catch {}
            this.oldWs = null;
          }
        } else if (type === 'price_change') {
          // Two observed payload shapes: {asset_id, changes:[{price,side,size}]}
          // and {price_changes:[{asset_id, price, side, size}]}.
          const entries = msg.price_changes
            ? msg.price_changes.map((c) => ({ assetId: c.asset_id, ...c }))
            : (msg.changes || []).map((c) => ({ assetId: msg.asset_id, ...c }));
          const touched = new Set();
          for (const c of entries) {
            const book = this.books.get(c.assetId);
            if (!book) continue;
            book.applyLevel(c.side, c.price, c.size, nowMs);
            touched.add(c.assetId);
          }
          for (const id of touched) this.emit('update', id);
        } else if (type === 'tick_size_change') {
          const book = this.books.get(msg.asset_id);
          if (book) book.tsMs = nowMs;
          // Orders signed with a stale tick get rejected — let the supervisor
          // update the market metadata.
          this.emit('tick_size', msg.asset_id, Number(msg.new_tick_size) || null);
        } else if (type === 'last_trade_price') {
          const book = this.books.get(msg.asset_id);
          if (book) book.tsMs = nowMs;
          // Real taker flow. This is the ONLY signal that fills a resting bid:
          // a maker order fills when someone crosses into it, which moves no
          // book level we could otherwise observe. `side` is the TAKER's side.
          const price = Number(msg.price);
          const size = Number(msg.size);
          if (Number.isFinite(price) && Number.isFinite(size) && size > 0) {
            this.emit('trade', msg.asset_id, { price, size, side: msg.side, tsMs: nowMs });
          }
        }
      }
    });

    const scheduleReconnect = () => {
      if (this.closed || this.ws !== ws) return;
      this.emit('ws', 'down');
      setTimeout(() => { if (this.ws === ws) this._connect(); }, this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    };
    ws.on('close', scheduleReconnect);
    ws.on('error', (err) => { this.emit('ws', 'error', err.message); try { ws.close(); } catch {} });
  }

  get(assetId) {
    return this.books.get(assetId) || null;
  }

  state() {
    return {
      connected: !!this.ws && this.ws.readyState === 1,
      assets: this.assetIds.length,
      connectedSince: this.connectedSince,
    };
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    for (const s of [this.ws, this.oldWs]) { try { s && s.close(); } catch {} }
  }
}

module.exports = { Book, BookFeed };
