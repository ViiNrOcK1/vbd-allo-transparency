// Where team money went after it left the team (Vinny, 2026-11-27: follow it
// past sales and to exchanges). On demand: workflow input investigate=proceeds.
//
// For every team wallet (and confirmed team wallets), every VET and B3TR
// transfer out to a plain wallet, grouped by destination. Each destination
// that took at least MIN_B3TR / MIN_VET is classified:
//   busy      — 1,000+ incoming transfers: an exchange hot wallet or service
//   deposit   — forwards ≥80% of what it got to ONE busy wallet: an exchange
//               deposit address (unique to one customer account)
//   bridge    — the Wanchain gateway
//   team      — another app's team wallet
//   wallet    — anything else
// For deposits: withdrawals from the same busy wallet within 72 hours of the
// deposit, of 85–100% of the amount, are listed as POSSIBLE matches only
// (thousands of customers share a hot wallet; this is evidence, not proof).
//
// Public log: totals per app and class. Addresses only in investigate/out.json
// (encrypted by the workflow).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pad } from 'viem';
import { MAINNET, TOPIC } from '../src/abi.mjs';
import { createThor } from '../src/thor.mjs';

const say = (...a) => console.log('[proceeds]', ...a);
const NODE = 'https://mainnet.vechain.org';
const thor = createThor({ log: () => {} });
const best = await thor.bestBlock();
const B3TR = MAINNET.b3tr.toLowerCase();
const BRIDGES = new Set(['0x8dc369fa992f2f3c38474e84b0a93cc9957b1b73']);
const MIN_B3TR = 1000;
const MIN_VET = 5000;
const amt = (v) => Number(BigInt(v) / 10n ** 15n) / 1000;
const addr = (t) => '0x' + t.slice(26).toLowerCase();
const post = (path, body) => fetch(NODE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

async function vetTransfers(criteria, from = 0, to = best.number, cap = 20_000) {
  const out = [];
  for (let offset = 0; offset < cap; offset += 1000) {
    const r = await post('/logs/transfer', { range: { unit: 'block', from, to }, options: { offset, limit: 1000 }, criteriaSet: [criteria], order: 'asc' });
    if (!Array.isArray(r)) break;
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}
async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); } }));
  return out;
}

const summary = JSON.parse(await readFile('site/data/summary.json', 'utf8'));
const teamOf = new Map();
for (const a of summary.apps) for (const w of [...(a.teamWallets ?? []), ...(a.confirmedWallets ?? []).map((c) => c.wallet)]) if (!teamOf.has(w.toLowerCase())) teamOf.set(w.toLowerCase(), a.name.trim());
for (const [id, list] of Object.entries(summary.paymentWallets ?? {})) for (const p of list ?? []) if (p.wallet) teamOf.set(p.wallet.toLowerCase(), `${summary.apps.find((a) => a.id.toLowerCase() === id)?.name.trim() ?? 'app'} payment wallet`);

const codeCache = new Map();
const isContract = async (a) => {
  if (!codeCache.has(a)) codeCache.set(a, await thor.hasCode(a).catch(() => false));
  return codeCache.get(a);
};

// 1. every transfer out of team wallets, to plain non-team wallets
const flows = []; // {app, team, token, to, value, at, tx}
await mapLimit([...teamOf.keys()], 4, async (w) => {
  const app = teamOf.get(w);
  const [b3, vet] = await Promise.all([
    thor.logs([{ address: B3TR, topic0: TOPIC.transfer, topic1: pad(w, { size: 32 }) }], 0, best.number),
    vetTransfers({ sender: w }),
  ]);
  for (const l of b3) flows.push({ app, team: w, token: 'B3TR', to: addr(l.topics[2]), value: amt(l.data), at: l.meta.blockTimestamp, block: l.meta.blockNumber, tx: l.meta.txID });
  for (const t of vet) flows.push({ app, team: w, token: 'VET', to: String(t.recipient).toLowerCase(), value: amt(t.amount), at: t.meta.blockTimestamp, block: t.meta.blockNumber, tx: t.meta.txID });
});
say(`${flows.length} transfers out of ${teamOf.size} team wallets`);

// 2. classify big destinations
const destTotals = new Map();
for (const f of flows) {
  const k = `${f.token}|${f.to}`;
  destTotals.set(k, (destTotals.get(k) ?? 0) + f.value);
}
const big = [...destTotals.entries()].filter(([k, v]) => v >= (k.startsWith('VET') ? MIN_VET : MIN_B3TR)).map(([k]) => k);
const cls = new Map(); // `${token}|${addr}` → {class, hot?, share?}
const busyCache = new Map();
async function isBusy(token, a) {
  const k = `${token}|${a}`;
  if (!busyCache.has(k)) {
    const n = token === 'VET' ? (await vetTransfers({ recipient: a }, 0, best.number, 1000)).length : await thor.countLogs({ address: B3TR, topic0: TOPIC.transfer, topic2: pad(a, { size: 32 }) }, 0, best.number, 1000);
    busyCache.set(k, n >= 1000);
  }
  return busyCache.get(k);
}
await mapLimit(big, 4, async (k) => {
  const [token, a] = k.split('|');
  if (teamOf.has(a)) return cls.set(k, { class: 'team', app: teamOf.get(a) });
  if (BRIDGES.has(a)) return cls.set(k, { class: 'bridge' });
  if (a === '0x0000000000000000000000000000000000000000') return cls.set(k, { class: 'burn' });
  if (await isContract(a)) return cls.set(k, { class: 'contract' });
  if (await isBusy(token, a)) return cls.set(k, { class: 'busy' });
  // Where did this wallet send what it got? (same token)
  const outs = token === 'VET' ? (await vetTransfers({ sender: a }, 0, best.number, 3000)).map((t) => ({ to: String(t.recipient).toLowerCase(), v: amt(t.amount) })) : (await thor.logs([{ address: B3TR, topic0: TOPIC.transfer, topic1: pad(a, { size: 32 }) }], 0, best.number)).map((l) => ({ to: addr(l.topics[2]), v: amt(l.data) }));
  const byTo = new Map();
  let total = 0;
  for (const o of outs) {
    byTo.set(o.to, (byTo.get(o.to) ?? 0) + o.v);
    total += o.v;
  }
  const [top, topV] = [...byTo.entries()].sort((x, y) => y[1] - x[1])[0] ?? [];
  if (top && topV >= 0.8 * total && !(await isContract(top)) && (await isBusy(token, top))) return cls.set(k, { class: 'deposit', hot: top, share: Math.round((topV / total) * 100) });
  if (top && topV >= 0.8 * total && BRIDGES.has(top)) return cls.set(k, { class: 'bridge (via wallet)', via: a });
  cls.set(k, { class: 'wallet', forwardsTop: top ?? null, forwardShare: total ? Math.round(((topV ?? 0) / total) * 100) : 0 });
});

// 3. totals per app and class
const per = {};
for (const f of flows) {
  const c = cls.get(`${f.token}|${f.to}`);
  const k = c ? c.class : teamOf.has(f.to) ? 'team' : 'small or contract';
  const p = (per[f.app] ??= {});
  const t = (p[f.token] ??= {});
  t[k] = (t[k] ?? 0) + f.value;
}
const hotTotals = new Map();
for (const f of flows) {
  const c = cls.get(`${f.token}|${f.to}`);
  const hot = c?.class === 'deposit' ? c.hot : c?.class === 'busy' ? f.to : null;
  if (hot) hotTotals.set(`${f.token}|${hot}`, (hotTotals.get(`${f.token}|${hot}`) ?? 0) + f.value);
}
const apps = Object.entries(per).sort((a, b) => ((b[1].B3TR?.deposit ?? 0) + (b[1].B3TR?.busy ?? 0)) - ((a[1].B3TR?.deposit ?? 0) + (a[1].B3TR?.busy ?? 0)));
for (const [app, t] of apps.slice(0, 25)) {
  const fmt = (o) => Object.entries(o ?? {}).filter(([k]) => k !== 'team' && k !== 'small or contract').sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ');
  say(`${app}: B3TR → ${fmt(t.B3TR) || '-'} | VET → ${fmt(t.VET) || '-'}`);
}
say(`${[...hotTotals.keys()].length} distinct busy wallets (exchanges/services) received team money directly or via deposit addresses`);

// 4. possible withdrawals matching deposits (private)
const matches = [];
const deposits = flows.filter((f) => cls.get(`${f.token}|${f.to}`)?.class === 'deposit' && f.value >= (f.token === 'VET' ? MIN_VET : MIN_B3TR));
await mapLimit(deposits.slice(0, 400), 3, async (f) => {
  const hot = cls.get(`${f.token}|${f.to}`).hot;
  const to = Math.min(best.number, f.block + 3 * 8640);
  const outs = f.token === 'VET'
    ? (await vetTransfers({ sender: hot }, f.block, to, 10_000)).map((t) => ({ to: String(t.recipient).toLowerCase(), v: amt(t.amount), at: t.meta.blockTimestamp, tx: t.meta.txID }))
    : (await thor.logs([{ address: B3TR, topic0: TOPIC.transfer, topic1: pad(hot, { size: 32 }) }], f.block, to)).map((l) => ({ to: addr(l.topics[2]), v: amt(l.data), at: l.meta.blockTimestamp, tx: l.meta.txID }));
  const cand = outs.filter((o) => o.v >= 0.85 * f.value && o.v <= f.value && o.to !== f.to && !teamOf.has(o.to));
  if (cand.length && cand.length <= 5) matches.push({ app: f.app, team: f.team, token: f.token, deposit: f.to, hot, value: f.value, at: f.at, tx: f.tx, candidates: cand });
});
say(`possible exchange withdrawal matches: ${matches.length} deposits with 1–5 candidate withdrawals (evidence only)`);

await mkdir('investigate', { recursive: true });
await writeFile('investigate/out.json', JSON.stringify({ kind: 'proceeds', at: new Date(best.timestamp * 1000).toISOString(), per, classes: Object.fromEntries(cls), hotTotals: [...hotTotals.entries()].sort((a, b) => b[1] - a[1]), matches }));
say('details written (encrypted below)');
