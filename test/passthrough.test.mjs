import { describe, expect, it } from 'vitest';
import { passThroughSales } from '../src/passthrough.mjs';

const B = (n) => BigInt(n) * 10n ** 18n;
const DAY = 86_400;
const team = new Set(['0xteam']);

describe('team money sold from another wallet', () => {
  it('Mugshot pattern: sent on day 0, the wallet sells all of it on day 8 → sold', () => {
    const r = passThroughSales(
      [{ value: B(226908), at: 0, txId: 't1' }],
      { outflows: [{ kind: 'sold', value: B(226908), at: 8 * DAY, txId: 's1' }], inflows: [{ from: '0xteam', value: B(226908), at: 0 }] },
      team,
    );
    expect(r[0].sold).toEqual([{ value: B(226908), at: 8 * DAY, txId: 's1', saleValue: B(226908) }]);
    expect(r[0].rest).toBe(0n);
  });
  it('a wallet with its own income (someone paid by the team) is not a pass-through', () => {
    const r = passThroughSales(
      [{ value: B(5000), at: 0, txId: 't1' }],
      {
        outflows: [{ kind: 'sold', value: B(5000), at: DAY, txId: 's1' }],
        inflows: [
          { from: '0xteam', value: B(5000), at: 0 },
          { from: '0xelse', value: B(4000), at: DAY / 2 },
        ],
      },
      team,
    );
    expect(r[0].sold).toEqual([]);
    expect(r[0].rest).toBe(B(5000));
  });
  it('only what was sold counts, and only within the window', () => {
    const r = passThroughSales(
      [{ value: B(10000), at: 0, txId: 't1' }],
      {
        outflows: [
          { kind: 'sold', value: B(4000), at: 2 * DAY, txId: 's1' },
          { kind: 'sold', value: B(6000), at: 40 * DAY, txId: 's2' },
          { kind: 'other_wallet', value: B(1), at: 3 * DAY, txId: 'x' },
        ],
        inflows: [{ from: '0xteam', value: B(10000), at: 0 }],
      },
      team,
    );
    expect(r[0].sold.map((s) => s.txId)).toEqual(['s1']);
    expect(r[0].rest).toBe(B(6000));
  });
  it('a sale is used once across several transfers, oldest first; small transfers are ignored', () => {
    const r = passThroughSales(
      [
        { value: B(3000), at: 0, txId: 't1' },
        { value: B(3000), at: DAY, txId: 't2' },
        { value: B(500), at: DAY, txId: 't3' },
      ],
      { outflows: [{ kind: 'sold', value: B(4000), at: 2 * DAY, txId: 's1' }], inflows: [{ from: '0xteam', value: B(6500), at: 0 }] },
      team,
    );
    expect(r.map((x) => x.sold.reduce((a, s) => a + s.value, 0n))).toEqual([B(3000), B(1000), 0n]);
    expect(r.map((x) => x.rest)).toEqual([0n, B(2000), B(500)]);
  });
});
