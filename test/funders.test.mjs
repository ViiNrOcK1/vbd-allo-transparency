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

  it('a busy funder (exchange or service) never links anyone', () => {
    const ff = { [w(1)]: w(100), [w(2)]: w(100) };
    expect(funderLinks(ff, Object.keys(ff), () => false, { isService: (a) => a === w(100) }).groups).toEqual([]);
  });
});

import { funderConfirmed, funderEvidence } from '../src/funders.mjs';

describe('a shared funder needs a second sign', () => {
  const ws = [w(1), w(2), w(3), w(4)];
  const day = 86_400;
  it('a batch of wallets funded within a week that earn from the same app links', () => {
    const ev = funderEvidence(ws, { fundedAt: (x) => 1e9 + Number(x.slice(-1)) * day, topAppOf: () => 'pergram' });
    expect(ev).toMatchObject({ n: 4, burstShare: 1, topApp: 'pergram', topAppShare: 1, flowBack: 0 });
    expect(funderConfirmed(ev)).toBe(true);
  });
  it('a community gas giver (funded over weeks, many apps, nothing comes back) does not', () => {
    const apps = { [w(1)]: 'a', [w(2)]: 'b', [w(3)]: 'c', [w(4)]: 'a' };
    const ev = funderEvidence(ws, { fundedAt: (x) => 1e9 + Number(x.slice(-1)) * 10 * day, topAppOf: (x) => apps[x] });
    expect(ev.burstShare).toBe(0.25);
    expect(funderConfirmed(ev)).toBe(false);
  });
  it('a burst alone is not enough when the wallets use different apps', () => {
    const apps = { [w(1)]: 'a', [w(2)]: 'b', [w(3)]: 'c', [w(4)]: 'd' };
    expect(funderConfirmed(funderEvidence(ws, { fundedAt: () => 1e9, topAppOf: (x) => apps[x] }))).toBe(false);
  });
  it('rewards sent back to the funder link, whatever the timing', () => {
    const ev = funderEvidence(ws, { sentBack: (x) => (x === w(1) || x === w(3) ? 5 : 0) });
    expect(ev.flowBack).toBe(2);
    expect(funderConfirmed(ev)).toBe(true);
  });
  it('funderLinks reports unconfirmed groups instead of linking them', () => {
    const ff = { [w(1)]: w(100), [w(2)]: w(100) };
    const r = funderLinks(ff, Object.keys(ff), () => false, { confirm: () => false });
    expect(r.groups).toEqual([]);
    expect(r.unconfirmed).toEqual([{ funder: w(100), wallets: [w(1), w(2)] }]);
  });
});
