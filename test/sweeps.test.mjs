import { describe, expect, it } from 'vitest';
import { candidateDestinations, emptySweeps, foldSweeps, sweepLinks } from '../src/sweeps.mjs';
import { emptyPayouts, foldPayouts, userStats } from '../src/users.mjs';
import { personOfFactory } from '../src/people.mjs';

const E = 10n ** 18n;
const now = 1_800_000_000;
const day = 86_400;
const w = (n) => '0x' + String(n).padStart(40, '0');
const FARM = w(999);
const SHOP = w(888);

function setup() {
  const p = emptyPayouts();
  // Wallets 1–4 each earn 100 B3TR from the app; 5 earns 100 too.
  foldPayouts(p, [1, 2, 3, 4, 5].map((n) => ({ at: now - 5 * day, appId: '0xAPP', receiver: w(n), amount: 100n * E })), now);
  const s = emptySweeps();
  const t = (from, to, amt) => ({ at: now - 2 * day, from: w(from), to, amount: BigInt(amt) * E });
  foldSweeps(
    s,
    [
      t(1, FARM, 95), // sweeps nearly everything to FARM
      t(2, FARM, 100),
      t(3, FARM, 60), // 60% — still over the 50% bar
      t(4, SHOP, 10), // small purchase: not a sweep
      t(5, SHOP, 10),
      { at: now - 2 * day, from: w(777), to: FARM, amount: 50n * E }, // not a receiver: dropped
    ],
    (from) => p.receivers.includes(from),
    now,
  );
  return { p, s };
}

describe('sweeps: reward wallets that send most of their rewards to one wallet', () => {
  it('links wallets that sweep to the same destination, not small payments', () => {
    const { p, s } = setup();
    expect(s.rows).toHaveLength(5);
    expect(s.otherIn[FARM]).toBeTruthy(); // the non-receiver's transfer counted as public traffic
    const { groups, pairs } = sweepLinks(s, p, now, () => false);
    expect(groups).toEqual([{ dest: FARM, wallets: [w(1), w(2), w(3)] }]);
    expect(pairs).toHaveLength(3);
    // 5 wallets → 3 people (1+2+3 are one).
    const s2 = userStats(p, now, {}, personOfFactory(pairs));
    expect(s2.apps['0xapp']).toMatchObject({ users30: 5, people30: 3 });
  });

  it('never merges through an excluded destination, and reports service-sized ones', () => {
    const { p, s } = setup();
    expect(sweepLinks(s, p, now, (a) => a === FARM).groups).toEqual([]);
    const big = sweepLinks(s, p, now, () => false, { maxSenders: 2 });
    expect(big.groups).toEqual([]);
    expect(big.tooBig).toEqual([{ dest: FARM, senders: 3 }]);
    expect(candidateDestinations(s, p, now)).toEqual([FARM]);
  });

  it('a single wallet sending to itself or one destination alone links nothing', () => {
    const p = emptyPayouts();
    foldPayouts(p, [{ at: now - day, appId: '0xA', receiver: w(1), amount: 10n * E }], now);
    const s = emptySweeps();
    foldSweeps(s, [{ at: now - day, from: w(1), to: FARM, amount: 10n * E }, { at: now - day, from: w(1), to: w(1), amount: E }], () => true, now);
    expect(s.rows).toHaveLength(1);
    expect(sweepLinks(s, p, now, () => false).groups).toEqual([]);
  });

  it('treats a destination the public also pays as a service, and ignores paying with own money', () => {
    const { p, s } = setup();
    foldSweeps(s, Array.from({ length: 150 }, (_, i) => ({ at: now - day, from: w(5000 + i), to: FARM, amount: E })), (f) => p.receivers.includes(f), now);
    const r = sweepLinks(s, p, now, () => false);
    expect(r.groups).toEqual([]);
    expect(r.services).toEqual([{ dest: FARM, senders: 3 }]);
    const p2 = emptyPayouts();
    foldPayouts(p2, [1, 2].map((n) => ({ at: now - 5 * day, appId: '0xAPP', receiver: w(n), amount: 100n * E })), now);
    const s2 = emptySweeps();
    foldSweeps(s2, [1, 2].map((n) => ({ at: now - day, from: w(n), to: SHOP, amount: 500n * E })), () => true, now);
    expect(sweepLinks(s2, p2, now, () => false).groups).toEqual([]);
  });
});
