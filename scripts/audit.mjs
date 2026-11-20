// Accuracy audit (Vinny, 2026-11-19: "I want to be absolutely sure").
// Runs in the GitHub job after src/index.mjs, from the private Actions cache.
//
// 1. Wallets paid per app per round, for the last 6 finished rounds, with
//    and without the app's own team wallets / endorsers. Plain text: these
//    are public counts, compared by hand with WalletWatcher's per-round users.
// 2. A random sample of merged groups with the on-chain evidence (rewards
//    received vs sent to the shared wallet; shared first funder). This has
//    addresses, so it is written to audit/sample.json and the workflow
//    encrypts it with audit/audit-public.pem; only the private key opens it.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import { createThor } from '../src/thor.mjs';

const XAV = '0x89A00Bb0947a30FF95BEeF77a66AEdE3842Fe5B7';
const ABI = parseAbi([
  'function currentRoundId() view returns (uint256)',
  'function roundSnapshot(uint256) view returns (uint256)',
  'function roundDeadline(uint256) view returns (uint256)',
]);
const load = async (n) => JSON.parse(await readFile(`cache/${n}.json`, 'utf8'));
const thor = createThor({ log: () => {} });
const call = async (fn, args = []) => {
  const data = await thor.call(XAV, encodeFunctionData({ abi: ABI, functionName: fn, args }));
  return decodeFunctionResult({ abi: ABI, functionName: fn, data });
};

const [payouts, excl, groups, sweeps, funders, summary] = await Promise.all([
  load('payouts'),
  load('excludeof').catch(() => ({})),
  load('auditgroups'),
  load('sweeps'),
  load('funders'),
  readFile('site/data/summary.json', 'utf8').then(JSON.parse),
]);
const nameOf = new Map(summary.apps.map((a) => [a.id.toLowerCase(), a.name.trim()]));

// ── 1. per round ──
const cur = Number(await call('currentRoundId'));
console.log(`\n=== Wallets paid per app per round (finished rounds ${cur - 6}–${cur - 1}) ===`);
const rounds = [];
for (let r = cur - 6; r < cur; r++) {
  const [s, d] = [Number(await call('roundSnapshot', [BigInt(r)])), Number(await call('roundDeadline', [BigInt(r)]))];
  const [bs, bd] = [await thor.block(s), await thor.block(d)];
  rounds.push({ r, from: bs.timestamp, to: bd.timestamp });
}
const per = new Map(); // round → app → { all:Set, users:Set }
for (const [at, ai, ri] of payouts.rows) {
  const rd = rounds.find((x) => at >= x.from && at <= x.to);
  if (!rd) continue;
  const app = payouts.apps[ai];
  const w = payouts.receivers[ri];
  if (!per.has(rd.r)) per.set(rd.r, new Map());
  const m = per.get(rd.r);
  if (!m.has(app)) m.set(app, { all: new Set(), users: new Set() });
  const x = m.get(app);
  x.all.add(w);
  if (!(excl[app] ?? []).includes(w)) x.users.add(w);
}
for (const { r, from, to } of rounds) {
  const m = per.get(r) ?? new Map();
  const rows = [...m.entries()].sort((a, b) => b[1].all.size - a[1].all.size).slice(0, 25);
  console.log(`\nRound ${r} (${new Date(from * 1000).toISOString().slice(0, 16)} → ${new Date(to * 1000).toISOString().slice(0, 16)} UTC): app | wallets paid | excl. team+endorsers`);
  for (const [app, x] of rows) console.log(`  ${(nameOf.get(app) ?? app.slice(0, 10)).padEnd(28)} ${String(x.all.size).padStart(6)} ${String(x.users.size).padStart(6)}`);
}

// ── 2. sample (encrypted by the workflow) ──
const since = Math.floor(Date.now() / 1000) - 90 * 86_400;
const rewards = new Map();
for (const [at, , ri, amt] of payouts.rows) if (at >= since) rewards.set(payouts.receivers[ri], (rewards.get(payouts.receivers[ri]) ?? 0) + amt);
const sentTo = (from, to) => {
  let t = 0;
  for (const [at, f, d, amt] of sweeps.rows) if (at >= since && sweeps.addrs[f] === from && sweeps.addrs[d] === to) t += amt;
  return t;
};
// Deterministic shuffle so a re-run gives the same sample the same day.
let seed = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (arr, n) => [...arr].sort(() => rnd() - 0.5).slice(0, n);
const r1 = (x) => Math.round(x * 10) / 10;

const sweepSample = [...groups.sweeps.slice(0, 5), ...pick(groups.sweeps.slice(5), 10)].map((g) => ({
  sharedWallet: g.dest,
  walletsInGroup: g.wallets.length,
  members: pick(g.wallets, 4).map((w) => ({ wallet: w, rewards90dB3tr: r1(rewards.get(w) ?? 0), sentToSharedB3tr: r1(sentTo(w, g.dest)) })),
}));
const funderSample = [...groups.funders.slice(0, 5), ...pick(groups.funders.slice(5), 10)].map((g) => ({
  funder: g.funder,
  walletsInGroup: g.wallets.length,
  members: pick(g.wallets, 4).map((w) => ({ wallet: w, firstFundedBy: funders[w] })),
}));
const passportSample = pick(groups.passport, 8).map(([a, b]) => ({ wallet: a, linkedTo: b }));
await mkdir('audit', { recursive: true });
await writeFile(
  'audit/sample.json',
  JSON.stringify({ generatedAt: new Date().toISOString(), explorer: 'https://explore.vechain.org/accounts/', sweepSample, funderSample, passportSample }, null, 1),
);
console.log(`\nSample written: ${sweepSample.length} sweep groups, ${funderSample.length} funder groups, ${passportSample.length} Passport links (encrypted below).`);
