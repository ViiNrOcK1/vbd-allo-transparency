// Links checked by a person (Vinny, 2026-11-21: "the blockchain is public;
// the point is transparency"). For networks the automatic rules can't join
// on their own, e.g. a farmer whose wallets are only connected through an
// exchange account. Every entry says who reviewed it, when, and the on-chain
// evidence, so anyone can check it. A link means "one operator", nothing
// more; entries are added only after the reviewer confirms them.
//
// DISCLAIMER: these are estimates from public on-chain data and can be
// wrong. Entries are corrected or removed as new evidence comes in, to keep
// the data as accurate and precise as possible. Spot a mistake? Tell
// B3TR Beach and it will be checked.
export const REVIEWED_LINKS = [
  {
    wallets: ['0x5ea9700efcfded17b7521186efc42e830501cb77', '0x38d3d4b247727d3d1e28e1a9dc54f2937d61505d'],
    reviewedBy: 'morbidejs',
    date: '2026-11-21',
    evidence:
      '0x38d3… (a wallet that collects rewards from ~50 wallets) was first funded by 0x5ea9… on 2026-09-21, as were its member wallets, and forwards 96% of what it receives to another wallet 0x5ea9… funded. Reviewer: side branch of the same network.',
  },
];

/** Pairs for people.mjs: each entry's wallets chained to its first wallet. */
export function reviewedPairs(list = REVIEWED_LINKS) {
  const pairs = [];
  for (const e of list) {
    const ws = e.wallets.map((w) => w.toLowerCase());
    for (const w of ws.slice(1)) pairs.push([w, ws[0]]);
  }
  return pairs;
}
