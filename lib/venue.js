'use strict';

// Order venues behind one interface, so the executor/trader/ledger code is
// identical in dry-run and live:
//
//   venue.buyFAK({tokenId, price, size, feeRateBps, tickSize}) ->
//     { ok, filledShares, usdc, avgPrice, ackMs, orderId, status, error, paper }
//   venue.sellFAK(...) same shape
//
// FAK = fill-and-kill: whatever is marketable fills immediately, the rest is
// cancelled — never rests on the book. We book ONLY the exchange-confirmed
// makingAmount/takingAmount (mm-bot fix #3), never the requested size.

/** Paper venue: simulates FAK fills against the live local books.
 *  Optimistic by construction — it assumes the displayed size is real and
 *  that we win the race. Dry-run P&L is therefore an UPPER BOUND.
 *
 *  Resting (GTC) orders are simulated too: a paper BUY resting at price P
 *  fills when the market's best ask drops to <= P (someone selling into the
 *  bid), a paper SELL when the best bid rises to >= P. checkResting() is
 *  called by the strategy on every book update and returns fill events. */
class PaperVenue {
  constructor(books) {
    this.books = books; // Map assetId -> Book (lib/books.js)
    this.kind = 'paper';
    this.resting = new Map(); // orderId -> {tokenId, side, price, size, remaining}
    this.nextRestId = 1;
  }

  async postGTC({ tokenId, side, price, size }) {
    const orderId = `paper-gtc-${this.nextRestId++}`;
    this.resting.set(orderId, { orderId, tokenId, side, price, size, remaining: size });
    return { ok: true, orderId, status: 'live', error: null, paper: true };
  }

  async cancel(orderId) {
    const had = this.resting.delete(orderId);
    return { ok: had, orderId, paper: true };
  }

  /** True when we have a resting order at this token's best level (self-trade guard). */
  restingAtBest(tokenId, side) {
    const book = this.books.get(tokenId);
    if (!book) return false;
    const best = side === 'BUY' ? book.bestBid() : book.bestAsk();
    for (const o of this.resting.values()) {
      if (o.tokenId === tokenId && o.side === side && best !== null && o.price === best) return true;
    }
    return false;
  }

  /** Simulate resting-order fills against the current books; returns fills. */
  checkResting(tokenId) {
    const fills = [];
    const book = this.books.get(tokenId);
    if (!book) return fills;
    for (const o of [...this.resting.values()]) {
      if (o.tokenId !== tokenId) continue;
      let filled = 0;
      if (o.side === 'BUY') {
        const ask = book.bestAsk();
        if (ask !== null && ask <= o.price) filled = Math.min(o.remaining, book.sizeAt('SELL', ask));
      } else {
        const bid = book.bestBid();
        if (bid !== null && bid >= o.price) filled = Math.min(o.remaining, book.sizeAt('BUY', bid));
      }
      if (filled > 0) {
        o.remaining -= filled;
        if (o.remaining <= 1e-9) this.resting.delete(o.orderId);
        fills.push({ orderId: o.orderId, tokenId, side: o.side, price: o.price, shares: filled, usdc: filled * o.price, paper: true });
      }
    }
    return fills;
  }

  async buyFAK({ tokenId, price, size }) {
    const book = this.books.get(tokenId);
    const ask = book ? book.bestAsk() : null;
    if (ask == null || ask > price) {
      return { ok: true, filledShares: 0, usdc: 0, avgPrice: null, ackMs: 0, orderId: null, status: 'unmatched', error: null, paper: true };
    }
    const filled = Math.min(size, book.sizeAt('SELL', ask));
    return { ok: true, filledShares: filled, usdc: filled * ask, avgPrice: ask, ackMs: 0, orderId: `paper-${Date.now()}`, status: 'matched', error: null, paper: true };
  }

  async sellFAK({ tokenId, price, size }) {
    const book = this.books.get(tokenId);
    const bid = book ? book.bestBid() : null;
    if (bid == null || bid < price) {
      return { ok: true, filledShares: 0, usdc: 0, avgPrice: null, ackMs: 0, orderId: null, status: 'unmatched', error: null, paper: true };
    }
    const filled = Math.min(size, book.sizeAt('BUY', bid));
    return { ok: true, filledShares: filled, usdc: filled * bid, avgPrice: bid, ackMs: 0, orderId: `paper-${Date.now()}`, status: 'matched', error: null, paper: true };
  }
}

/** Live venue: real orders on the Polymarket CLOB via the official client.
 *  Requires POLY_PRIVATE_KEY (+ optionally POLY_FUNDER_ADDRESS for the proxy
 *  wallet, POLY_SIGNATURE_TYPE, and POLY_API_KEY/SECRET/PASSPHRASE — derived
 *  from the key when absent). Loaded lazily: observe/dry never touch this. */
class LiveVenue {
  constructor(cfg) {
    this.cfg = cfg;
    this.kind = 'live';
    this.client = null;
    this.Side = null;
    this.OrderType = null;
  }

  async init() {
    const pk = process.env.POLY_PRIVATE_KEY;
    if (!pk) throw new Error('live mode requires POLY_PRIVATE_KEY in the environment/.env');
    const mod = await import('@polymarket/clob-client'); // ESM-only package
    const { Wallet } = require('ethers');
    const signer = new Wallet(pk);
    const funder = process.env.POLY_FUNDER_ADDRESS || signer.address;
    const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 1); // 1 = Polymarket proxy wallet
    const boot = new mod.ClobClient(this.cfg.clobBase, 137, signer, undefined, sigType, funder);
    const creds = process.env.POLY_API_KEY
      ? { key: process.env.POLY_API_KEY, secret: process.env.POLY_API_SECRET, passphrase: process.env.POLY_API_PASSPHRASE }
      : await boot.createOrDeriveApiKey();
    this.client = new mod.ClobClient(this.cfg.clobBase, 137, signer, creds, sigType, funder);
    this.creds = creds; // kept for the user-channel websocket (our fills, pushed)
    this.Side = mod.Side;
    this.OrderType = mod.OrderType;
    this.address = funder;
    this.signerAddress = signer.address;
  }

  async _fak(side, { tokenId, price, size, feeRateBps, tickSize }) {
    const t0 = Date.now();
    try {
      // tickSize/negRisk passed explicitly so createOrder does no REST lookups
      // on the hot path (updown markets: tick 0.01, negRisk false — from discovery).
      const order = await this.client.createOrder(
        { tokenID: tokenId, price, side: side === 'BUY' ? this.Side.BUY : this.Side.SELL, size, feeRateBps },
        { tickSize: String(tickSize ?? 0.01), negRisk: false },
      );
      const resp = await this.client.postOrder(order, this.OrderType.FAK);
      const ackMs = Date.now() - t0;
      const making = Number(resp?.makingAmount || 0);
      const taking = Number(resp?.takingAmount || 0);
      const filledShares = side === 'BUY' ? taking : making;
      const usdc = side === 'BUY' ? making : taking;
      return {
        ok: !!resp?.success,
        filledShares,
        usdc,
        avgPrice: filledShares > 0 ? usdc / filledShares : null,
        ackMs,
        orderId: resp?.orderID || null,
        status: resp?.status || null,
        error: resp?.errorMsg || null,
        paper: false,
      };
    } catch (err) {
      return { ok: false, filledShares: 0, usdc: 0, avgPrice: null, ackMs: Date.now() - t0, orderId: null, status: 'error', error: err.message, paper: false };
    }
  }

  buyFAK(args) { return this._fak('BUY', args); }
  sellFAK(args) { return this._fak('SELL', args); }

  /** Rest a maker order on the book. Maker fills pay ZERO fees (takerOnly). */
  async postGTC({ tokenId, side, price, size, feeRateBps, tickSize }) {
    try {
      const order = await this.client.createOrder(
        { tokenID: tokenId, price, side: side === 'BUY' ? this.Side.BUY : this.Side.SELL, size, feeRateBps },
        { tickSize: String(tickSize ?? 0.01), negRisk: false },
      );
      const resp = await this.client.postOrder(order, this.OrderType.GTC);
      return { ok: !!resp?.success, orderId: resp?.orderID || null, status: resp?.status || null, error: resp?.errorMsg || null, paper: false };
    } catch (err) {
      return { ok: false, orderId: null, status: 'error', error: err.message, paper: false };
    }
  }

  async cancel(orderId) {
    try {
      const resp = await this.client.cancelOrder({ orderID: orderId });
      return { ok: !resp?.not_canceled?.length, orderId, raw: resp, paper: false };
    } catch (err) {
      return { ok: false, orderId, error: err.message, paper: false };
    }
  }

  restingAtBest() { return false; } // live self-trade handling is exchange-side
  checkResting() { return []; }     // live fills arrive on the user websocket instead
}

module.exports = { PaperVenue, LiveVenue };
