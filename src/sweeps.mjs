// "Sweeps": wallets that send most of their rewards to the same wallet are
// very likely one person's (Vinny, 2026-11-19: "one user can have multiple
// wallets"). This is the usual farm pattern: many reward wallets, one
// collection wallet. An exchange deposit address is normally unique to one
// customer, so several reward wallets sending to the same one also counts.
//
// A link needs ALL of these (so ordinary payments don't merge strangers):
//   - the sender is a reward receiver, and sent the destination at least
//     MIN_SHARE of the rewards it received in the window;
//   - the destination is a plain wallet: not a contract, not any app's team
//     wallet, not a VeBetterDAO / grant address;
//   - at least 2 and at most MAX_SENDERS (50) reward wallets do this to the
//     same destination (more looks like a service, e.g. a shop or a hot
//     wallet, or a big farm we can't tell apart from one: reported, not merged).
// Linked wallets plus their destination become one person (with Passport
// links, people.mjs). Still a ceiling: a careful farmer with separate
// collection wallets isn't caught.

export const MIN_SHARE = 0.5;
export const MAX_SENDERS = 50;
export const KEEP_DAYS = 100;
const DAY = 86_400;

/** Empty cache: rows are [unixTs, fromIdx, toIdx, b3trWhole]. */
export const emptySweeps = () => ({ lastBlock: -1, firstTs: null, addrs: [], rows: [] });

/**
 * Add B3TR transfers (only those whose sender passes keepFrom) and drop rows
 * older than KEEP_DAYS.
 * @param {{at:number, from:string, to:string, amount:bigint}[]} transfers
 */
export function foldSweeps(c, transfers, keepFrom, nowTs) {
  const idx = new Map(c.addrs.map((a, i) => [a, i]));
  const id = (a) => {
    let i = idx.get(a);
    if (i === undefined) {
      i = c.addrs.length;
      c.addrs.push(a);
      idx.set(a, i);
    }
    return i;
  };
  for (const t of transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    if (from === to || !keepFrom(from)) continue;
    c.rows.push([t.at, id(from), id(to), Number(t.amount / 10n ** 15n) / 1000]);
    if (c.firstTs == null || t.at < c.firstTs) c.firstTs = t.at;
  }
  const cutoff = nowTs - KEEP_DAYS * DAY;
  c.rows = c.rows.filter((r) => r[0] >= cutoff);
  if (c.firstTs != null && c.firstTs < cutoff) c.firstTs = cutoff;
  return c;
}

/**
 * Sweep links for the last windowDays.
 * @param sweeps   foldSweeps cache
 * @param payouts  users.mjs payouts cache (rewards per receiver)
 * @param isExcluded (addr) => true for contracts / team wallets / DAO addresses
 * @returns {{ pairs: string[][], groups: {dest:string, wallets:string[]}[], tooBig: {dest:string, senders:number}[] }}
 */
export function sweepLinks(sweeps, payouts, nowTs, isExcluded, { windowDays = 90, minShare = MIN_SHARE, maxSenders = MAX_SENDERS } = {}) {
  const since = nowTs - windowDays * DAY;
  const rewards = new Map();
  for (const [at, , r, amt] of payouts.rows) {
    if (at < since) continue;
    const w = payouts.receivers[r];
    rewards.set(w, (rewards.get(w) ?? 0) + amt);
  }
  const sent = new Map(); // "from|to" → b3tr
  for (const [at, f, t, amt] of sweeps.rows) {
    if (at < since) continue;
    const k = `${sweeps.addrs[f]}|${sweeps.addrs[t]}`;
    sent.set(k, (sent.get(k) ?? 0) + amt);
  }
  const sendersOf = new Map();
  for (const [k, amt] of sent) {
    const [from, to] = k.split('|');
    const got = rewards.get(from) ?? 0;
    if (got <= 0 || amt < minShare * got) continue;
    if (!sendersOf.has(to)) sendersOf.set(to, new Set());
    sendersOf.get(to).add(from);
  }
  const pairs = [];
  const groups = [];
  const tooBig = [];
  for (const [dest, s] of sendersOf) {
    if (s.size < 2 || isExcluded(dest)) continue;
    if (s.size > maxSenders) {
      tooBig.push({ dest, senders: s.size });
      continue;
    }
    const wallets = [...s].sort();
    for (const w of wallets) pairs.push([w, dest]);
    groups.push({ dest, wallets });
  }
  groups.sort((a, b) => b.wallets.length - a.wallets.length);
  tooBig.sort((a, b) => b.senders - a.senders);
  return { pairs, groups, tooBig };
}

/** Destinations worth checking for contract code (≥2 qualifying senders). */
export function candidateDestinations(sweeps, payouts, nowTs, opts) {
  return sweepLinks(sweeps, payouts, nowTs, () => false, { ...opts, maxSenders: Infinity }).groups.map((g) => g.dest);
}
