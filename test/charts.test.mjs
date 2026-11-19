import { describe, expect, it } from 'vitest';
import { perRoundTotals, splitOf } from '../site/charts.js';

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
});
