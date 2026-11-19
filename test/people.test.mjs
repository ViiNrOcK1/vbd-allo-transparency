import { describe, expect, it } from 'vitest';
import { TOPIC } from '../src/abi.mjs';
import { currentLinks, decodePassportLog, personOfFactory } from '../src/people.mjs';
import { emptyPayouts, foldPayouts, userStats } from '../src/users.mjs';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);
const D = '0x' + 'd'.repeat(40);
const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);

describe('wallets linked through VeBetter Passport count as one person', () => {
  it('decodes passport events and keeps only links still in force', () => {
    const log = (t, a, b, block, i = 0) => ({ topics: [t, pad(a), pad(b)], meta: { blockNumber: block, logIndex: i } });
    const ev = [
      log(TOPIC.linkCreated, B, A, 10),
      log(TOPIC.delegationCreated, C, A, 11),
      log(TOPIC.linkCreated, D, A, 12),
      log(TOPIC.linkRemoved, D, A, 13),
      { topics: ['0xdead'], meta: {} },
    ]
      .map((l) => decodePassportLog(l, TOPIC))
      .filter(Boolean);
    expect(ev).toHaveLength(4);
    expect(currentLinks(ev)).toEqual([
      [B, A],
      [C, A],
    ]);
  });

  it('merges linked wallets in the user counts, per app and overall', () => {
    const now = 1_800_000_000;
    const c = emptyPayouts();
    foldPayouts(
      c,
      [A, B, C, D].map((r) => ({ at: now - 86_400, appId: '0xAPP', receiver: r, amount: 10n ** 18n })),
      now,
    );
    const personOf = personOfFactory([
      [B, A],
      [C, A],
    ]);
    const s = userStats(c, now, {}, personOf);
    expect(s.apps['0xapp']).toMatchObject({ users30: 4, people30: 2 });
    expect(s.ecosystem).toMatchObject({ users30: 4, people30: 2 });
    // Without links, people = wallets.
    expect(userStats(c, now).apps['0xapp']).toMatchObject({ users30: 4, people30: 4 });
  });
});
