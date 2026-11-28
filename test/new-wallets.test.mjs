import { describe, expect, it } from 'vitest';
import { emptyPayouts, foldPayouts, userStats } from '../src/users.mjs';

const DAY = 86_400;
const now = 200 * DAY;
const pay = (days, appId, receiver) => ({ at: now - days * DAY, appId, receiver, amount: 10n ** 18n });

describe('new wallets per week', () => {
  it('credits a wallet to the app that paid it first, in the week it first appeared', () => {
    const c = foldPayouts(
      emptyPayouts(),
      [
        pay(99, '0xother', '0xold'), // history so the weeks are reportable
        pay(2, '0xmug', '0xold'), // old wallet: not new
        pay(3, '0xmug', '0xa'),
        pay(1, '0xother', '0xa'), // same wallet later on another app: still Mugshot's
        pay(4, '0xmug', '0xb'),
        pay(10, '0xmug', '0xc'), // last week
        pay(5, '0xother', '0xd'),
      ],
      now,
    );
    const u = userStats(c, now);
    expect(u.apps['0xmug'].newWallets.perWeek.slice(0, 2)).toEqual([2, 1]);
    expect(u.apps['0xother'].newWallets.perWeek[0]).toBe(1);
    expect(u.newWallets.weeksEnding[0]).toBe(now);
  });

  it('reports no weeks without 60 days of history behind them', () => {
    const c = foldPayouts(emptyPayouts(), [pay(20, '0xmug', '0xa'), pay(1, '0xmug', '0xb')], now);
    const u = userStats(c, now);
    expect(u.newWallets).toBeNull();
    expect(u.apps['0xmug'].newWallets).toBeUndefined();
  });

  it('leaves out the app team and endorsers', () => {
    const c = foldPayouts(emptyPayouts(), [pay(99, '0xx', '0xold'), pay(1, '0xmug', '0xteam'), pay(1, '0xmug', '0xa')], now);
    const u = userStats(c, now, { '0xmug': new Set(['0xteam']) });
    expect(u.apps['0xmug'].newWallets.perWeek[0]).toBe(1);
  });
});
