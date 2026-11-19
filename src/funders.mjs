// "Same funder" (Vinny, 2026-11-19): farmers make a batch of new wallets and
// send each one its first VET or VTHO (for gas) from one wallet. Reward
// wallets whose FIRST VET/VTHO came from the same plain wallet are linked as
// one person, together with that funder.
//
// Guards, because exchanges and onboarding services fund thousands of
// strangers: the funder must not be a contract, a team wallet, a VeBetterDAO
// or grant address, or the zero address; and it must have funded at most
// MAX_FUNDED reward wallets. Bigger funders are reported, not merged.

export const MAX_FUNDED = 50;
const ZERO = '0x0000000000000000000000000000000000000000';

/** Earliest of the candidate first-fundings, or null. */
export function earliestFunding(...cands) {
  const c = cands.filter((x) => x && x.from && x.from !== ZERO);
  if (!c.length) return null;
  return c.reduce((a, b) => (b.block < a.block ? b : a));
}

/**
 * @param firstFunder Map wallet → funder address (lower-case) | null
 * @param wallets     reward wallets to consider
 * @param isExcluded  (addr) => true for contracts, team wallets, DAO addresses
 */
export function funderLinks(firstFunder, wallets, isExcluded, { maxFunded = MAX_FUNDED } = {}) {
  const funded = new Map();
  for (const w of wallets) {
    const f = firstFunder[w];
    if (!f || f === ZERO || f === w || isExcluded(f)) continue;
    if (!funded.has(f)) funded.set(f, []);
    funded.get(f).push(w);
  }
  const pairs = [];
  const groups = [];
  const tooBig = [];
  for (const [funder, ws] of funded) {
    if (ws.length < 2) continue;
    if (ws.length > maxFunded) {
      tooBig.push({ funder, wallets: ws.length });
      continue;
    }
    ws.sort();
    for (const w of ws) pairs.push([w, funder]);
    groups.push({ funder, wallets: ws });
  }
  groups.sort((a, b) => b.wallets.length - a.wallets.length);
  tooBig.sort((a, b) => b.wallets - a.wallets);
  return { pairs, groups, tooBig };
}
