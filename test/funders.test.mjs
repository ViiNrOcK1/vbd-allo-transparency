import { describe, expect, it } from 'vitest';
import { earliestFunding, funderLinks } from '../src/funders.mjs';

const w = (n) => '0x' + String(n).padStart(40, '0');
const ZERO = '0x' + '0'.repeat(40);

describe('same funder', () => {
  it('takes the earliest real funding and ignores the zero address', () => {
    expect(earliestFunding({ from: w(9), block: 50 }, { from: w(8), block: 20 }, null)).toEqual({ from: w(8), block: 20 });
    expect(earliestFunding({ from: ZERO, block: 1 }, { from: w(8), block: 20 })).toEqual({ from: w(8), block: 20 });
    expect(earliestFunding(null, null)).toBe(null);
  });

  it('links wallets first funded by the same plain wallet; skips excluded and service-sized funders', () => {
    const ff = { [w(1)]: w(100), [w(2)]: w(100), [w(3)]: w(200), [w(4)]: w(300), [w(5)]: w(300), [w(6)]: w(400), [w(7)]: w(400), [w(8)]: w(400) };
    const all = Object.keys(ff);
    const r = funderLinks(ff, all, (a) => a === w(300), { maxFunded: 2 });
    expect(r.groups).toEqual([{ funder: w(100), wallets: [w(1), w(2)] }]);
    expect(r.pairs).toEqual([
      [w(1), w(100)],
      [w(2), w(100)],
    ]);
    expect(r.tooBig).toEqual([{ funder: w(400), wallets: 3 }]);
  });
});
