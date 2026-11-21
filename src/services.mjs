// Wallets that look like a farm's collector to the sweep rule but are an
// app's or a business's payment wallet: many users pay them, so the payers
// are customers, not one person. Each entry names who confirmed it.
export const KNOWN_SERVICE_WALLETS = new Map([
  // Morb, 2026-11-21: "Mugshot's owned wallet where they collect subscription
  // payments. Users directly send the b3tr to that wallet." Was merging 217
  // subscribers into one "person".
  ['0x14750a75aa18ede1d0403d40d04aff9fe450ed48', 'Mugshot subscription payments'],
]);

/**
 * Collectors that look like a price list rather than a farm, for a person to
 * check (not excluded automatically): most payments in are the same round
 * amount (≥ 10 B3TR, a multiple of 5) from several different wallets. A farm
 * forwards whatever each wallet earned, so its amounts vary.
 * @param sweeps foldSweeps cache, @param dests addresses to check
 */
export function priceLikeCollectors(sweeps, dests, sinceTs, { minSenders = 5, minShare = 0.5 } = {}) {
  const want = new Set(dests);
  const by = new Map(); // dest → Map(amount → Set(sender))
  const total = new Map();
  for (const [at, f, d, amt] of sweeps.rows) {
    if (at < sinceTs) continue;
    const dest = sweeps.addrs[d];
    if (!want.has(dest)) continue;
    total.set(dest, (total.get(dest) ?? 0) + 1);
    const a = Math.round(amt * 1000) / 1000;
    if (a < 10 || a % 5 !== 0) continue;
    const m = by.get(dest) ?? by.set(dest, new Map()).get(dest);
    (m.get(a) ?? m.set(a, new Set()).get(a)).add(sweeps.addrs[f]);
  }
  const out = [];
  for (const [dest, m] of by) {
    let roundPays = 0;
    let top = [0, 0];
    for (const [a, s] of m) {
      roundPays += s.size;
      if (s.size > top[1]) top = [a, s.size];
    }
    const share = roundPays / total.get(dest);
    if (top[1] >= minSenders && share >= minShare) out.push({ dest, topAmount: top[0], payersOfTopAmount: top[1], roundShare: Math.round(share * 100) / 100 });
  }
  return out.sort((a, b) => b.payersOfTopAmount - a.payersOfTopAmount);
}
