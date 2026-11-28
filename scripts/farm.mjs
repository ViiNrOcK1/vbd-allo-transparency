// Map a farm from its funding wallet (Morb, 2026-11-28: the wallet funding
// new ST3PR and World of V wallets is the ST3PR farmer, reported to the ST3PR
// dev; "more new active wallets, so likely need to revisit that farm").
//
//   workflow input investigate=farm:<sha256(address) first 16 hex>:<app>
//
// The address is found by hash among the first VET / VTHO funders of the
// app's wallets paid in the last 30 days, so the public run page names no one.
// Then: every wallet it ever sent VET or VTHO to, which apps rewarded them in
// the cache window (about 100 days), how much, which are active in the last
// 7 days, and where their B3TR / VOT3 went.
// Public log: counts only. Details encrypted.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pad } from 'viem';
import { MAINNET, TOPIC } from '../src/abi.mjs';
import { createThor } from '../src/thor.mjs';

const say = (...a) => console.log('[farm]', ...a);
const NODE = 'https://mainnet.vechain.org';
const VTHO = '0x0000000000000000000000000000456e65726779';
const B3TR = MAINNET.b3tr.toLowerCase();
const VOT3 = MAINNET.vot3.toLowerCase();
const DAY = 86_400;
const [, hash, appName] = String(process.env.APP ?? '').split(':');
const thor = createThor({ log: () => {} });
const best = await thor.bestBlock();
const now = best.timestamp;
const post = (p, b) => fetch(NODE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const amt = (v) => Number(BigInt(v) / 10n ** 15n) / 1000;
const addr = (t) => '0x' + t.slice(26).toLowerCase();
const hashOf = (a) => createHash('sha256').update(a.toLowerCase()).digest('hex').slice(0, 16);
async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]).catch(() => null); } }));
  return out;
}
async function vetTransfers(criteria, cap = 20_000) {
  const out = [];
  for (let offset = 0; offset < cap; offset += 1000) {
    const r = await post('/logs/transfer', { range: { unit: 'block', from: 0, to: best.number }, options: { offset, limit: 1000 }, criteriaSet: [criteria], order: 'asc' });
    if (!Array.isArray(r)) break;
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

const summary = JSON.parse(await readFile('site/data/summary.json', 'utf8'));
const app = summary.apps.find((a) => a.name.trim().toLowerCase() === String(appName).trim().toLowerCase());
const appNameOf = new Map(summary.apps.map((a) => [a.id.toLowerCase(), a.name.trim()]));
const pc = JSON.parse(await readFile('cache/payouts.json', 'utf8'));
const aIdx = pc.apps.indexOf(app.id.toLowerCase());
const recent = [...new Set(pc.rows.filter((r) => r[1] === aIdx && r[0] >= now - 30 * DAY).map((r) => pc.receivers[r[2]]))];
say(`${app.name.trim()}: ${recent.length} wallets paid in 30 days; looking for the funder among their first funders`);

// 1. find the funder by hash
let F = null;
const firstFunders = await mapLimit(recent, 12, async (w) => {
  const [v] = await post('/logs/transfer', { range: { unit: 'block', from: 0, to: best.number }, options: { offset: 0, limit: 1 }, criteriaSet: [{ recipient: w }], order: 'asc' });
  const [t] = await thor.logs([{ address: VTHO, topic0: TOPIC.transfer, topic2: pad(w, { size: 32 }) }], 0, best.number).then((ls) => ls.slice(0, 1));
  return [v ? String(v.sender).toLowerCase() : null, t ? addr(t.topics[1]) : null];
});
for (const f of firstFunders.flat()) if (f && hashOf(f) === hash) F = f;
say(`funder ${F ? 'FOUND' : 'not found'}`);
if (!F) process.exit(1);

// 2. everything it funded
const [vOut, tOut] = await Promise.all([vetTransfers({ sender: F }), thor.logs([{ address: VTHO, topic0: TOPIC.transfer, topic1: pad(F, { size: 32 }) }], 0, best.number)]);
const funded = new Map(); // wallet → {vet, vtho, first}
for (const x of vOut) {
  const w = String(x.recipient).toLowerCase();
  const f = funded.get(w) ?? funded.set(w, { vet: 0, vtho: 0, first: x.meta.blockTimestamp }).get(w);
  f.vet += amt(x.amount);
  f.first = Math.min(f.first, x.meta.blockTimestamp);
}
for (const l of tOut) {
  const w = addr(l.topics[2]);
  const f = funded.get(w) ?? funded.set(w, { vet: 0, vtho: 0, first: l.meta.blockTimestamp }).get(w);
  f.vtho += amt(l.data);
  f.first = Math.min(f.first, l.meta.blockTimestamp);
}
// Plain wallets only (no DEX, no contracts).
const fundedList = [];
for (const [w, f] of funded) if (!(await thor.hasCode(w).catch(() => true))) fundedList.push({ w, ...f });
say(`the funder sent VET/VTHO to ${funded.size} addresses, ${fundedList.length} of them plain wallets`);

// 3. their rewards (cache window) and outflows
const idx = new Map(pc.receivers.map((w, i) => [w, i]));
const byWallet = new Map();
for (const [at, a, r, b] of pc.rows) {
  const w = pc.receivers[r];
  if (!funded.has(w)) continue;
  const x = byWallet.get(w) ?? byWallet.set(w, { apps: {}, b3tr: 0, b3tr7: 0, last: 0 }).get(w);
  const n = appNameOf.get(pc.apps[a]) ?? pc.apps[a].slice(0, 10);
  x.apps[n] = (x.apps[n] ?? 0) + b;
  x.b3tr += b;
  if (at >= now - 7 * DAY) x.b3tr7 += b;
  x.last = Math.max(x.last, at);
}
const perApp = {};
for (const x of byWallet.values()) for (const [n, b] of Object.entries(x.apps)) {
  const p = (perApp[n] ??= { wallets: 0, b3tr: 0 });
  p.wallets++;
  p.b3tr += b;
}
const active7 = [...byWallet.values()].filter((x) => x.last >= now - 7 * DAY).length;
const outs = await mapLimit([...byWallet.keys()], 12, async (w) => {
  const ls = await thor.logs([B3TR, VOT3].map((a) => ({ address: a, topic0: TOPIC.transfer, topic1: pad(w, { size: 32 }) })), best.number - 110 * 8640, best.number);
  return { w, sent: ls.map((l) => ({ to: addr(l.topics[2]), value: amt(l.data) })) };
});
const dest = new Map();
for (const o of outs) if (o) for (const s of o.sent) {
  const d = dest.get(s.to) ?? dest.set(s.to, { wallets: new Set(), b3tr: 0 }).get(s.to);
  d.wallets.add(o.w);
  d.b3tr += s.value;
}
const destList = [...dest.entries()].map(([a, d]) => [a, d.wallets.size, Math.round(d.b3tr)]).sort((a, b) => b[2] - a[2]);
const funderBack = destList.find(([a]) => a === F);

say(`rewarded in the last ~100 days: ${byWallet.size} of its wallets, ${Math.round([...byWallet.values()].reduce((a, x) => a + x.b3tr, 0))} B3TR; active in the last 7 days: ${active7} wallets, ${Math.round([...byWallet.values()].reduce((a, x) => a + x.b3tr7, 0))} B3TR`);
say(`per app: ${Object.entries(perApp).sort((a, b) => b[1].b3tr - a[1].b3tr).map(([n, p]) => `${n} ${p.wallets} wallets ${Math.round(p.b3tr)} B3TR`).join(' · ')}`);
say(`their B3TR/VOT3 went to ${destList.length} places; biggest takes ${destList[0]?.[2] ?? 0} B3TR from ${destList[0]?.[1] ?? 0} wallets; back to the funder itself: ${funderBack ? `${funderBack[2]} B3TR from ${funderBack[1]} wallets` : 'none'}`);
const fundedByMonth = {};
for (const f of fundedList) fundedByMonth[new Date(f.first * 1000).toISOString().slice(0, 7)] = (fundedByMonth[new Date(f.first * 1000).toISOString().slice(0, 7)] ?? 0) + 1;
say(`wallets first funded per month: ${Object.entries(fundedByMonth).sort().map(([m, n]) => `${m} ${n}`).join(' · ')}`);

await mkdir('investigate', { recursive: true });
await writeFile(
  'investigate/out.json',
  JSON.stringify({
    kind: 'farm',
    funder: F,
    app: app.name.trim(),
    funded: fundedList.sort((a, b) => b.first - a.first),
    rewarded: [...byWallet.entries()].map(([w, x]) => ({ w, ...x })).sort((a, b) => b.b3tr - a.b3tr),
    perApp,
    destinations: destList.slice(0, 60),
  }),
);
say('details written (encrypted below)');
