'use strict';

// User-channel websocket — OUR fills, pushed (live mode only; dry mode
// simulates resting fills from book movement instead).
//
// Fills are derived from `order` UPDATE messages: the delta in size_matched on
// one of our order ids is a fill of that many shares at the order's price.
// `trade` messages are also watched as a belt-and-braces signal. Field names
// follow the documented user channel; VERIFY against the first live session's
// raw log (arb-userws-raw.jsonl) before trusting maker fills in production —
// the strategy disables the maker module while this feed is down.

const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
let WebSocket;
try { WebSocket = require('ws'); } catch { WebSocket = globalThis.WebSocket; }

class UserFeed extends EventEmitter {
  constructor({ wsUrl, creds, dataDir }) {
    super();
    this.wsUrl = wsUrl; // wss://ws-subscriptions-clob.polymarket.com/ws/user
    this.creds = creds; // {key, secret, passphrase}
    this.rawLog = dataDir ? path.join(dataDir, 'arb-userws-raw.jsonl') : null;
    this.markets = [];  // condition ids
    this.ws = null;
    this.connected = false;
    this.lastState = 'never-connected';
    this.lastError = null;
    this.closed = false;
    this.pingTimer = null;
    this.reconnectDelayMs = 1000;
    this.matched = new Map(); // orderId -> cumulative matched size
    this.orderMeta = new Map(); // orderId -> {tokenId, price}
  }

  setMarkets(conditionIds) {
    const next = [...new Set(conditionIds)].sort();
    if (next.join(',') === this.markets.join(',') && this.ws) return;
    this.markets = next;
    this._connect();
  }

  _connect() {
    if (this.closed || this.markets.length === 0) return;
    if (this.ws) { try { this.ws.close(); } catch {} }
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.lastState = 'open';
      this.lastError = null;
      this.reconnectDelayMs = 1000;
      ws.send(JSON.stringify({
        auth: { apiKey: this.creds.key, secret: this.creds.secret, passphrase: this.creds.passphrase },
        type: 'user',
        markets: this.markets,
      }));
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send('PING'); }, 5000);
      this.emit('state', 'open');
    });

    ws.on('message', (raw) => {
      const text = raw.toString();
      if (text === 'PONG' || text === 'PING') return;
      if (this.rawLog) fs.appendFile(this.rawLog, text + '\n', () => {});
      let parsed;
      try { parsed = JSON.parse(text); } catch { return; }
      for (const msg of Array.isArray(parsed) ? parsed : [parsed]) this._handle(msg);
    });

    const scheduleReconnect = () => {
      this.connected = false;
      this.lastState = 'down';
      if (this.closed || this.ws !== ws) return;
      this.emit('state', 'down');
      setTimeout(() => { if (this.ws === ws) this._connect(); }, this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    };
    ws.on('close', scheduleReconnect);
    ws.on('error', (err) => {
      this.lastState = 'error';
      this.lastError = err.message;
      this.emit('state', 'error', err.message);
      try { ws.close(); } catch {}
    });
  }

  _handle(msg) {
    if (msg.event_type === 'order') {
      const id = msg.id || msg.order_id;
      if (!id) return;
      const price = Number(msg.price);
      const tokenId = msg.asset_id;
      this.orderMeta.set(id, { tokenId, price });
      const matched = Number(msg.size_matched ?? msg.sizeMatched ?? 0);
      const prev = this.matched.get(id) || 0;
      if (matched > prev) {
        this.matched.set(id, matched);
        const shares = matched - prev;
        this.emit('fill', { orderId: id, tokenId, price, shares, usdc: shares * price, source: 'order-update' });
      }
      if (msg.type === 'CANCELLATION') { this.matched.delete(id); this.orderMeta.delete(id); }
    } else if (msg.event_type === 'trade') {
      // Belt and braces: surface trades too; the strategy dedupes by orderId
      // deltas above, so this is informational unless order updates are missed.
      this.emit('trade', msg);
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    try { this.ws && this.ws.close(); } catch {}
  }
}

module.exports = { UserFeed };
