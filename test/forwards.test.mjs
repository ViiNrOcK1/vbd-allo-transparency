import { describe, expect, it } from 'vitest';
import { flowOf, forwardLinks } from '../src/forwards.mjs';
import { personOfFactory } from '../src/people.mjs';

const w = (n) => '0x' + String(n).padStart(40, '0');
const t = (from, to, amount) => ({ from: w(from), to: w(to), amount });

describe('collector networks', () => {
  it('two collectors that forward most of their money to the same wallet become one person', () => {
    const flows = new Map([
      [w(10), flowOf(w(10), [t(1, 10, 50), t(2, 10, 50), t(10, 99, 90)])],
      [w(20), flowOf(w(20), [t(3, 20, 40), t(20, 99, 40)])],
      [w(99), flowOf(w(99), [t(10, 99, 90), t(20, 99, 40)])],
    ]);
    const r = forwardLinks(flows, () => false);
    expect(r.pairs).toEqual([
      [w(10), w(99)],
      [w(20), w(99)],
    ]);
    const personOf = personOfFactory([[w(1), w(10)], [w(3), w(20)], ...r.pairs]);
    expect(personOf(w(1))).toBe(personOf(w(3)));
  });
  it('paying someone a small part of the money does not link', () => {
    const flows = new Map([[w(10), flowOf(w(10), [t(1, 10, 100), t(10, 50, 20), t(10, 51, 30)])]]);
    expect(forwardLinks(flows, () => false).pairs).toEqual([]);
  });
  it('contracts, busy wallets and wallets many outsiders pay are services, not the same person', () => {
    const outsiders = Array.from({ length: 30 }, (_, i) => t(500 + i, 99, 1));
    const flows = new Map([
      [w(10), flowOf(w(10), [t(1, 10, 100), t(10, 98, 100)])],
      [w(11), flowOf(w(11), [t(2, 11, 100), t(11, 99, 100)])],
      [w(99), flowOf(w(99), [t(11, 99, 100), ...outsiders], (a) => a === w(11))],
    ]);
    const r = forwardLinks(flows, (a) => a === w(98));
    expect(r.pairs).toEqual([]);
    expect(r.skipped.map((s) => s.why)).toEqual(['service or contract', '30 senders']);
  });
  it('reward wallets and collectors sending in are not outsiders', () => {
    const f = flowOf(w(99), [t(1, 99, 5), t(2, 99, 5), t(3, 99, 5)], (a) => a !== w(3));
    expect(f).toMatchObject({ in: 15, sources: 1 });
  });
});
