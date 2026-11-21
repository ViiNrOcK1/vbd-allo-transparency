// "Same funder" (Vinny, 2026-11-19): farmers make a batch of new wallets and
// send each one its first VET or VTHO (for gas) from one wallet. Reward
// wallets whose FIRST VET/VTHO came from the same plain wallet are linked as
// one person, together with that funder.
//
// Guards, because exchanges and onboarding services fund thousands of
// strangers: the funder must not be a contract, a team wallet, a VeBetterDAO
// or grant address, or the zero address; and it must have funded at most
// MAX_FUNDED reward wallets. Bigger funders are reported, not merged.
// Audit 2026-11-19: the biggest "funders" were Coinbase, Binance, MEXC and
// Bitget hot wallets (exchange withdrawals). A farm's funder sends mostly to
// its own farm wallets; an exchange sends to huge numbers of other wallets.
// So a funder is a service (never links) when its lifetime VET + VTHO
// transfers out exceed busyLimit(fundedRewardWallets). Counts cap at BUSY_CAP.
export const BUSY_CAP = 1000; // the node refuses limit > 1,000 (HTTP 403)
export const busyLimit = (funded) => 3 * funded + 50;

export const MAX_FUNDED = 300;
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
export function funderLinks(firstFunder, wallets, isExcluded, { maxFunded = MAX_FUNDED, isService = () => false, confirm = () => true } = {}) {
  const funded = new Map();
  for (const w of wallets) {
    const f = firstFunder[w];
    if (!f || f === ZERO || f === w || isExcluded(f) || isService(f)) continue;
    if (!funded.has(f)) funded.set(f, []);
    funded.get(f).push(w);
  }
  const pairs = [];
  const groups = [];
  const tooBig = [];
  const unconfirmed = [];
  for (const [funder, ws] of funded) {
    if (ws.length < 2) continue;
    if (ws.length > maxFunded) {
      tooBig.push({ funder, wallets: ws.length });
      continue;
    }
    ws.sort();
    if (!confirm(funder, ws)) {
      unconfirmed.push({ funder, wallets: ws });
      continue;
    }
    for (const w of ws) pairs.push([w, funder]);
    groups.push({ funder, wallets: ws });
  }
  groups.sort((a, b) => b.wallets.length - a.wallets.length);
  tooBig.sort((a, b) => b.wallets - a.wallets);
  unconfirmed.sort((a, b) => b.wallets.length - a.wallets.length);
  return { pairs, groups, tooBig, unconfirmed };
}

// ── A shared funder is not enough on its own (Morb's review, 2026-11-21) ──
// Two of six funder groups he checked were a Japanese community whose
// members send each other VTHO for gas: generous people, not farms. Real
// farm funders showed one of two extra signs, so a shared first funder now
// links wallets only with one of them:
//   1. Money flows back: at least FLOW_BACK_MIN funded wallets sent B3TR or
//      VOT3 to the funder (a gift of gas goes one way; a farm brings the
//      rewards home).
//   2. A batch: at least BURST_SHARE of the wallets were first funded within
//      BURST_DAYS of each other AND at least SAME_APP_SHARE earn mostly from
//      the same app (0x4b38…: 45 wallets in 6 days, one app; the community
//      funded people over weeks, who use many different apps).
export const FLOW_BACK_MIN = 2;
export const BURST_DAYS = 7;
export const BURST_SHARE = 0.7;
export const SAME_APP_SHARE = 0.7;

/**
 * @param wallets   the funded reward wallets
 * @param fundedAt  (w) => unix time of its first funding, or undefined
 * @param topAppOf  (w) => the app it earned most from, or undefined
 * @param sentBack  (w) => B3TR+VOT3 it sent the funder (window)
 */
export function funderEvidence(wallets, { fundedAt = () => undefined, topAppOf = () => undefined, sentBack = () => 0 } = {}) {
  const n = wallets.length;
  const ts = wallets.map(fundedAt).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  let burst = 0;
  for (let i = 0, j = 0; j < ts.length; j++) {
    while (ts[j] - ts[i] > BURST_DAYS * 86_400) i++;
    burst = Math.max(burst, j - i + 1);
  }
  const apps = new Map();
  for (const w of wallets) {
    const a = topAppOf(w);
    if (a !== undefined) apps.set(a, (apps.get(a) ?? 0) + 1);
  }
  const [topApp, topN] = [...apps.entries()].sort((a, b) => b[1] - a[1])[0] ?? [undefined, 0];
  const flowBack = wallets.filter((w) => sentBack(w) > 0).length;
  return { n, burstShare: n ? burst / n : 0, topApp, topAppShare: n ? topN / n : 0, flowBack };
}

export function funderConfirmed(ev) {
  if (ev.flowBack >= Math.min(FLOW_BACK_MIN, ev.n)) return true;
  return ev.burstShare >= BURST_SHARE && ev.topAppShare >= SAME_APP_SHARE;
}
