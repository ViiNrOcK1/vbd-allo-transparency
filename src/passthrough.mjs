// Team money that was sold from another wallet (Vinny, 2026-11-24).
//
// Mugshot's team wallet sent 226,908 B3TR to a plain wallet on Nov 16; that
// wallet sold exactly that on Nov 24. Only the team wallet's own swaps
// counted as "sold", so the tracker showed it as "sent to other wallets".
//
// One hop, and strict, so paying a person isn't read as the team selling:
//   - the team sent at least MIN_B3TR to a plain wallet (not a contract,
//     not another wallet of the same app);
//   - that wallet swapped B3TR in a pool within WINDOW_DAYS after receiving it;
//   - at least MIN_TEAM_SHARE of what it received from the day before the
//     transfer up to its last such sale came from this app's wallets — a
//     pass-through, not someone's own wallet with other income.
// Only what it actually sold counts, up to what it received from the team,
// and each sale is used once (several transfers to the same wallet are
// matched oldest first).

export const MIN_B3TR = 1000n * 10n ** 18n;
export const WINDOW_DAYS = 30;
export const MIN_TEAM_SHARE = 0.9;
const DAY = 86_400;

/**
 * @param transfers  team outflows to ONE recipient: [{ value: bigint, at: number, txId }]
 * @param recipient  that recipient's flows: { outflows: [{kind, value, at, txId}], inflows: [{from, value, at}] }
 * @param teamWallets  Set of this app's wallets (lower-case)
 * @returns for each transfer (same order): { sold: [{ value, at, txId, saleValue }], rest: bigint }
 */
export function passThroughSales(transfers, recipient, teamWallets, { windowDays = WINDOW_DAYS, minShare = MIN_TEAM_SHARE } = {}) {
  const sales = (recipient.outflows ?? [])
    .filter((f) => f.kind === 'sold')
    .map((f) => ({ ...f, left: f.value }))
    .sort((a, b) => a.at - b.at);
  const order = transfers.map((t, i) => ({ ...t, i })).sort((a, b) => a.at - b.at);
  const out = transfers.map((t) => ({ sold: [], rest: t.value }));
  for (const t of order) {
    if (t.value < MIN_B3TR) continue;
    const inWindow = sales.filter((s) => s.at >= t.at && s.at <= t.at + windowDays * DAY && s.left > 0n);
    if (!inWindow.length) continue;
    const lastSale = inWindow[inWindow.length - 1].at;
    let fromTeam = 0n;
    let total = 0n;
    for (const f of recipient.inflows ?? []) {
      if (f.at == null || f.at < t.at - DAY || f.at > lastSale) continue;
      total += f.value;
      if (teamWallets.has(String(f.from).toLowerCase())) fromTeam += f.value;
    }
    if (total === 0n || Number((fromTeam * 1000n) / total) / 1000 < minShare) continue;
    let need = t.value;
    for (const s of inWindow) {
      if (need === 0n) break;
      const take = s.left < need ? s.left : need;
      if (take === 0n) continue;
      s.left -= take;
      need -= take;
      out[t.i].sold.push({ value: take, at: s.at, txId: s.txId, saleValue: s.value });
    }
    out[t.i].rest = need;
  }
  return out;
}
