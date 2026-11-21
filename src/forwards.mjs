// Collector networks (Morb, 2026-11-21: "it is very common for bad actors to
// have multiple reward collection wallets"). The sweep rule (sweeps.mjs)
// links reward wallets to the wallet they send their rewards to. A farmer
// with several collectors stayed several "people". This follows the money
// one or two hops further:
//
//   - a collector (or a wallet a collector forwards to) that passed on at
//     least MIN_SHARE (60%) of the B3TR + VOT3 it received in the window to the
//     same next wallet is linked to that next wallet. Collectors that end at
//     the same next wallet become one person. An exchange deposit address is
//     unique to one customer, so it counts as a next wallet; the exchange's
//     hot wallet behind it does not (busy, below).
//   - the next wallet must be a plain wallet (not a contract such as a DEX
//     router, not a team / DAO address) and not a service: at most
//     MAX_SOURCES outside wallets (not reward wallets, not other wallets in
//     the network) sent it B3TR / VOT3 in the window, and not busy (isBad
//     covers lifetime activity, checked by the caller). Reward wallets don't
//     count as outsiders, so a collector that forwards to a bigger collector
//     still links.
// Each hop needs a majority of the money, so a farmer's collector that pays
// a shop once does not merge the farm with the shop.

// 0.6, not 0.5 (audit 2026-11-21): three collectors each sent exactly half
// to one wallet, which reads as a revenue split, not one owner.
export const MIN_SHARE = 0.6;
export const MAX_SOURCES = 25;
export const MIN_AMOUNT = 1; // B3TR; dust moves are not forwarding

/**
 * @param flows  Map addr → { in: number, out: Map<to, number>, sources?: number }
 *               (B3TR + VOT3 over the window; sources = distinct senders in)
 * @param isBad  (addr) => true for contracts, team / DAO wallets, services
 * @returns {{ pairs: string[][], links: {from:string,to:string,share:number}[], skipped: {to:string, why:string}[] }}
 */
export function forwardLinks(flows, isBad, { minShare = MIN_SHARE, maxSources = MAX_SOURCES, minAmount = MIN_AMOUNT } = {}) {
  const links = [];
  const skipped = [];
  for (const [from, f] of flows) {
    if (!(f.in > 0)) continue;
    for (const [to, amt] of f.out ?? []) {
      if (to === from || amt < minAmount || amt < minShare * f.in) continue;
      if (isBad(to)) {
        skipped.push({ to, why: 'service or contract' });
        continue;
      }
      const src = flows.get(to)?.sources;
      if (src !== undefined && src > maxSources) {
        skipped.push({ to, why: `${src} senders` });
        continue;
      }
      links.push({ from, to, share: Math.min(1, amt / f.in) });
    }
  }
  links.sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1));
  return { pairs: links.map((l) => [l.from, l.to]), links, skipped };
}

/** Fold B3TR / VOT3 transfer logs touching `addr` into one flows entry.
 * `sources` counts distinct senders in for which isInsider is false. */
export function flowOf(addr, transfers, isInsider = () => false) {
  const a = addr.toLowerCase();
  const out = new Map();
  const senders = new Set();
  let inn = 0;
  for (const t of transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    if (from === to) continue;
    if (to === a) {
      inn += t.amount;
      if (!isInsider(from)) senders.add(from);
    } else if (from === a) out.set(to, (out.get(to) ?? 0) + t.amount);
  }
  return { in: inn, out, sources: senders.size };
}
