// B3TR in US dollars on any past day, so each withdrawal / sale / transfer can
// be valued at the price it had WHEN it happened (Vinny, 2026-11-16: "each was
// sold at different points when prices were").
//
//   B3TR/USD (day) = B3TR/VET (day, on-chain) × VET/USD (day, exchange close)
//
// B3TR/VET comes from the B3TR–VVET pools' own Sync events: the reserves after
// the last trade of the day, from whichever pool was deepest that day. That's
// the price anyone trading on VeChain actually got — no third party.
// VET/USD is a public daily close from an exchange (VET-USDT, USDT ≈ USD).
// A cross-check compares the result with CoinGecko's B3TR price for the last
// year.

export const dayOf = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

/** Ignore pools too thin to set a price (in VET). */
export const MIN_DEPTH_VET = 10_000;
/** Don't carry a price forward more than this many days. */
export const MAX_STALE_DAYS = 14;

const toNum = (wei) => Number(BigInt(wei) / 10n ** 12n) / 1e6;

/**
 * Fold Sync samples into a per-pool daily record (last sample of each UTC day).
 * @param {Record<string, [number, number]>} days existing day → [vetPerB3tr, vetDepth]
 * @param {{at:number, b3tr:bigint, vet:bigint}[]} samples ascending
 */
export function foldSyncs(days, samples) {
  for (const s of samples) {
    if (s.b3tr <= 0n) continue;
    const vet = toNum(s.vet);
    const b3tr = toNum(s.b3tr);
    if (!b3tr) continue;
    days[dayOf(s.at)] = [vet / b3tr, vet];
  }
  return days;
}

/**
 * One B3TR/VET price per day: the deepest pool's last price that day.
 * @param {Record<string, Record<string, [number, number]>>} byPool pool → day → [price, depth]
 * @returns {Record<string, number>}
 */
export function dailyB3trVet(byPool) {
  const best = {};
  for (const days of Object.values(byPool)) {
    for (const [day, [price, depth]] of Object.entries(days)) {
      if (depth < MIN_DEPTH_VET || !(price > 0)) continue;
      if (!best[day] || depth > best[day][1]) best[day] = [price, depth];
    }
  }
  return Object.fromEntries(Object.entries(best).map(([d, [p]]) => [d, p]));
}

/** A lookup that carries the last known value forward up to MAX_STALE_DAYS. */
export function seriesLookup(series) {
  const days = Object.keys(series).sort();
  return (day) => {
    let lo = 0;
    let hi = days.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid] <= day) {
        hit = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (hit < 0) return null;
    const gap = (Date.parse(day) - Date.parse(days[hit])) / 86_400_000;
    return gap > MAX_STALE_DAYS ? null : series[days[hit]];
  };
}

/** ts (unix seconds) → B3TR price in USD, or null when unknown. */
export function makePriceAt(b3trVet, vetUsd) {
  const a = seriesLookup(b3trVet);
  const b = seriesLookup(vetUsd);
  return (ts) => {
    if (ts == null) return null;
    const d = dayOf(ts);
    const x = a(d);
    const y = b(d);
    return x == null || y == null ? null : x * y;
  };
}

// ── VET/USD daily closes, from the first public source that answers ──

const DAY = 86_400;

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'vbd-allo-transparency' } });
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  return res.json();
}

/** Gate.io daily candles: [t, quoteVol, close, high, low, open, baseVol, closed]. */
async function gate(fetchImpl, fromTs, toTs) {
  const out = {};
  for (let from = fromTs; from < toTs; from += 900 * DAY) {
    const to = Math.min(toTs, from + 900 * DAY);
    const rows = await getJson(fetchImpl, `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=VET_USDT&interval=1d&from=${from}&to=${to}`);
    for (const r of rows) out[dayOf(Number(r[0]))] = Number(r[2]);
  }
  return out;
}

/** KuCoin daily candles: [time, open, close, high, low, volume, turnover]. */
async function kucoin(fetchImpl, fromTs, toTs) {
  const out = {};
  for (let from = fromTs; from < toTs; from += 1400 * DAY) {
    const to = Math.min(toTs, from + 1400 * DAY);
    const j = await getJson(fetchImpl, `https://api.kucoin.com/api/v1/market/candles?type=1day&symbol=VET-USDT&startAt=${from}&endAt=${to}`);
    if (j.code !== '200000') throw new Error(`kucoin ${j.code}`);
    for (const r of j.data) out[dayOf(Number(r[0]))] = Number(r[2]);
  }
  return out;
}

/** OKX daily candles, newest first, 100 per page: [ts(ms), o, h, l, c, …]. */
async function okx(fetchImpl, fromTs) {
  const out = {};
  let after = '';
  for (let i = 0; i < 20; i++) {
    const j = await getJson(fetchImpl, `https://www.okx.com/api/v5/market/history-candles?instId=VET-USDT&bar=1Dutc&limit=100${after ? `&after=${after}` : ''}`);
    if (j.code !== '0' || !j.data.length) break;
    for (const r of j.data) out[dayOf(Number(r[0]) / 1000)] = Number(r[4]);
    const oldest = Number(j.data.at(-1)[0]);
    if (oldest / 1000 <= fromTs) break;
    after = String(oldest);
  }
  return out;
}

/** CoinGecko, last 365 days only on the free API. */
export async function coingeckoDaily(fetchImpl, id) {
  const j = await getJson(fetchImpl, `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`);
  const out = {};
  for (const [ms, p] of j.prices ?? []) out[dayOf(ms / 1000)] = p;
  return out;
}

/**
 * VET/USD per day. Tries the sources in order and keeps the first that covers
 * the range; merges CoinGecko for any recent gaps.
 * @returns {Promise<{source:string, series:Record<string,number>, errors:string[]}>}
 */
export async function fetchVetUsd(fetchImpl, fromTs, toTs) {
  const errors = [];
  const sources = [
    ['Gate.io VET/USDT', () => gate(fetchImpl, fromTs, toTs)],
    ['KuCoin VET-USDT', () => kucoin(fetchImpl, fromTs, toTs)],
    ['OKX VET-USDT', () => okx(fetchImpl, fromTs)],
  ];
  const wantDays = Math.floor((toTs - fromTs) / DAY);
  let best = { source: '', series: {} };
  for (const [name, fn] of sources) {
    try {
      const series = await fn();
      const n = Object.keys(series).length;
      if (n > Object.keys(best.series).length) best = { source: name, series };
      if (n >= wantDays * 0.95) break;
    } catch (e) {
      errors.push(`${name}: ${e?.message ?? e}`);
    }
  }
  try {
    const cg = await coingeckoDaily(fetchImpl, 'vechain');
    let filled = 0;
    for (const [d, p] of Object.entries(cg)) if (!(d in best.series)) (best.series[d] = p), filled++;
    if (filled) best.source = best.source ? `${best.source} + CoinGecko` : 'CoinGecko (last 365 days)';
  } catch (e) {
    errors.push(`CoinGecko VET: ${e?.message ?? e}`);
  }
  return { ...best, errors };
}
