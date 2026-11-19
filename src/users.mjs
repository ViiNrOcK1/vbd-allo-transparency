// Users per app = distinct wallets the app paid (RewardDistributed on the
// X2EarnRewardsPool), over the last 30 and 90 days. This is the same thing
// B3TR Beach's own admin panel counts, so the two can be compared directly.
// Recent windows only: all-time would mean reading ~9M events every run.

export const WINDOW_DAYS = 90;
const KEEP_DAYS = 100;
const DAY = 86_400;

/** Empty cache: rows are [unixTs, appIndex, receiverIndex, b3trWhole]. */
export const emptyPayouts = () => ({ lastBlock: -1, apps: [], receivers: [], rows: [] });

/**
 * Add decoded payouts and drop anything older than KEEP_DAYS.
 * @param {ReturnType<typeof emptyPayouts>} c
 * @param {{at:number, appId:string, receiver:string, amount:bigint}[]} payouts
 */
export function foldPayouts(c, payouts, nowTs) {
  const appIdx = new Map(c.apps.map((a, i) => [a, i]));
  const recIdx = new Map(c.receivers.map((r, i) => [r, i]));
  const idx = (map, list, key) => {
    let i = map.get(key);
    if (i === undefined) {
      i = list.length;
      list.push(key);
      map.set(key, i);
    }
    return i;
  };
  for (const p of payouts) {
    c.rows.push([p.at, idx(appIdx, c.apps, p.appId.toLowerCase()), idx(recIdx, c.receivers, p.receiver.toLowerCase()), Number(p.amount / 10n ** 15n) / 1000]);
  }
  const cutoff = nowTs - KEEP_DAYS * DAY;
  c.rows = c.rows.filter((r) => r[0] >= cutoff);
  return c;
}

/**
 * Per app (lower-case id): users and payouts in the last 30 / 90 days, plus
 * ecosystem totals. `excludeOf[appId]` = wallets that are not users of that
 * app: its own team wallets and wallets that endorsed it (Morb, 2026-11-18:
 * endorser and team rewards are paid through the same call as user rewards).
 */
export function userStats(c, nowTs, excludeOf = {}, personOf = null) {
  const per = new Map();
  const eco30 = new Set();
  const eco90 = new Set();
  // People: wallets linked through VeBetter Passport count once (people.mjs).
  const pc = new Map();
  const person = (r) => {
    if (!personOf) return r;
    let p = pc.get(r);
    if (p === undefined) pc.set(r, (p = personOf(c.receivers[r])));
    return p;
  };
  const ppl30 = new Set();
  const ppl90 = new Set();
  for (const [at, a, r, amt] of c.rows) {
    const age = nowTs - at;
    if (age > WINDOW_DAYS * DAY || age < 0) continue;
    const id = c.apps[a];
    if (excludeOf[id]?.has(c.receivers[r])) continue;
    let s = per.get(id);
    if (!s) per.set(id, (s = { u30: new Set(), u90: new Set(), p30: new Set(), p90: new Set(), payouts30: 0, payouts90: 0, b3tr90: 0, byReceiver: new Map() }));
    s.u90.add(r);
    s.p90.add(person(r));
    ppl90.add(person(r));
    s.payouts90++;
    s.b3tr90 += amt;
    s.byReceiver.set(r, (s.byReceiver.get(r) ?? 0) + amt);
    eco90.add(r);
    if (age <= 30 * DAY) {
      s.u30.add(r);
      s.p30.add(person(r));
      ppl30.add(person(r));
      s.payouts30++;
      eco30.add(r);
    }
  }
  const apps = {};
  for (const [id, s] of per) {
    // Concentration (Morb, 2026-11-18): an app that pays rewards in bulk to
    // one wallet and hands them out by plain transfers (Juicy Finance), or
    // pays its team through a wallet it never registered, shows up as one
    // receiver taking most of the rewards. Facts only: the share and the
    // address, for readers to check.
    const ranked = [...s.byReceiver.entries()].sort((a, b) => b[1] - a[1]);
    const share = (n) => (s.b3tr90 > 0 ? Math.round((ranked.slice(0, n).reduce((x, [, v]) => x + v, 0) / s.b3tr90) * 1000) / 10 : 0);
    apps[id] = {
      users30: s.u30.size,
      users90: s.u90.size,
      people30: s.p30.size,
      people90: s.p90.size,
      payouts30: s.payouts30,
      payouts90: s.payouts90,
      b3tr90: Math.round(s.b3tr90),
      topReceiver90: ranked[0] ? { address: c.receivers[ranked[0][0]], b3tr: Math.round(ranked[0][1]), sharePct: share(1) } : null,
      top5SharePct90: share(5),
    };
  }
  return { apps, ecosystem: { users30: eco30.size, users90: eco90.size, people30: ppl30.size, people90: ppl90.size }, peopleLinked: Boolean(personOf) };
}
