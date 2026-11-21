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
  load('sweeps2'),
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

// ── 1b. per app: which rule merged its wallets, and how big the groups are ──
// (Pokerdutchie, 2026-11-21: "what's behind PerGram's -38%?")
{
  const { personOfFactory } = await import('../src/people.mjs');
  const sweepPairs = groups.sweeps.flatMap((g) => g.wallets.map((w) => [w, g.dest]));
  const funderPairs = groups.funders.flatMap((g) => g.wallets.map((w) => [w, g.funder]));
  const personOf = personOfFactory([...groups.passport, ...sweepPairs, ...funderPairs]);
  const inSweep = new Set(sweepPairs.flat());
  const inFunder = new Set(funderPairs.flat());
  const inPassport = new Set(groups.passport.flat());
  const since30 = Math.floor(Date.now() / 1000) - 30 * 86_400;
  const byApp = new Map(); // app → Set(wallet)
  for (const [at, ai, ri] of payouts.rows) {
    if (at < since30) continue;
    const app = payouts.apps[ai];
    const w = payouts.receivers[ri];
    if ((excl[app] ?? []).includes(w)) continue;
    if (!byApp.has(app)) byApp.set(app, new Set());
    byApp.get(app).add(w);
  }
  // Which apps each wallet earned from (30 days), to describe groups.
  const appsOf = new Map();
  for (const [app, ws] of byApp) for (const w of ws) (appsOf.get(w) ?? appsOf.set(w, new Set()).get(w)).add(nameOf.get(app) ?? app.slice(0, 10));
  console.log('\n=== Per app (30 days): wallets, people, and which rule touched the merged wallets ===');
  const rows = [...byApp.entries()].map(([app, ws]) => {
    const groupsHere = new Map();
    for (const w of ws) {
      const p = personOf(w);
      if (!groupsHere.has(p)) groupsHere.set(p, []);
      groupsHere.get(p).push(w);
    }
    const merged = [...groupsHere.values()].filter((g) => g.length > 1);
    const mergedWallets = merged.flat();
    const rule = { sweep: 0, funder: 0, passport: 0 };
    for (const w of mergedWallets) {
      if (inSweep.has(w)) rule.sweep++;
      if (inFunder.has(w)) rule.funder++;
      if (inPassport.has(w)) rule.passport++;
    }
    const biggest = merged.map((g) => g.length).sort((a, b) => b - a).slice(0, 5);
    return { app, name: nameOf.get(app) ?? app.slice(0, 10), wallets: ws.size, people: groupsHere.size, rule, biggest, merged };
  });
  rows.sort((a, b) => b.wallets - a.wallets);
  for (const r of rows.slice(0, 30)) {
    console.log(`  ${r.name.padEnd(28)} ${String(r.wallets).padStart(5)} → ${String(r.people).padStart(5)} (−${Math.round((1 - r.people / r.wallets) * 100)}%)  merged wallets touched by: sweep ${r.rule.sweep}, funder ${r.rule.funder}, passport ${r.rule.passport}; biggest groups in this app: ${r.biggest.join(', ') || '-'}`);
  }
  globalThis.__perApp = { rows, appsOf, personOf, inSweep, inFunder, inPassport };
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
// The biggest groups inside the most-merged app, with what links them and
// which apps the members earn from (for Pokerdutchie's PerGram question).
const { rows: appRows, appsOf } = globalThis.__perApp;
const focus = appRows.filter((r) => r.wallets >= 100).sort((a, b) => a.people / a.wallets - b.people / b.wallets)[0];
const hubOf = new Map();
for (const g of groups.sweeps) for (const w of g.wallets) hubOf.set(w, `sweeps to ${g.dest} (${g.wallets.length} wallets)`);
const funderOf = new Map();
for (const g of groups.funders) for (const w of g.wallets) funderOf.set(w, `first funded by ${g.funder} (${g.wallets.length} wallets)`);
const passportOf = new Map(groups.passport.map(([a, b]) => [a, `passport-linked to ${b}`]));
const focusGroups = focus
  ? focus.merged
      .sort((a, b) => b.length - a.length)
      .slice(0, 6)
      .map((g) => ({
        walletsFromThisApp: g.length,
        links: [...new Set(g.map((w) => hubOf.get(w) ?? funderOf.get(w) ?? passportOf.get(w) ?? 'linked via another wallet in the group'))].slice(0, 6),
        alsoEarnsFrom: [...new Set(g.flatMap((w) => [...(appsOf.get(w) ?? [])]))].slice(0, 10),
        sample: g.slice(0, 5),
      }))
  : [];
await mkdir('audit', { recursive: true });
await writeFile(
  'audit/sample.json',
  JSON.stringify({ generatedAt: new Date().toISOString(), explorer: 'https://explore.vechain.org/accounts/', sweepSample, funderSample, passportSample, focusApp: focus?.name, focusGroups }, null, 1),
);
console.log(`\nSample written: ${sweepSample.length} sweep groups, ${funderSample.length} funder groups, ${passportSample.length} Passport links (encrypted below).`);
