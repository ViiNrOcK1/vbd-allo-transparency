// Does a named wallet (.vet) connect to an app's burst of new wallets?
// (Morb, 2026-11-28: the Mugshot farmer is premium.vet, "he's scripting").
//
//   workflow input investigate=link:<name.vet>:<app name>
//
// 1. Resolve the name with VeChain Name Service (resolveUtils.getAddresses,
//    address from @vechain/sdk-network). Also every address of the farm's
//    side gets its primary .vet name, if any (getNames).
// 2. The farm side: the app's new wallets (same rule as the tracker), their
//    B3TR / VOT3 outflows, and who paid gas for their first outgoing tx.
// 3. Links, strongest first:
//    a. direct transfers (VET, VTHO, B3TR, VOT3) between the name and a farm
//       wallet or a farm gas sponsor;
//    b. the name funded (VET / VTHO) a gas sponsor, or the reverse;
//    c. two hops: a wallet that both the name and the farm side sent to or
//       received from (excluding busy wallets: exchanges, services, VOT3);
//    d. the name's own .vet-named counterparties.
// Public log: whether each check found anything, counts only. Addresses,
// names and transactions only in the encrypted output.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { decodeFunctionResult, encodeFunctionData, pad, parseAbi } from 'viem';
import { MAINNET, TOPIC } from '../src/abi.mjs';
import { createThor } from '../src/thor.mjs';

const say = (...a) => console.log('[link]', ...a);
const NODE = 'https://mainnet.vechain.org';
const RESOLVE_UTILS = '0xA11413086e163e41901bb81fdc5617c975Fa5a1A';
const VNS = parseAbi(['function getAddresses(string[] names) view returns (address[] addresses)', 'function getNames(address[] addresses) view returns (string[] names)']);
const VTHO = '0x0000000000000000000000000000456e65726779';
const B3TR = MAINNET.b3tr.toLowerCase();
const VOT3 = MAINNET.vot3.toLowerCase();
const DAY = 86_400;
const [, name, appName] = String(process.env.APP ?? process.argv[2] ?? '').split(':');
const thor = createThor({ log: () => {} });
const best = await thor.bestBlock();
const post = (p, b) => fetch(NODE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const call = async (fn, args) => {
  const r = await post('/accounts/*', { clauses: [{ to: RESOLVE_UTILS, value: '0x0', data: encodeFunctionData({ abi: VNS, functionName: fn, args }) }] });
  return decodeFunctionResult({ abi: VNS, functionName: fn, data: r[0].data });
};
const amt = (v) => Number(BigInt(v) / 10n ** 15n) / 1000;
const addr = (t) => '0x' + t.slice(26).toLowerCase();
async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]).catch(() => null); } }));
  return out;
}
async function vetTransfers(criteria, cap = 5000) {
  const out = [];
  for (let offset = 0; offset < cap; offset += 1000) {
    const r = await post('/logs/transfer', { range: { unit: 'block', from: 0, to: best.number }, options: { offset, limit: 1000 }, criteriaSet: [criteria], order: 'asc' });
    if (!Array.isArray(r)) break;
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}
// All value moving in and out of a wallet: VET, VTHO, B3TR, VOT3.
async function moves(w, cap = 5000) {
  const t = pad(w, { size: 32 });
  const [vIn, vOut, tokIn, tokOut] = await Promise.all([
    vetTransfers({ recipient: w }, cap),
    vetTransfers({ sender: w }, cap),
    thor.logs([VTHO, B3TR, VOT3].map((a) => ({ address: a, topic0: TOPIC.transfer, topic2: t })), 0, best.number),
    thor.logs([VTHO, B3TR, VOT3].map((a) => ({ address: a, topic0: TOPIC.transfer, topic1: t })), 0, best.number),
  ]);
  const tok = (a) => ({ [VTHO]: 'VTHO', [B3TR]: 'B3TR', [VOT3]: 'VOT3' })[a.toLowerCase()] ?? a;
  return [
    ...vIn.map((x) => ({ dir: 'in', token: 'VET', other: String(x.sender).toLowerCase(), value: amt(x.amount), at: x.meta.blockTimestamp, tx: x.meta.txID })),
    ...vOut.map((x) => ({ dir: 'out', token: 'VET', other: String(x.recipient).toLowerCase(), value: amt(x.amount), at: x.meta.blockTimestamp, tx: x.meta.txID })),
    ...tokIn.map((l) => ({ dir: 'in', token: tok(l.address), other: addr(l.topics[1]), value: amt(l.data), at: l.meta.blockTimestamp, tx: l.meta.txID })),
    ...tokOut.map((l) => ({ dir: 'out', token: tok(l.address), other: addr(l.topics[2]), value: amt(l.data), at: l.meta.blockTimestamp, tx: l.meta.txID })),
  ];
}

// 2. the farm side
const summary = JSON.parse(await readFile('site/data/summary.json', 'utf8'));
const app = summary.apps.find((a) => a.name.trim().toLowerCase() === String(appName).trim().toLowerCase());
const pc = JSON.parse(await readFile('cache/payouts.json', 'utf8'));
const first = new Map();
for (const [at, a, r] of pc.rows) {
  const f = first.get(r);
  if (!f || at < f[0]) first.set(r, [at, a]);
}
const aIdx = pc.apps.indexOf(app.id.toLowerCase());
const now = best.timestamp;
const farm = new Set();
for (const [at, a, r] of pc.rows) if (a === aIdx && at >= now - 7 * DAY && first.get(r)[0] >= now - 7 * DAY && first.get(r)[1] === aIdx) farm.add(pc.receivers[r]);
say(`farm side: ${farm.size} new wallets`);

const fromBlock = best.number - 70 * 8640;
const farmOut = await mapLimit([...farm], 12, async (w) => {
  const t = pad(w, { size: 32 });
  const ls = await thor.logs([B3TR, VOT3].map((a) => ({ address: a, topic0: TOPIC.transfer, topic1: t })), fromBlock, best.number);
  if (!ls.length) return { w, sent: [] };
  const tx = await fetch(`${NODE}/transactions/${ls[0].meta.txID}`).then((r) => r.json()).catch(() => null);
  return { w, sent: ls.map((l) => ({ to: addr(l.topics[2]), value: amt(l.data), tx: l.meta.txID })), delegator: tx?.delegator?.toLowerCase() ?? null };
});
const movers = farmOut.filter((x) => x?.sent.length);
const sponsors = new Map();
for (const m of movers) if (m.delegator) sponsors.set(m.delegator, (sponsors.get(m.delegator) ?? 0) + 1);
const farmDest = new Map();
for (const m of movers) for (const s of m.sent) farmDest.set(s.to, (farmDest.get(s.to) ?? 0) + 1);
say(`farm side: ${movers.length} wallets moved B3TR/VOT3, ${sponsors.size} gas sponsors, ${farmDest.size} destinations`);

// 1. find the named wallet among everyone around the farm, by name hash
// (the run input carries only sha256(name), first 16 hex, so the public run
// page names no one).
const { createHash } = await import('node:crypto');
const hashOf = (n) => createHash('sha256').update(String(n).toLowerCase()).digest('hex').slice(0, 16);
const around = new Map(); // address → where we saw it
const note = (a, why) => a && !around.has(a) && around.set(a, why);
for (const [s] of sponsors) note(s, 'farm gas sponsor');
for (const [d] of farmDest) note(d, 'farm sweep destination');
const hop2 = [...[...sponsors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a]) => a), ...[...farmDest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([a]) => a)];
const hopMoves = new Map();
for (const a of hop2) {
  if (a === VOT3 || (await thor.hasCode(a).catch(() => true))) continue;
  const mv = await moves(a, 3000).catch(() => []);
  hopMoves.set(a, mv);
  for (const m of mv) note(m.other, `counterparty of ${around.get(a)} ${a}`);
}
let P = null;
const named = {};
const all = [...around.keys()];
for (let i = 0; i < all.length; i += 50) {
  const part = all.slice(i, i + 50);
  const ns = await call('getNames', [part]).catch(() => part.map(() => ''));
  part.forEach((a, k) => {
    if (!ns[k]) return;
    named[a] = ns[k];
    if (hashOf(ns[k]) === name) P = a;
  });
}
say(`${all.length} wallets around the farm checked, ${Object.keys(named).length} have a .vet name; target ${P ? 'FOUND' : 'not found'} within two hops`);
if (!P) {
  await mkdir('investigate', { recursive: true });
  await writeFile('investigate/out.json', JSON.stringify({ kind: 'link', found: false, app: app.name.trim(), farmSize: farm.size, movers: movers.length, sponsors: [...sponsors.entries()], topFarmDestinations: [...farmDest.entries()].slice(0, 30), named }));
  say('details written (encrypted below)');
  process.exit(0);
}
const pRewards = (() => { const i = pc.receivers.indexOf(P); return i >= 0 ? pc.rows.filter((r) => r[2] === i) : []; })();

// 3. links
const pMoves = await moves(P, 20_000);
const isFarm = (a) => farm.has(a);
const links = { direct: [], sponsorFunding: [], twoHop: [], namedCounterparties: [] };
for (const m of pMoves) {
  if (isFarm(m.other)) links.direct.push({ kind: 'name ↔ farm wallet', ...m });
  if (sponsors.has(m.other)) links.direct.push({ kind: 'name ↔ farm gas sponsor', sponsorFor: sponsors.get(m.other), ...m });
  if (farmDest.has(m.other)) links.direct.push({ kind: 'name ↔ farm sweep destination', farmWalletsSending: farmDest.get(m.other), ...m });
}
// Gas sponsors: who funded them (VET/VTHO), and do they touch the name?
const busyCache = new Map();
const isBusy = async (a) => {
  if (!busyCache.has(a)) busyCache.set(a, (await vetTransfers({ recipient: a }, 1000)).length >= 1000 || (await thor.countLogs({ address: B3TR, topic0: TOPIC.transfer, topic2: pad(a, { size: 32 }) }, 0, best.number, 1000)) >= 1000);
  return busyCache.get(a);
};
const pCounter = new Map();
for (const m of pMoves) pCounter.set(m.other, (pCounter.get(m.other) ?? 0) + 1);
for (const [s, n] of [...sponsors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
  const sm = await moves(s, 5000);
  for (const m of sm) {
    if (m.other === P) links.sponsorFunding.push({ sponsor: s, sponsorFor: n, ...m });
    else if (pCounter.has(m.other) && m.other !== VOT3 && !(await isBusy(m.other))) links.twoHop.push({ via: m.other, side: `gas sponsor of ${n} farm wallets`, sponsor: s, ...m, nameMoves: pCounter.get(m.other) });
  }
}
// Two hops through farm sweep destinations (non-busy wallets only).
for (const [d, n] of [...farmDest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  if (d === VOT3 || (await thor.hasCode(d).catch(() => true)) || (await isBusy(d))) continue;
  const dm = await moves(d, 3000);
  for (const m of dm) {
    if (m.other === P) links.twoHop.push({ via: d, side: `sweep destination of ${n} farm wallets`, ...m });
  }
}
// .vet names of everyone involved.
const everyone = [...new Set([...Object.keys(named), ...sponsors.keys(), ...[...farmDest.keys()].slice(0, 200), ...[...pCounter.keys()].slice(0, 300)])];
const names = {};
for (let i = 0; i < everyone.length; i += 50) {
  const part = everyone.slice(i, i + 50);
  const ns = await call('getNames', [part]).catch(() => part.map(() => ''));
  part.forEach((a, k) => ns[k] && (names[a] = ns[k]));
}
for (const [a, n] of Object.entries(names)) if (pCounter.has(a)) links.namedCounterparties.push({ address: a, name: n, moves: pCounter.get(a) });

say(`direct links: ${links.direct.length} · sponsor funded by / funding the name: ${links.sponsorFunding.length} · two-hop links: ${links.twoHop.length} · named counterparties: ${links.namedCounterparties.length}`);
await mkdir('investigate', { recursive: true });
await writeFile(
  'investigate/out.json',
  JSON.stringify({
    kind: 'link',
    found: true,
    name: named[P],
    address: P,
    seenAs: around.get(P),
    app: app.name.trim(),
    farmSize: farm.size,
    movers: movers.length,
    sponsors: [...sponsors.entries()].sort((a, b) => b[1] - a[1]),
    topFarmDestinations: [...farmDest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30),
    nameRewards: pRewards.length,
    nameMoves: pMoves.length,
    nameCounterparties: [...pCounter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60),
    links,
    names,
  }),
);
say('details written (encrypted below)');
