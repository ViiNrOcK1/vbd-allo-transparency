// Team money that was sold from another wallet — followed hop by hop
// (Vinny, 2026-11-24/25: "follow all the hops u can").
//
// Mugshot: team wallet → 0x1641… (sold some itself) → 0x4123… (funded only
// by 0x1641, sold all 3.07M). The team wallet's own swaps showed 265k sold.
//
// Model: lots. Each team transfer of at least MIN_B3TR to a plain wallet is
// a lot. In each wallet, lots are spent oldest first, in time order:
//   - a swap in a B3TR pool sells them (counted as the team's sale, "via"
//     that wallet), but only lots that arrived there within WINDOW_DAYS;
//   - a transfer of at least MIN_B3TR to another plain wallet moves them on
//     (the next hop);
//   - anything else (VOT3, other contracts, small transfers, back to the
//     team) uses them up without counting as a sale.
// A wallet passes lots on only if it is a pass-through: at least
// MIN_TEAM_SHARE of what it received, from the day before its first lot up
// to its last move, came from the team or wallets already found to be
// pass-throughs. Someone's own wallet with other income stops the trail.
// Exchanges and busy services stop it too (the caller returns null).

export const MIN_B3TR = 1000n * 10n ** 18n;
export const WINDOW_DAYS = 30;
export const MIN_TEAM_SHARE = 0.9;
export const MAX_HOPS = 8;
const DAY = 86_400;

/**
 * @param seeds    Map<wallet, [{ ref, value: bigint, at }]> — team transfers (ref = the team flow)
 * @param flowsOf  async (wallet) => { outflows: [{kind, to, value, at, txId}], inflows: [{from, value, at}] } | null
 * @param isTeam   (wallet) => boolean
 * @returns { sold: Map<ref, [{ value, at, txId, via, saleValue, hop }]>, stats }
 */
export async function traceLots({
  seeds,
  flowsOf,
  isTeam,
  isStop = isTeam, // other apps' team wallets: the trail ends there too
  maxHops = MAX_HOPS,
  windowDays = WINDOW_DAYS,
  minShare = MIN_TEAM_SHARE,
  minValue = MIN_B3TR,
  maxWallets = 500,
  cache = new Map(), // wallet → flows; share it across calls so the budget is global
  concurrency = 4,
}) {
  const pass = new Set();
  const rejected = new Set();
  const sold = new Map();
  const stats = { passThrough: 0, deepestHop: 0, stoppedAtCap: 0 };
  const lotTotal = (ls) => ls.reduce((a, l) => a + l.value, 0n);
  let frontier = seeds;
  for (let hop = 1; hop <= maxHops && frontier.size; hop++) {
    const next = new Map();
    // Biggest amounts first, so the wallet budget goes where the money is.
    const order = [...frontier].filter(([w]) => !isStop(w) && !rejected.has(w)).sort((a, b) => (lotTotal(b[1]) > lotTotal(a[1]) ? 1 : -1));
    const want = [];
    for (const [w] of order) {
      if (cache.has(w)) continue;
      if (cache.size + want.length >= maxWallets) stats.stoppedAtCap++;
      else want.push(w);
    }
    for (let i = 0; i < want.length; i += concurrency) {
      const part = want.slice(i, i + concurrency);
      const got = await Promise.all(part.map((w) => flowsOf(w)));
      part.forEach((w, j) => cache.set(w, got[j]));
    }
    // Decide who is a pass-through, repeating until nothing changes: in one
    // hop, A's share may only reach 90% once B (which also fed A) is in.
    const shareOk = (w) => {
      const f = cache.get(w);
      const lots = frontier.get(w).filter((l) => l.value > 0n);
      if (!f || !lots.length) return false;
      const firstAt = Math.min(...lots.map((l) => l.at));
      const outAts = f.outflows.filter((o) => o.at != null && o.at >= firstAt).map((o) => o.at);
      const lastAt = outAts.length ? Math.max(...outAts) : firstAt;
      let fromTeam = 0n;
      let total = 0n;
      for (const i of f.inflows) {
        if (i.at == null || i.at < firstAt - DAY || i.at > lastAt) continue;
        total += i.value;
        if (isTeam(i.from) || pass.has(i.from)) fromTeam += i.value;
      }
      return total > 0n && Number((fromTeam * 1000n) / total) / 1000 >= minShare;
    };
    for (let changed = true; changed; ) {
      changed = false;
      for (const [w] of order) {
        if (pass.has(w) || !cache.has(w)) continue;
        if (cache.get(w) === null) {
          rejected.add(w); // busy / exchange
          continue;
        }
        if (shareOk(w)) {
          pass.add(w);
          stats.passThrough++;
          changed = true;
        }
      }
    }
    for (const [w, lotsIn] of order) {
      if (!pass.has(w)) continue; // over budget, busy, or not a pass-through (yet)
      const f = cache.get(w);
      const lots = lotsIn.filter((l) => l.value > 0n).sort((a, b) => a.at - b.at);
      if (!lots.length) continue;
      const outs = f.outflows.filter((o) => o.at != null && o.at >= lots[0].at).sort((a, b) => a.at - b.at);
      stats.deepestHop = Math.max(stats.deepestHop, hop);
      const take = (t, amount, maxAge) => {
        const got = [];
        let need = amount;
        for (const l of lots) {
          if (need === 0n) break;
          if (l.value === 0n || l.at > t || (maxAge != null && t - l.at > maxAge)) continue;
          const x = l.value < need ? l.value : need;
          l.value -= x;
          need -= x;
          got.push({ ref: l.ref, value: x });
        }
        return got;
      };
      for (const o of outs) {
        // A later visit (more lots via another path) must not reuse what an
        // earlier visit already matched.
        o.left ??= o.value;
        if (o.left === 0n) continue;
        let got;
        if (o.kind === 'sold') {
          got = take(o.at, o.left, windowDays * DAY);
          for (const g of got) {
            (sold.get(g.ref) ?? sold.set(g.ref, []).get(g.ref)).push({ value: g.value, at: o.at, txId: o.txId, via: w, saleValue: o.value, hop });
          }
        } else if (o.kind === 'other_wallet' && o.value >= minValue && o.to && !isStop(o.to)) {
          got = take(o.at, o.left, null);
          for (const g of got) (next.get(o.to) ?? next.set(o.to, []).get(o.to)).push({ ref: g.ref, value: g.value, at: o.at });
        } else {
          got = take(o.at, o.left, null);
        }
        o.left -= got.reduce((a, g) => a + g.value, 0n);
      }
    }
    frontier = next;
  }
  return { sold, stats };
}

/**
 * Back-compat for one recipient (used by tests): the same rules, one hop.
 * @returns for each transfer: { sold: [{value, at, txId, saleValue}], rest }
 */
export async function passThroughSales(transfers, recipient, teamWallets, opts = {}) {
  const refs = transfers.map((t, i) => ({ i, t }));
  const seeds = new Map([['0xrecipient', refs.filter(({ t }) => t.value >= (opts.minValue ?? MIN_B3TR)).map(({ i, t }) => ({ ref: i, value: t.value, at: t.at }))]]);
  const { sold } = await traceLots({ seeds, flowsOf: async () => structuredClone(recipient), isTeam: (w) => teamWallets.has(w), maxHops: 1, ...opts });
  return transfers.map((t, i) => {
    const s = (sold.get(i) ?? []).map(({ value, at, txId, saleValue }) => ({ value, at, txId, saleValue }));
    return { sold: s, rest: t.value - s.reduce((a, x) => a + x.value, 0n) };
  });
}
