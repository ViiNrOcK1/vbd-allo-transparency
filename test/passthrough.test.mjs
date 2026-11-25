import { describe, expect, it } from 'vitest';
import { passThroughSales, traceLots } from '../src/passthrough.mjs';

const B = (n) => BigInt(n) * 10n ** 18n;
const DAY = 86_400;
const team = new Set(['0xteam']);

describe('team money sold from another wallet', () => {
  it('Mugshot pattern: sent on day 0, the wallet sells all of it on day 8 → sold', async () => {
    const r = await passThroughSales(
      [{ value: B(226908), at: 0, txId: 't1' }],
      { outflows: [{ kind: 'sold', value: B(226908), at: 8 * DAY, txId: 's1' }], inflows: [{ from: '0xteam', value: B(226908), at: 0 }] },
      team,
    );
    expect(r[0].sold).toEqual([{ value: B(226908), at: 8 * DAY, txId: 's1', saleValue: B(226908) }]);
    expect(r[0].rest).toBe(0n);
  });
  it('a wallet with its own income (someone paid by the team) is not a pass-through', async () => {
    const r = await passThroughSales(
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
  it('only what was sold counts, and only within the window', async () => {
    const r = await passThroughSales(
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
  it('a sale is used once across several transfers, oldest first; small transfers are ignored', async () => {
    const r = await passThroughSales(
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

describe('following team money over several hops', () => {
  const isTeam = (w) => w === '0xteam';
  const run = (net, seeds, opts) => traceLots({ seeds: new Map(seeds), flowsOf: async (w) => (net[w] ? structuredClone(net[w]) : null), isTeam, ...opts });
  const seed = (ref, to, v, at) => [to, [{ ref, value: B(v), at }]];

  it('Mugshot pattern: team → A (sells a bit, moves the rest) → B (sells it all)', async () => {
    const net = {
      '0xa': {
        inflows: [{ from: '0xteam', value: B(1000000), at: 0 }],
        outflows: [
          { kind: 'sold', value: B(200000), at: DAY, txId: 'sa' },
          { kind: 'other_wallet', to: '0xb', value: B(800000), at: 2 * DAY, txId: 'm1' },
        ],
      },
      '0xb': {
        inflows: [{ from: '0xa', value: B(800000), at: 2 * DAY }],
        outflows: [{ kind: 'sold', value: B(800000), at: 5 * DAY, txId: 'sb' }],
      },
    };
    const { sold, stats } = await run(net, [seed('f1', '0xa', 1000000, 0)]);
    expect(sold.get('f1')).toEqual([
      { value: B(200000), at: DAY, txId: 'sa', via: '0xa', saleValue: B(200000), hop: 1 },
      { value: B(800000), at: 5 * DAY, txId: 'sb', via: '0xb', saleValue: B(800000), hop: 2 },
    ]);
    expect(stats.deepestHop).toBe(2);
  });

  it('the 30-day window starts again at each hop (when the money arrived there)', async () => {
    const net = {
      '0xa': { inflows: [{ from: '0xteam', value: B(5000), at: 0 }], outflows: [{ kind: 'other_wallet', to: '0xb', value: B(5000), at: 20 * DAY, txId: 'm' }] },
      '0xb': { inflows: [{ from: '0xa', value: B(5000), at: 20 * DAY }], outflows: [{ kind: 'sold', value: B(5000), at: 45 * DAY, txId: 's' }] },
    };
    const { sold } = await run(net, [seed('f', '0xa', 5000, 0)]);
    expect(sold.get('f').map((s) => [s.via, s.value])).toEqual([['0xb', B(5000)]]);
  });

  it('a lot sitting more than 30 days is not followed', async () => {
    const net = {
      '0xa': { inflows: [{ from: '0xteam', value: B(5000), at: 0 }], outflows: [{ kind: 'other_wallet', to: '0xb', value: B(5000), at: 60 * DAY, txId: 'm' }] },
      '0xb': { inflows: [{ from: '0xa', value: B(5000), at: 60 * DAY }], outflows: [{ kind: 'sold', value: B(5000), at: 61 * DAY, txId: 's' }] },
    };
    const { sold } = await run(net, [seed('f', '0xa', 5000, 0)]);
    expect(sold.get('f')).toBeUndefined();
  });

  it('later income of a long-lived wallet does not undo an earlier pass-through', async () => {
    const net = {
      '0xa': {
        inflows: [{ from: '0xteam', value: B(8000), at: 0 }, { from: '0xjob', value: B(90000), at: 100 * DAY }],
        outflows: [{ kind: 'sold', value: B(8000), at: 3 * DAY, txId: 's1' }, { kind: 'sold', value: B(90000), at: 101 * DAY, txId: 's2' }],
      },
    };
    const { sold } = await run(net, [seed('f', '0xa', 8000, 0)]);
    expect(sold.get('f').map((s) => s.txId)).toEqual(['s1']);
  });

  it('the trail stops at a wallet with its own income, at a busy wallet, and back at the team', async () => {
    const net = {
      '0xa': {
        inflows: [{ from: '0xteam', value: B(9000), at: 0 }],
        outflows: [
          { kind: 'other_wallet', to: '0xmixed', value: B(3000), at: DAY, txId: 'm1' },
          { kind: 'other_wallet', to: '0xbusy', value: B(3000), at: DAY, txId: 'm2' },
          { kind: 'other_wallet', to: '0xteam', value: B(3000), at: DAY, txId: 'm3' },
        ],
      },
      '0xmixed': {
        inflows: [{ from: '0xa', value: B(3000), at: DAY }, { from: '0xjob', value: B(3000), at: DAY }],
        outflows: [{ kind: 'sold', value: B(6000), at: 2 * DAY, txId: 's' }],
      },
    };
    const { sold } = await run(net, [seed('f', '0xa', 9000, 0)]);
    expect(sold.get('f')).toBeUndefined();
  });

  it('a sale is never counted twice when the money reaches a wallet by two paths', async () => {
    const net = {
      '0xa': { inflows: [{ from: '0xteam', value: B(4000), at: 0 }], outflows: [{ kind: 'other_wallet', to: '0xc', value: B(2000), at: DAY, txId: 'm1' }, { kind: 'other_wallet', to: '0xb', value: B(2000), at: DAY, txId: 'm2' }] },
      '0xb': { inflows: [{ from: '0xa', value: B(2000), at: DAY }], outflows: [{ kind: 'other_wallet', to: '0xc', value: B(2000), at: 2 * DAY, txId: 'm3' }] },
      '0xc': { inflows: [{ from: '0xa', value: B(2000), at: DAY }, { from: '0xb', value: B(2000), at: 2 * DAY }], outflows: [{ kind: 'sold', value: B(3000), at: 3 * DAY, txId: 's' }] },
    };
    const { sold } = await run(net, [seed('f', '0xa', 4000, 0)]);
    const total = sold.get('f').reduce((a, s) => a + s.value, 0n);
    expect(total).toBe(B(3000));
  });

  it('always checks the first hop; the deeper budget stops further hops and says so', async () => {
    const net = {
      '0xa': { inflows: [{ from: '0xteam', value: B(4000), at: 0 }], outflows: [{ kind: 'sold', value: B(2000), at: DAY, txId: 's1' }, { kind: 'other_wallet', to: '0xb', value: B(2000), at: DAY, txId: 'm' }] },
      '0xb': { inflows: [{ from: '0xa', value: B(2000), at: DAY }], outflows: [{ kind: 'sold', value: B(2000), at: 2 * DAY, txId: 's2' }] },
    };
    const { sold, stats } = await run(net, [seed('f', '0xa', 4000, 0)], { maxDeep: 0 });
    expect(sold.get('f').map((s) => s.txId)).toEqual(['s1']);
    expect(stats.stoppedAtCap).toBe(1);
  });
});
