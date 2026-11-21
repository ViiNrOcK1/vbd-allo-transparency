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
  {
    wallets: ['0x4b3882b52654a044f1bd0f7de0247a30a19d7e4b', '0x8df42cd6a5fd1f8682fcf9d7b5fb4d2d9e58ca68'],
    reviewedBy: 'Sett (PerGram developer) and Pokerdutchie',
    date: '2026-11-21',
    evidence:
      '0x4b38… first funded 45 wallets (2026-10-26 to 11-01) and 0x8df4… first funded 25 wallets (all on 2026-11-17); all 70 earn only from PerGram and convert their rewards to VOT3. Both funders got their VTHO from the same exchange hot wallet (Kraken, 0xdb49…050a) on 2026-11-17, hours apart: 17,300 VTHO at 05:04 UTC (tx 0xd37c5f38…49b4) and 17,000 VTHO at 14:20 UTC (tx 0x5d9d4b98…fef9); 0x4b38… also got 14,300 VTHO on 2026-10-26 (tx 0xe1730157…1490). Pokerdutchie found the 70 wallets as one set; the PerGram developer checked them and found almost all uploaded receipts from the camera roll instead of live photos.',
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
