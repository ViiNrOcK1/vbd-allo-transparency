// Wallets → people (Vinny, 2026-11-19: "one user can have multiple wallets").
//
// The one public, on-chain record of "these wallets are the same person" is
// VeBetterDAO's own Passport: a person links extra wallets to their passport
// wallet (LinkCreated / LinkRemoved), or delegates their personhood to
// another wallet (DelegationCreated / DelegationRevoked). Wallets joined by a
// link or a delegation that is still in force count as ONE person.
//
// What this can't see: someone running several wallets they never linked.
// So "people" is still a ceiling, just a tighter one than raw wallets.

const topicAddr = (t) => ('0x' + t.slice(-40)).toLowerCase();

/** Passport events → current links. events: { kind, a, b, block, logIndex }, any order. */
export function currentLinks(events) {
  const links = new Map(); // "a|b" → true
  const sorted = [...events].sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
  for (const e of sorted) {
    const key = `${e.kind === 'link' || e.kind === 'unlink' ? 'L' : 'D'}|${e.a}|${e.b}`;
    if (e.kind === 'link' || e.kind === 'delegate') links.set(key, [e.a, e.b]);
    else links.delete(key);
  }
  return [...links.values()];
}

/** Decode a raw Thor log from the Passport contract, or null. */
export function decodePassportLog(l, TOPIC) {
  const t0 = l.topics?.[0];
  const kind =
    t0 === TOPIC.linkCreated ? 'link' : t0 === TOPIC.linkRemoved ? 'unlink' : t0 === TOPIC.delegationCreated ? 'delegate' : t0 === TOPIC.delegationRevoked ? 'undelegate' : null;
  if (!kind || !l.topics[1] || !l.topics[2]) return null;
  return { kind, a: topicAddr(l.topics[1]), b: topicAddr(l.topics[2]), block: l.meta?.blockNumber ?? 0, logIndex: l.meta?.logIndex ?? 0 };
}

/** No merged "person" may hold more than this many addresses. */
export const MAX_GROUP = 50;

/**
 * pairs [[a, b], …] → address → representative (union-find).
 * A union that would make a group bigger than maxGroup is skipped, so links
 * can't chain strangers into one giant "person" (2026-11-19: chaining made a
 * 1,820-wallet group). Pass the most reliable links first (Passport, then
 * sweeps, then funders): earlier links win when the cap bites.
 */
export function personOfFactory(pairs, { maxGroup = MAX_GROUP } = {}) {
  const parent = new Map();
  const size = new Map();
  const sz = (r) => size.get(r) ?? 1;
  const find = (x) => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
    let y = x;
    while (parent.has(y) && parent.get(y) !== r) {
      const n = parent.get(y);
      parent.set(y, r);
      y = n;
    }
    return r;
  };
  let skipped = 0;
  for (const [a, b] of pairs) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) continue;
    if (sz(ra) + sz(rb) > maxGroup) {
      skipped++;
      continue;
    }
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    parent.set(drop, keep);
    size.set(keep, sz(ra) + sz(rb));
  }
  personOf.skipped = skipped;
  function personOf(addr) {
    return find(String(addr).toLowerCase());
  }
  return personOf;
}
