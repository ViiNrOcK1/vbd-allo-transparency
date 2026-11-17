import { describe, expect, it } from 'vitest';
import { dailyB3trVet, dayOf, fetchVetUsd, foldSyncs, makePriceAt, seriesLookup } from '../src/prices.mjs';
import { summarize } from '../src/aggregate.mjs';
import { MAINNET } from '../src/abi.mjs';

const E18 = 10n ** 18n;
const T = (d) => Date.parse(d) / 1000;

describe('B3TR price at a date', () => {
  it('takes the last trade of each day from the deepest pool', () => {
    const deep = foldSyncs({}, [
      { at: T('2025-01-01') + 100, b3tr: 1_000_000n * E18, vet: 2_000_000n * E18 }, // 2 VET
      { at: T('2025-01-01') + 900, b3tr: 1_000_000n * E18, vet: 3_000_000n * E18 }, // 3 VET, later that day
    ]);
    const thin = foldSyncs({}, [{ at: T('2025-01-01') + 500, b3tr: 1000n * E18, vet: 50_000n * E18 }]); // 50 VET, thin
    const tiny = foldSyncs({}, [{ at: T('2025-01-02') + 500, b3tr: 10n * E18, vet: 100n * E18 }]); // below MIN_DEPTH
    const daily = dailyB3trVet({ deep, thin, tiny });
    expect(daily['2025-01-01']).toBe(3);
    expect(daily['2025-01-02']).toBeUndefined();
  });

  it('carries a price forward up to 14 days, then gives up', () => {
    const look = seriesLookup({ '2025-01-01': 1 });
    expect(look('2025-01-10')).toBe(1);
    expect(look('2025-01-20')).toBe(null);
    expect(look('2024-12-31')).toBe(null);
  });

  it('B3TR/USD = B3TR/VET × VET/USD on that day', () => {
    const priceAt = makePriceAt({ '2025-03-01': 4, '2025-06-01': 2 }, { '2025-03-01': 0.05, '2025-06-01': 0.02 });
    expect(priceAt(T('2025-03-01') + 3600)).toBeCloseTo(0.2);
    expect(priceAt(T('2025-06-01') + 3600)).toBeCloseTo(0.04);
    expect(priceAt(null)).toBe(null);
    expect(dayOf(T('2025-06-01') + 86_399)).toBe('2025-06-01');
  });

  it('falls through exchanges that fail and says which one was used', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('gateio')) return { ok: false, status: 451, json: async () => ({}) };
      if (url.includes('kucoin')) {
        return { ok: true, json: async () => ({ code: '200000', data: [[String(T('2025-01-01')), '0', '0.05', '0', '0', '0', '0']] }) };
      }
      if (url.includes('coingecko')) return { ok: true, json: async () => ({ prices: [[Date.parse('2025-01-02'), 0.06]] }) };
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const r = await fetchVetUsd(fetchImpl, T('2025-01-01'), T('2025-01-03'));
    expect(r.series['2025-01-01']).toBe(0.05);
    expect(r.series['2025-01-02']).toBe(0.06);
    expect(r.source).toBe('KuCoin VET-USDT + CoinGecko');
    expect(r.errors[0]).toMatch(/Gate.*451/);
  });
});

describe('value at the time', () => {
  it('values each movement at its own day’s price', () => {
    const A = '0x' + 'a'.repeat(64);
    const W = '0x' + '1'.repeat(40);
    const XAP = MAINNET.xAllocationPool.toLowerCase();
    // $1.00 in January, $0.10 in June.
    const priceAt = (ts) => (ts == null ? null : ts < T('2025-06-01') ? 1 : 0.1);
    const s = summarize({
      apps: [{ id: A, name: 'X', active: true, teamWallet: W, teamAllocationPercentage: 0 }],
      claims: [{ appId: A, round: 1, total: 1000n * E18, toTeam: 0n, toPool: 1000n * E18, unallocated: 0n, recipient: W, at: T('2025-01-05') }],
      deposits: [
        { appId: A, amount: 1000n * E18, depositor: XAP, at: T('2025-01-05') },
        { appId: A, amount: 100n * E18, depositor: W, at: T('2025-06-05') },
      ],
      withdrawals: [{ appId: A, amount: 400n * E18, teamWallet: W, reason: '', at: T('2025-01-10') }],
      poolBalances: { [A]: 0n },
      wallets: {
        [W]: {
          balance: 0n,
          inflows: [],
          outflows: [
            { to: '0x' + '9'.repeat(40), value: 200n * E18, kind: 'sold', txId: '0x1', at: T('2025-01-20') },
            { to: '0x' + '8'.repeat(40), value: 150n * E18, kind: 'other_wallet', txId: '0x2', at: T('2025-06-20') },
            { to: '0x' + '7'.repeat(40), value: 50n * E18, kind: 'other_wallet', txId: '0x3', at: null },
          ],
        },
      },
      xAllocationPool: MAINNET.xAllocationPool,
      priceAt,
    });
    const v = s.apps[0].valueUsd;
    expect(v.allocation).toBe(1000);
    expect(v.takenGross).toBe(400);
    expect(v.putBack).toBe(10); // 100 B3TR at $0.10
    expect(v.takenNet).toBe(390);
    expect(v.sold).toBe(200);
    expect(v.toOtherWallets).toBe(15);
    expect(v.unpricedB3tr).toBe((50n * E18).toString());
    expect(s.totals.soldUsd).toBe('200');
    expect(s.totals.takenNetUsd).toBe('390');
  });
});
