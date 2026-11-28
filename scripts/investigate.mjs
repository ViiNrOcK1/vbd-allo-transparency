// Investigate a burst of new wallets on one app (Morb, 2026-11-27: "Mugshot
// getting hammered by farmers. +6.3k new wallets").
//
//   node scripts/investigate.mjs "<app name or id>" [days=7]
//
// Runs in Actions after the index step (it reads cache/payouts.json). The
// PUBLIC log gets counts only; everything with an address goes to
// investigate/out.json, which the workflow encrypts with the audit key
// before printing it. Never print an address from here.
//
// For each new wallet (first reward from any app in the last `days`, none in
// the 60 days before) and for a control sample of the app's older users:
//   - who sent it its first VET and its first VTHO (the funder)
//   - where its B3TR / VOT3 went (sweeps), and who paid the gas for its first
//     outgoing transaction (fee delegator)
//   - when it was first paid (bursts), how much, how often
//   - what proof the app published with its rewards (shared values)
// then joins wallets that share a funder, a sweep destination or a private
// fee delegator into groups.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { decodeEventLog, pad } from 'viem';
import { ABI, MAINNET, TOPIC } from '../src/abi.mjs';
import { createThor } from '../src/thor.mjs';

const DAY = 86_400;
const LOOKBACK_DAYS = 60;
const CONCURRENCY = 8;
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : dflt;
};
const OUT = flag('out', 'investigate/out.json');
const CONTROL_N = Number(flag('control', 500));
const [target, daysArg] = args;
const DAYS = Number(daysArg ?? 7);
const say = (...a) => console.log('[investigate]', ...a);

// investigate=bridges → bridge discovery; investigate=all → every app with
// at least 20 new wallets this week, one child run each, merged.
if (target === 'bridges') {
  await import('./bridges.mjs');
  process.exit(0);
}
if (String(target).startsWith('link:')) {
  process.env.APP = target;
  await import('./link.mjs');
  process.exit(0);
}
if (target === 'proceeds') {
  await import('./proceeds.mjs');
  process.exit(0);
}
if (target === 'all') {
  const { execFileSync } = await import('node:child_process');
  const { readFile: rf, writeFile: wf, mkdir: md } = await import('node:fs/promises');
  const s = JSON.parse(await rf('site/data/summary.json', 'utf8'));
  const list = s.apps
    .map((a) => ({ a, n: s.users?.apps?.[a.id]?.newWallets?.perWeek?.[0] ?? 0 }))
    .filter((x) => x.n >= 20)
    .sort((x, y) => y.n - x.n);
  say(`all apps: ${list.length} apps with 20+ new wallets this week`);
  await md('investigate', { recursive: true });
  const merged = { kind: 'all', apps: [] };
  for (const [i, { a }] of list.entries()) {
    const out = `investigate/app${i}.json`;
    try {
      execFileSync('node', ['scripts/investigate.mjs', a.id, String(DAYS), '--out', out, '--control', a.name.trim() === 'Mugshot' ? '500' : '150'], { stdio: 'inherit', timeout: 25 * 60_000 });
      merged.apps.push(JSON.parse(await rf(out, 'utf8')));
    } catch (e) {
      say(`app ${i + 1} failed: ${e.message.split('\n')[0]}`);
    }
  }
  await wf('investigate/out.json', JSON.stringify(merged));
  say('all apps written (encrypted below)');
  process.exit(0);
}

const thor = createThor({ log: () => {} });
const best = await thor.bestBlock();
const now = best.timestamp;
const summary = JSON.parse(await readFile('site/data/summary.json', 'utf8'));
const app = summary.apps.find((a) => a.id.toLowerCase() === String(target).toLowerCase() || a.name.trim().toLowerCase() === String(target).trim().toLowerCase());
if (!app) {
  say(`no app named "${target}"`);
  process.exit(1);
}
const appId = app.id.toLowerCase();
const teamSet = new Set((app.teamWallets ?? []).map((w) => w.toLowerCase()));

// ── 1. who is new ──
const pc = JSON.parse(await readFile('cache/payouts.json', 'utf8'));
const first = new Map(); // receiver index → [at, appIndex]
let oldest = Infinity;
for (const [at, a, r] of pc.rows) {
  oldest = Math.min(oldest, at);
  const f = first.get(r);
  if (!f || at < f[0]) first.set(r, [at, a]);
}
if (now - DAYS * DAY - oldest < LOOKBACK_DAYS * DAY) say(`WARNING: cache only reaches back ${Math.round((now - oldest) / DAY)} days`);
const aIdx = pc.apps.indexOf(appId);
const paidRecently = new Set();
for (const [at, a, r] of pc.rows) if (a === aIdx && at >= now - DAYS * DAY) paidRecently.add(r);
const isNew = (r) => {
  const f = first.get(r);
  return f && f[0] >= now - DAYS * DAY && f[1] === aIdx;
};
const newW = [...paidRecently].filter(isNew).map((r) => pc.receivers[r]).filter((w) => !teamSet.has(w));
const olderPool = [...paidRecently].filter((r) => first.get(r)[0] < now - (DAYS + LOOKBACK_DAYS) * DAY).map((r) => pc.receivers[r]);
// Deterministic sample (sorted, every k-th) so reruns compare.
olderPool.sort();
const step = Math.max(1, Math.floor(olderPool.length / CONTROL_N));
const control = olderPool.filter((_, i) => i % step === 0).slice(0, CONTROL_N);
say(`${app.name.trim()}: ${paidRecently.size} wallets paid in ${DAYS} days, ${newW.length} new, control sample ${control.length} of ${olderPool.length} long-time users`);

// ── 2. the app's payouts in the window, with proof ──
const fromBlock = Math.max(0, best.number - Math.ceil((DAYS + 1) * 8640));
const rlogs = await thor.logs([{ address: MAINNET.x2EarnRewardsPool, topic0: TOPIC.rewardDistributed, topic1: appId }], fromBlock, best.number);
const payouts = new Map(); // wallet → [{at, amount, proof, distributor, tx}]
for (const l of rlogs) {
  try {
    const ev = decodeEventLog({ abi: ABI, data: l.data, topics: l.topics });
    const w = ev.args.receiver.toLowerCase();
    (payouts.get(w) ?? payouts.set(w, []).get(w)).push({ at: l.meta.blockTimestamp, amount: Number(ev.args.amount / 10n ** 15n) / 1000, proof: ev.args.proof, distributor: ev.args.distributor.toLowerCase(), tx: l.meta.txID });
  } catch {}
}
say(`${rlogs.length} payouts read`);

// ── 3. per wallet: funding, outflows, fee delegator ──
const VTHO = '0x0000000000000000000000000000456e65726779';
const B3TR = MAINNET.b3tr.toLowerCase();
const VOT3 = MAINNET.vot3?.toLowerCase() ?? '0x76ca782b59c74d088c7d2cce2f211bc00836c602';
const topicAddr = (a) => pad(a, { size: 32 });
const addrOf = (t) => '0x' + t.slice(26).toLowerCase();
const amt = (hex) => Number(BigInt(hex) / 10n ** 15n) / 1000;
let failed = 0;
async function profile(w) {
  try {
    const [vet, vthoLog, b3trOut, vot3Out] = await Promise.all([
      thor.firstVetIn(w, best.number),
      thor.firstLog({ address: VTHO, topic0: TOPIC.transfer, topic2: topicAddr(w) }, best.number),
      thor.logs([{ address: B3TR, topic0: TOPIC.transfer, topic1: topicAddr(w) }], fromBlock - 60 * 8640, best.number),
      thor.logs([{ address: VOT3, topic0: TOPIC.transfer, topic1: topicAddr(w) }], fromBlock - 60 * 8640, best.number),
    ]);
    const outs = [...b3trOut.map((l) => ({ token: 'B3TR', l })), ...vot3Out.map((l) => ({ token: 'VOT3', l }))].sort((a, b) => a.l.meta.blockNumber - b.l.meta.blockNumber);
    let delegator = null;
    let origin = null;
    if (outs.length) {
      const tx = await fetch(`https://mainnet.vechain.org/transactions/${outs[0].l.meta.txID}`).then((r) => r.json()).catch(() => null);
      delegator = tx?.delegator?.toLowerCase() ?? (tx ? 'none' : null);
      origin = tx?.origin?.toLowerCase() ?? null;
    }
    return {
      w,
      vetFunder: vet?.from ?? null,
      vetAt: vet?.at ?? null,
      vthoFunder: vthoLog ? addrOf(vthoLog.topics[1]) : null,
      vthoAt: vthoLog?.meta.blockTimestamp ?? null,
      sent: outs.map(({ token, l }) => ({ token, to: addrOf(l.topics[2]), amount: amt(l.data), at: l.meta.blockTimestamp })),
      delegator,
      origin,
    };
  } catch {
    failed++;
    return { w, error: true };
  }
}
async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < list.length) {
        const k = i++;
        out[k] = await fn(list[k]);
      }
    }),
  );
  return out;
}
const t0 = Date.now();
const newP = await mapLimit(newW, CONCURRENCY, profile);
const ctrlP = await mapLimit(control, CONCURRENCY, profile);
say(`profiled ${newP.length + ctrlP.length} wallets in ${Math.round((Date.now() - t0) / 1000)}s, ${failed} failed`);

// ── 4. what kind of address is each shared counterparty ──
const codeCache = new Map();
const isContract = async (a) => {
  if (!codeCache.has(a)) codeCache.set(a, await thor.hasCode(a).catch(() => null));
  return codeCache.get(a);
};

const tally = (list, key) => {
  const m = new Map();
  for (const p of list) {
    const k = key(p);
    if (k == null) continue;
    for (const x of Array.isArray(k) ? new Set(k) : [k]) m.set(x, (m.get(x) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

function describe(list, label) {
  const ok = list.filter((p) => !p.error);
  const n = ok.length;
  const noFunding = ok.filter((p) => !p.vetFunder && !p.vthoFunder).length;
  const sentAny = ok.filter((p) => p.sent.length).length;
  const vetF = tally(ok, (p) => p.vetFunder);
  const vthoF = tally(ok, (p) => p.vthoFunder);
  const dest = tally(ok, (p) => p.sent.map((s) => s.to));
  const deleg = tally(ok, (p) => (p.delegator && p.delegator !== 'none' ? p.delegator : null));
  const pays = ok.map((p) => payouts.get(p.w) ?? []);
  const perWallet = pays.map((x) => x.length);
  const firstAt = pays.map((x) => x[0]?.at).filter(Boolean);
  const perHour = new Map();
  for (const t of firstAt) perHour.set(Math.floor(t / 3600), (perHour.get(Math.floor(t / 3600)) ?? 0) + 1);
  const perMinute = new Map();
  for (const t of firstAt) perMinute.set(Math.floor(t / 60), (perMinute.get(Math.floor(t / 60)) ?? 0) + 1);
  const b3trReceived = pays.reduce((a, x) => a + x.reduce((s, y) => s + y.amount, 0), 0);
  const sentTotal = ok.reduce((a, p) => a + p.sent.reduce((s, y) => s + y.amount, 0), 0);
  // Proof: flatten JSON proofs to key=value strings and count wallets per value.
  const proofVals = new Map();
  const proofKeys = new Map();
  ok.forEach((p, i) => {
    const seen = new Set();
    for (const x of pays[i]) {
      let j;
      try {
        j = JSON.parse(x.proof);
      } catch {
        j = { raw: x.proof };
      }
      const walk = (o, path) => {
        if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
        else if (o != null && String(o).length) seen.add(`${path}=${String(o).slice(0, 200)}`);
      };
      walk(j, '');
    }
    for (const s of seen) {
      proofVals.set(s, (proofVals.get(s) ?? 0) + 1);
      const k = s.split('=')[0];
      proofKeys.set(k, (proofKeys.get(k) ?? 0) + 1);
    }
  });
  const shared = [...proofVals.entries()].filter(([, c]) => c >= 5 && c < n * 0.9).sort((a, b) => b[1] - a[1]).slice(0, 40);
  return {
    label,
    wallets: n,
    noVetOrVthoEver: noFunding,
    sentAnyB3trOrVot3: sentAny,
    b3trReceived7d: Math.round(b3trReceived),
    b3trOrVot3SentOut: Math.round(sentTotal),
    payoutsPerWallet: { median: perWallet.sort((a, b) => a - b)[Math.floor(perWallet.length / 2)] ?? 0, max: Math.max(0, ...perWallet) },
    topVetFunders: vetF.slice(0, 25),
    topVthoFunders: vthoF.slice(0, 25),
    topSweepDestinations: dest.slice(0, 40),
    topFeeDelegators: deleg.slice(0, 15),
    busiestHours: [...perHour.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([h, c]) => [new Date(h * 3600e3).toISOString(), c]),
    busiestMinute: [...perMinute.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m, c]) => [new Date(m * 60e3).toISOString(), c]),
    firstPaidByDay: [...firstAt.reduce((m, t) => m.set(new Date(t * 1000).toISOString().slice(0, 10), (m.get(new Date(t * 1000).toISOString().slice(0, 10)) ?? 0) + 1), new Map())].sort(),
    proofKeys: [...proofKeys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
    proofValuesSharedBy5Plus: shared,
    examples: ok.slice(0, 3).map((p, i) => ({ w: p.w, proof: pays[i][0]?.proof?.slice(0, 600) })),
  };
}

const N = describe(newP, 'new wallets');
const C = describe(ctrlP, 'control: long-time users');

// ── 4b. proof photos: do "different" wallets upload the same picture? ──
// The app publishes each reward's proof on-chain; photo proofs are public
// links. A 64-bit difference hash (dHash) per photo; two photos within
// IMG_DIST bits are the same picture (re-uploads, crops, re-compression).
const IMG_DIST = 6;
const IMG_NEW = 3000;
const IMG_CTRL = 400;
const urlsOf = (w) => {
  const us = [];
  for (const x of payouts.get(w) ?? []) {
    try {
      const j = JSON.parse(x.proof);
      const walk = (o, k) => {
        if (o && typeof o === 'object') for (const [kk, v] of Object.entries(o)) walk(v, kk);
        else if (typeof o === 'string' && /^https?:\/\//.test(o) && (/image|photo|picture/i.test(k) || /\.(png|jpe?g|webp|heic)(\?|$)/i.test(o))) us.push(o);
      };
      walk(j, '');
    } catch {}
  }
  return us;
};
let sharp = null;
try {
  sharp = (await import('sharp')).default;
} catch {}
async function dhash(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const px = await sharp(buf).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
    let hi = 0;
    let lo = 0;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const bit = px[y * 9 + x] > px[y * 9 + x + 1] ? 1 : 0;
        const i = y * 8 + x;
        if (i < 32) hi = (hi << 1) | bit;
        else lo = (lo << 1) | bit;
      }
    return [hi >>> 0, lo >>> 0];
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
const pop = (x) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};
async function photoCheck(wallets, cap) {
  // Up to 3 photos per wallet, wallets in a fixed order.
  const items = [];
  for (const w of wallets) {
    for (const u of urlsOf(w).slice(0, 3)) items.push({ w, u });
    if (items.length >= cap) break;
  }
  const hashes = await mapLimit(items, 16, async (it) => ({ ...it, h: await dhash(it.u) }));
  const ok = hashes.filter((x) => x.h);
  // Pairs of photos from DIFFERENT wallets that are the same picture.
  const parentI = ok.map((_, i) => i);
  const f = (i) => (parentI[i] === i ? i : (parentI[i] = f(parentI[i])));
  let crossPairs = 0;
  for (let i = 0; i < ok.length; i++)
    for (let j = i + 1; j < ok.length; j++) {
      if (ok[i].w === ok[j].w) continue;
      if (pop(ok[i].h[0] ^ ok[j].h[0]) + pop(ok[i].h[1] ^ ok[j].h[1]) <= IMG_DIST) {
        crossPairs++;
        parentI[f(i)] = f(j);
      }
    }
  const clusters = new Map();
  ok.forEach((x, i) => {
    const r = f(i);
    (clusters.get(r) ?? clusters.set(r, []).get(r)).push(x);
  });
  const multi = [...clusters.values()].map((c) => ({ wallets: [...new Set(c.map((x) => x.w))], photos: c.map((x) => x.u) })).filter((c) => c.wallets.length >= 2).sort((a, b) => b.wallets.length - a.wallets.length);
  const walletsInShared = new Set(multi.flatMap((c) => c.wallets));
  const walletsChecked = new Set(ok.map((x) => x.w));
  return { photos: items.length, hashed: ok.length, walletsChecked: walletsChecked.size, crossWalletPairs: crossPairs, walletsSharingAPhoto: walletsInShared.size, sharedPct: pct(walletsInShared.size, walletsChecked.size), clusters: multi.slice(0, 60), biggest: multi.slice(0, 10).map((c) => c.wallets.length) };
}
let photoNew = null;
let photoCtrl = null;
if (sharp && newW.some((w) => urlsOf(w).length)) {
  photoNew = await photoCheck(newP.filter((p) => !p.error).map((p) => p.w), IMG_NEW);
  photoCtrl = await photoCheck(ctrlP.filter((p) => !p.error).map((p) => p.w), IMG_CTRL);
}
// Contact sheet for a human check: each row = one group of matched photos
// (different wallets), the last row = control photos. Encrypted with the rest.
if (photoNew?.clusters?.length && flag('sheet', process.env.INV_SHEET ?? '1') !== '0') {
  const T = 160;
  const rows = photoNew.clusters.slice(0, 8).map((c) => c.photos.slice(0, 6));
  rows.push(
    ctrlP
      .filter((p) => !p.error)
      .flatMap((p) => urlsOf(p.w).slice(0, 1))
      .slice(0, 6),
  );
  const tiles = [];
  for (const [ri, row] of rows.entries())
    for (const [ci, u] of row.entries()) {
      try {
        const r = await fetch(u);
        if (!r.ok) continue;
        const img = await sharp(Buffer.from(await r.arrayBuffer())).rotate().resize(T, T, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer();
        tiles.push({ input: img, left: ci * (T + 6), top: ri * (T + 6) + (ri === rows.length - 1 ? 18 : 0) });
      } catch {}
    }
  await mkdir('investigate', { recursive: true });
  await sharp({ create: { width: 6 * (T + 6), height: rows.length * (T + 6) + 18, channels: 3, background: '#ffffff' } })
    .composite(tiles)
    .jpeg({ quality: 72 })
    .toFile(OUT.replace(/\.json$/, '') + '-sheet.jpg');
  say(`contact sheet: ${tiles.length} photos`);
}

// ── 5. groups: shared funder / sweep destination / private delegator ──
const counts = (k) => new Map(N[k].map(([a, c]) => [a, c]));
const candidates = new Set([...N.topVetFunders, ...N.topVthoFunders, ...N.topSweepDestinations, ...N.topFeeDelegators].filter(([, c]) => c >= 3).map(([a]) => a));
const kind = {};
for (const a of candidates) kind[a] = (await isContract(a)) ? 'contract' : 'wallet';
// How common each counterparty is among long-time users too: shared with the
// control group = a service (exchange, VeWorld delegator), not a farm.
const inControl = (k, a) => (C[k].find(([x]) => x === a)?.[1] ?? 0);
const parent = new Map();
const find = (x) => {
  while (parent.has(x) && parent.get(x) !== x) x = parent.get(x);
  return x;
};
const union = (a, b) => {
  const ra = find(a);
  const rb = find(b);
  if (!parent.has(ra)) parent.set(ra, ra);
  if (!parent.has(rb)) parent.set(rb, rb);
  if (ra !== rb) parent.set(ra, rb);
};
const linkers = [];
for (const [k, field, take] of [
  ['topVetFunders', 'vetFunder', (p) => [p.vetFunder]],
  ['topVthoFunders', 'vthoFunder', (p) => [p.vthoFunder]],
  ['topSweepDestinations', 'sent', (p) => p.sent.map((s) => s.to)],
  ['topFeeDelegators', 'delegator', (p) => [p.delegator]],
]) {
  for (const [a, c] of N[k]) {
    if (c < 3 || kind[a] !== 'wallet') continue;
    const ctrl = inControl(k, a);
    if (ctrl > Math.max(1, C.wallets * 0.01)) continue; // common among real users too: a service
    linkers.push({ via: field, address: a, newWallets: c, controlWallets: ctrl });
    const members = newP.filter((p) => !p.error && take(p).includes(a)).map((p) => p.w);
    for (const m of members) union(m, `${field}:${a}`);
  }
}
const groups = new Map();
for (const p of newP) {
  if (p.error || !parent.has(p.w)) continue;
  const r = find(p.w);
  (groups.get(r) ?? groups.set(r, []).get(r)).push(p.w);
}
const groupList = [...groups.values()].sort((a, b) => b.length - a.length);
const inGroups = groupList.reduce((a, g) => a + g.length, 0);

// ── public log: counts only ──
say(`new: ${N.wallets} wallets · never got VET or VTHO: ${N.noVetOrVthoEver} (${pct(N.noVetOrVthoEver, N.wallets)}%) · moved B3TR/VOT3 out: ${N.sentAnyB3trOrVot3} (${pct(N.sentAnyB3trOrVot3, N.wallets)}%) · got ${N.b3trReceived7d} B3TR, sent out ${N.b3trOrVot3SentOut}`);
say(`control: ${C.wallets} wallets · never got VET or VTHO: ${C.noVetOrVthoEver} (${pct(C.noVetOrVthoEver, C.wallets)}%) · moved B3TR/VOT3 out: ${C.sentAnyB3trOrVot3} (${pct(C.sentAnyB3trOrVot3, C.wallets)}%)`);
say(`top VET funder funded ${N.topVetFunders[0]?.[1] ?? 0} new wallets; top VTHO funder ${N.topVthoFunders[0]?.[1] ?? 0}; top sweep destination got from ${N.topSweepDestinations[0]?.[1] ?? 0}; top fee delegator ${N.topFeeDelegators[0]?.[1] ?? 0}`);
say(`groups: ${groupList.length} groups hold ${inGroups} new wallets (${pct(inGroups, N.wallets)}%); biggest ${groupList.slice(0, 8).map((g) => g.length).join(', ')}`);
say(`first paid by day: ${N.firstPaidByDay.map(([d, c]) => `${d.slice(5)} ${c}`).join(' · ')} · busiest minute ${N.busiestMinute[0]?.[1] ?? 0} wallets`);
say(`proof: ${N.proofValuesSharedBy5Plus.length} proof values shared by 5+ new wallets (control: ${C.proofValuesSharedBy5Plus.length})`);
if (photoNew) say(`photos: new wallets ${photoNew.walletsSharingAPhoto} of ${photoNew.walletsChecked} (${photoNew.sharedPct}%) share the same picture with another wallet, ${photoNew.hashed}/${photoNew.photos} photos read, biggest groups ${photoNew.biggest.join(', ')} · control ${photoCtrl.walletsSharingAPhoto} of ${photoCtrl.walletsChecked} (${photoCtrl.sharedPct}%)`);

await mkdir('investigate', { recursive: true });
await writeFile(
  OUT,
  JSON.stringify({ app: app.name.trim(), appId, at: new Date(now * 1000).toISOString(), days: DAYS, lookbackDays: LOOKBACK_DAYS, newWallets: N, control: C, photoNew, photoCtrl, kind, linkers, groups: groupList.map((g) => ({ size: g.length, members: g })), profiles: newP }),
);
say('details written (encrypted below)');
