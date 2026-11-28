import { describe, expect, it } from 'vitest';
import { depositExchange, exchangeTotals } from '../src/exchanges.mjs';

const BINANCE = '0x44bc93a8d3cefa5a6721723a2f8d2e4f7d480ba0';
const KRAKEN = '0xdb4962f5718947fcbec44845c3c40240344a050a';

describe('exchange deposit addresses', () => {
  it('a wallet that passes 80%+ to one exchange hot wallet is that exchange', () => {
    expect(depositExchange([{ to: BINANCE, value: 900 }, { to: '0xme', value: 100 }])).toBe('Binance');
  });
  it('a split or an unknown destination is not', () => {
    expect(depositExchange([{ to: BINANCE, value: 500 }, { to: KRAKEN, value: 500 }])).toBeNull();
    expect(depositExchange([{ to: '0xsomeone', value: 1000 }])).toBeNull();
    expect(depositExchange([])).toBeNull();
  });
});

describe('team money to exchanges', () => {
  it('counts direct transfers and deposit addresses, per app, token and exchange', async () => {
    const flows = [
      { app: 'A', token: 'VET', to: KRAKEN, value: 100, at: 1 },
      { app: 'A', token: 'VET', to: '0xdep', value: 50, at: 2 },
      { app: 'A', token: 'B3TR', to: '0xfriend', value: 70, at: 3 },
    ];
    const r = await exchangeTotals(flows, async (t, to) => (to === '0xdep' ? 'Binance' : null), (t) => (t === 'VET' ? 0.02 : 0.01));
    expect(r.A.VET.total).toBe(150);
    expect(r.A.VET.byExchange.Kraken).toEqual({ amount: 100, usd: 2, direct: 100, viaDeposit: 0 });
    expect(r.A.VET.byExchange.Binance.viaDeposit).toBe(50);
    expect(r.A.B3TR).toBeUndefined();
  });
});
