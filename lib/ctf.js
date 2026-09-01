'use strict';

// CTF module — splitPosition / mergePositions / redeemPositions on the Gnosis
// ConditionalTokens contract (plan: CTF work item).
//
//   split : $N USDC          -> N Up + N Down     (sources sell-side inventory)
//   merge : N Up + N Down    -> $N USDC           (instant pair -> cash, no order book, no fee)
//   redeem: winning shares   -> $1 each           (after resolution)
//
// Two implementations behind one interface:
//   PaperCTF — instant simulated ops with a configurable per-tx cost, so dry
//              economics include the gas/relay drag the plan warns about.
//   LiveCTF  — real Polygon transactions via ethers. Requires the tokens to be
//              held by the SIGNING EOA. Polymarket proxy wallets (signature
//              type 1) hold their tokens in the proxy contract, and routing
//              CTF calls through the proxy needs the relayer path the plan
//              says to verify on-box first — until that's verified, live CTF
//              with a proxy wallet is DISABLED and the strategy degrades to
//              hold-to-resolution (its permanent fallback).
//
// MergeBatcher: merges are batched (plan: "accumulate a window's completed
// pairs and merge once") so a 2-3c per-tx cost isn't paid per 10c pair.

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';   // ConditionalTokens (Polygon)
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';  // USDC.e collateral
const PARENT = '0x' + '0'.repeat(64);
const PARTITION = [1, 2];

const CTF_ABI = [
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
];
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

class PaperCTF {
  constructor({ txCostUsdc = 0.01 } = {}) {
    this.kind = 'paper';
    this.txCostUsdc = txCostUsdc;
    this.ops = [];
  }
  async split(conditionId, usdc) {
    this.ops.push({ op: 'split', conditionId, usdc });
    return { ok: true, shares: usdc, costUsdc: this.txCostUsdc, txHash: `paper-split-${this.ops.length}` };
  }
  async merge(conditionId, shares) {
    this.ops.push({ op: 'merge', conditionId, shares });
    return { ok: true, usdc: shares, costUsdc: this.txCostUsdc, txHash: `paper-merge-${this.ops.length}` };
  }
  async redeem(conditionId) {
    this.ops.push({ op: 'redeem', conditionId });
    return { ok: true, costUsdc: this.txCostUsdc, txHash: `paper-redeem-${this.ops.length}` };
  }
}

class LiveCTF {
  constructor() {
    this.kind = 'live';
    this.contract = null;
    this.usdc = null;
    this.disabledWhy = null;
  }

  async init() {
    const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 1);
    if (sigType !== 0 && process.env.ARB_PROXY_EXEC !== 'direct') {
      // Proxy wallets hold tokens in the proxy contract; a plain EOA call
      // splits/merges the EOA's own tokens, not the proxy's. Until the proxy
      // exec path is verified on the trading box, refuse rather than burn gas.
      this.disabledWhy = 'proxy wallet (POLY_SIGNATURE_TYPE!=0): CTF exec path unverified — holding to resolution instead. ' +
        'Verify the relayer/proxy call on-box, then set ARB_PROXY_EXEC=direct to enable.';
      return this;
    }
    const { Wallet, providers, Contract } = require('ethers');
    const rpc = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
    const signer = new Wallet(process.env.POLY_PRIVATE_KEY, new providers.JsonRpcProvider(rpc));
    this.contract = new Contract(CTF_ADDRESS, CTF_ABI, signer);
    this.usdc = new Contract(USDC_ADDRESS, ERC20_ABI, signer);
    this.signerAddress = signer.address;
    return this;
  }

  async ensureAllowance(usdcAmount) {
    const need = BigInt(Math.ceil(usdcAmount * 1e6));
    const have = BigInt((await this.usdc.allowance(this.signerAddress, CTF_ADDRESS)).toString());
    if (have < need) {
      const tx = await this.usdc.approve(CTF_ADDRESS, '0xffffffffffffffffffffffffffffffff');
      await tx.wait();
    }
  }

  async _run(fnName, args, result) {
    if (this.disabledWhy) return { ok: false, error: this.disabledWhy, ...result };
    try {
      const tx = await this.contract[fnName](...args);
      const rcpt = await tx.wait();
      const gasUsdc = null; // gas is paid in POL; reconcile actual cost off the receipt out-of-band
      return { ok: true, txHash: rcpt.transactionHash, costUsdc: gasUsdc, ...result };
    } catch (err) {
      return { ok: false, error: err.message, ...result };
    }
  }

  async split(conditionId, usdc) {
    if (!this.disabledWhy) {
      try {
        await this.ensureAllowance(usdc);
      } catch (err) {
        return { ok: false, error: `allowance check failed: ${err.message}`, shares: usdc };
      }
    }
    const amount = Math.round(usdc * 1e6);
    return this._run('splitPosition', [USDC_ADDRESS, PARENT, conditionId, PARTITION, amount], { shares: usdc });
  }

  async merge(conditionId, shares) {
    const amount = Math.round(shares * 1e6);
    return this._run('mergePositions', [USDC_ADDRESS, PARENT, conditionId, PARTITION, amount], { usdc: shares });
  }

  async redeem(conditionId) {
    return this._run('redeemPositions', [USDC_ADDRESS, PARENT, conditionId, PARTITION], {});
  }
}

/** Accumulates mergeable pair inventory and flushes one merge tx per condition. */
class MergeBatcher {
  constructor(ctf, onMerged, log = () => {}) {
    this.ctf = ctf;
    this.onMerged = onMerged; // ({pairId, shares, usdc, costShare}) per pair
    this.log = log;
    this.queue = new Map(); // conditionId -> [{pairId, shares}]
  }

  add(conditionId, pairId, shares) {
    if (!this.queue.has(conditionId)) this.queue.set(conditionId, []);
    this.queue.get(conditionId).push({ pairId, shares });
  }

  get pending() {
    let n = 0;
    for (const q of this.queue.values()) n += q.length;
    return n;
  }

  async flush() {
    for (const [conditionId, items] of [...this.queue]) {
      this.queue.delete(conditionId);
      const total = items.reduce((a, i) => a + i.shares, 0);
      if (total <= 0) continue;
      const res = await this.ctf.merge(conditionId, total);
      if (!res.ok) {
        this.log(`merge failed for ${conditionId.slice(0, 10)}…: ${res.error} — pairs hold to resolution`);
        continue; // pairs stay MATCHED and resolve normally (permanent fallback)
      }
      const costShare = (res.costUsdc || 0) / items.length;
      for (const i of items) {
        this.onMerged({ pairId: i.pairId, shares: i.shares, usdc: i.shares, costShare });
      }
      this.log(`merged ${total} pair-shares across ${items.length} pair(s) -> $${total} (${res.txHash})`);
    }
  }
}

module.exports = { PaperCTF, LiveCTF, MergeBatcher, CTF_ADDRESS, USDC_ADDRESS };
