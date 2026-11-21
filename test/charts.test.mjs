import { describe, expect, it } from 'vitest';
import { perRoundTotals, sellerRows, splitOf } from '../site/charts.js';

const E = 10n ** 18n;
describe('overview charts', () => {
  it('splits an allocation into four parts that fill the bar', () => {
    const { raw, widths } = splitOf({ ratios: { paidToUsersPctOfAllocation: 60, toEndorsersPct: 5, takenByTeamPct: 25, stillInPoolPct: 10 } });
    expect(raw).toEqual({ users: 60, endorsers: 5, team: 25, pool: 10 });
    expect(Object.values(widths).reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });
  it('draws a negative "taken" (team put back more) as zero, keeps the real number', () => {
    const { raw, widths } = splitOf({ ratios: { paidToUsersPctOfAllocation: 70, takenByTeamPct: -4, stillInPoolPct: 34 } });
    expect(raw.team).toBe(-4);
    expect(widths.team).toBe(0);
    expect(widths.users + widths.pool).toBeCloseTo(100);
  });
  it('adds every app up per round', () => {
    const r = (round, t, w) => ({ round, total: String(BigInt(t) * E), withdrawn: String(BigInt(w) * E) });
    const out = perRoundTotals([{ perRound: [r(2, 10, 1), r(1, 5, 0)] }, { perRound: [r(2, 20, 3)] }]);
    expect(out).toEqual([
      { round: 1, allocated: 5, withdrawn: 0 },
      { round: 2, allocated: 30, withdrawn: 4 },
    ]);
  });
  it('counts a shared team wallet once and ranks by sold + moved out', () => {
    const v = (sold, other, allocation) => ({ sold, toOtherWallets: other, allocation });
    const rows = sellerRows([
      { name: 'A', teamWallets: ['0xAA'], valueUsd: v(100, 50, 1000) },
      { name: 'B', teamWallets: ['0xbb'], valueUsd: v(500, 0, 2000) },
      { name: 'C', teamWallets: ['0xaa'], valueUsd: v(100, 50, 3000) },
      { name: 'D', teamWallets: ['0xdd'], valueUsd: v(0, 0, 10) },
    ]);
    expect(rows.filter((r) => r.sold + r.other > 0).map((r) => [r.names.join('+'), r.sold, r.other, r.allocated])).toEqual([
      ['B', 500, 0, 2000],
      ['A+C', 100, 50, 4000],
    ]);
  });
});

import { networkRows } from '../site/charts.js';
describe('rewards to linked networks', () => {
  it('ranks apps by B3TR paid to networks and skips apps with none', () => {
    const apps = [{ id: '0xA', name: 'A' }, { id: '0xB', name: 'B' }, { id: '0xC', name: 'C' }];
    const users = { '0xa': { b3tr90: 100, toNetworks90: 10, networkWallets90: 2 }, '0xb': { b3tr90: 50, toNetworks90: 40, networkWallets90: 9 }, '0xc': { b3tr90: 5 } };
    expect(networkRows(apps, users).map((r) => [r.a.name, r.net])).toEqual([['B', 40], ['A', 10]]);
  });
});
