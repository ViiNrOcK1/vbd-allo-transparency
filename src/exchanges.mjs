// Team money sent to exchanges (Vinny, 2026-11-27/28: follow it to the
// exchanges; Morb named the hot wallets 2026-11-28, as labelled on
// VeChainStats).
//
// A team transfer counts as sent to an exchange when it goes
//   - straight to a known exchange hot wallet, or
//   - to a deposit address: a plain wallet that passed at least
//     DEPOSIT_SHARE of what it ever sent (same token) to ONE known exchange
//     hot wallet. Exchanges give each customer their own deposit address,
//     so this is the team's own exchange account.
// What happens inside the exchange can't be seen on chain.

export const EXCHANGE_WALLETS = new Map([
  ['0x9a107a75cff525b033a3e53cadafe3d193b570ec', 'MEXC'],
  ['0x44bc93a8d3cefa5a6721723a2f8d2e4f7d480ba0', 'Binance'],
  ['0x15bccf377f1a9bbd0cd8e24d031c9451326f29a0', 'OceanEX'],
  ['0xf89d7b9c864f589bbf53a82105107622b35eaa40', 'Bybit'],
  ['0xdb4962f5718947fcbec44845c3c40240344a050a', 'Kraken'],
]);
export const EXCHANGE_SOURCE = 'hot wallets named by morbidejs, 2026-11-28, as labelled on VeChainStats';
export const DEPOSIT_SHARE = 0.8;

/** Which exchange a wallet deposits to, from everything it sent: name or null. */
export function depositExchange(outs, exchanges = EXCHANGE_WALLETS, share = DEPOSIT_SHARE) {
  let total = 0;
  const by = new Map();
  for (const o of outs) {
    if (!(o.value > 0)) continue;
    total += o.value;
    by.set(o.to, (by.get(o.to) ?? 0) + o.value);
  }
  if (!total) return null;
  const [top, v] = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
  return exchanges.has(top) && v >= share * total ? exchanges.get(top) : null;
}

/**
 * @param flows  [{ app, token: 'B3TR'|'VET', to, value (whole units), at }]
 * @param classify async (token, to) => exchange name | null
 * @param usdAt  (token, ts) => USD per unit | null
 * @returns { [app]: { B3TR: {total, usd, byExchange: {name: {amount, usd, direct, viaDeposit}}}, VET: {...} } }
 */
export async function exchangeTotals(flows, classify, usdAt) {
  const out = {};
  for (const f of flows) {
    const direct = EXCHANGE_WALLETS.get(f.to);
    const ex = direct ?? (await classify(f.token, f.to));
    if (!ex) continue;
    const t = ((out[f.app] ??= {})[f.token] ??= { total: 0, usd: 0, byExchange: {} });
    const e = (t.byExchange[ex] ??= { amount: 0, usd: 0, direct: 0, viaDeposit: 0 });
    const usd = (usdAt(f.token, f.at) ?? 0) * f.value;
    t.total += f.value;
    t.usd += usd;
    e.amount += f.value;
    e.usd += usd;
    if (direct) e.direct += f.value;
    else e.viaDeposit += f.value;
  }
  return out;
}
