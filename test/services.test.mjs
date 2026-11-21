import { describe, expect, it } from 'vitest';
import { priceLikeCollectors } from '../src/services.mjs';

describe('price-list collectors', () => {
  it('flags a wallet most people pay the same round amount; not a farm forwarding what it earned', () => {
    const addrs = Array.from({ length: 30 }, (_, i) => `w${i}`);
    const rows = [];
    for (let i = 2; i < 10; i++) rows.push([100, i, 0, 100]); // 8 payers of 100 → w0
    rows.push([100, 10, 0, 37.2]);
    for (let i = 11; i < 20; i++) rows.push([100, i, 1, 3 + i / 7]); // farm → w1
    const r = priceLikeCollectors({ addrs, rows }, ['w0', 'w1'], 0);
    expect(r).toEqual([{ dest: 'w0', topAmount: 100, payersOfTopAmount: 8, roundShare: 0.89 }]);
  });
});
