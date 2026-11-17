// Where did a B3TR transfer OUT of a team wallet go? Pure functions.
//
// The labels are deliberately literal. "sold" means the transaction contained a
// swap in a pool that holds B3TR — not a guess from the address. Anything we
// cannot prove is reported as "other", with the address, so readers can look
// for themselves. Nobody is accused by inference.

import { GRANT_SOURCES, MAINNET, TOPIC } from './abi.mjs';

export const KINDS = /** @type {const} */ ([
  'sold', // the tx swapped in a B3TR pool
  'liquidity', // the tx added liquidity to a B3TR pool (not a sale)
  'rewards_pool', // re-deposited into the X2EarnRewardsPool (back to users)
  'vot3', // converted to VOT3 (voting power)
  'vbd_contract', // another VeBetterDAO contract
  'internal', // to another wallet of the same app / team
  'other_contract', // a contract we could not identify
  'other_wallet', // a plain wallet (person, exchange deposit, team member …)
]);

/**
 * What a transaction receipt shows about B3TR pools.
 * `b3trPools` is the set (lower-case) of pool addresses known to hold B3TR.
 * Returns which pools emitted a Swap / Mint, so the caller can resolve any
 * pool it has not looked up yet.
 */
export function receiptPoolEvents(receipt) {
  const swaps = new Set();
  const mints = new Set();
  for (const output of receipt?.outputs ?? []) {
    for (const ev of output.events ?? []) {
      const t0 = ev.topics?.[0];
      const addr = String(ev.address).toLowerCase();
      if (t0 === TOPIC.swapV2 || t0 === TOPIC.swapV3) swaps.add(addr);
      else if (t0 === TOPIC.mintV2) mints.add(addr);
    }
  }
  return { swaps, mints };
}

/**
 * The label for one outflow.
 * @param {object} p
 * @param {string} p.to recipient (any case)
 * @param {Set<string>} p.ownWallets lower-case wallets of the same app / team
 * @param {Record<string,string>} p.vbdContracts lower-case address → 'rewards_pool' | 'vot3' | 'vbd_contract'
 * @param {boolean} p.isContract does the recipient have code
 * @param {{swaps:Set<string>, mints:Set<string>}|null} p.poolEvents from receiptPoolEvents, or null if not fetched
 * @param {Set<string>} p.b3trPools lower-case pools that hold B3TR
 */
export function classifyOutflow({ to, ownWallets, vbdContracts, isContract, poolEvents, b3trPools }) {
  const addr = String(to).toLowerCase();
  if (ownWallets.has(addr)) return 'internal';
  const vbd = vbdContracts[addr];
  if (vbd) return vbd;
  if (poolEvents) {
    for (const p of poolEvents.swaps) if (b3trPools.has(p)) return 'sold';
    for (const p of poolEvents.mints) if (b3trPools.has(p)) return 'liquidity';
  }
  return isContract ? 'other_contract' : 'other_wallet';
}

/** Does a pool's token pair include B3TR? */
export function poolHoldsB3tr(token0, token1, b3tr) {
  const b = b3tr.toLowerCase();
  return [token0, token1].some((t) => typeof t === 'string' && t.toLowerCase() === b);
}

export const IN_KINDS = /** @type {const} */ ([
  'allocation', // team share of a round, from the XAllocationPool
  'pool_withdrawal', // withdrawn from the app's own rewards pool
  'grants_dao', // GrantsManager, Treasury, Timelock or the foundation multisig
  'bought', // out of a B3TR swap pool (a purchase)
  'from_vot3', // converted back from VOT3
  'vbd_other', // another VeBetterDAO contract
  'internal', // from another wallet of the same app / team
  'other_contract',
  'other_wallet',
]);

const XAP = MAINNET.xAllocationPool.toLowerCase();
const POOL = MAINNET.x2EarnRewardsPool.toLowerCase();
const VOT3 = MAINNET.vot3.toLowerCase();

/** Where one transfer INTO a team wallet came from. Pure. */
export function classifyInflow({ from, ownWallets, vbdContracts, isContract, isB3trPool }) {
  const a = String(from).toLowerCase();
  if (ownWallets.has(a)) return 'internal';
  if (a === XAP) return 'allocation';
  if (a === POOL) return 'pool_withdrawal';
  if (GRANT_SOURCES.has(a)) return 'grants_dao';
  if (a === VOT3) return 'from_vot3';
  if (vbdContracts[a]) return 'vbd_other';
  if (isB3trPool) return 'bought';
  return isContract ? 'other_contract' : 'other_wallet';
}
