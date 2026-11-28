// Bridges off VeChain (Vinny, 2026-11-27: "apps are making cross chain
// connections easier so could be an easier way to transfer out").
//
// Discovery run, on demand (workflow input investigate=bridges). Public log:
// counts and totals only. investigate/out.json (encrypted by the workflow):
// every bridge transfer with sender, token, amount, destination account and
// whether the sender is a team wallet, a rewarded user or a new wallet.
//
// Wanchain is VeChain's bridge (VET, VTHO and B3TR to Ethereum and 40+ chains
// beyond). Its docs show the VeChain contract as the `to` of a VET bridge
// transaction: userLock(bytes32 smgID, uint256 tokenPairID, uint256 value,
// bytes userAccount), userAccount = the address on the other chain.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { decodeAbiParameters, decodeEventLog, parseAbi, toEventSelector, toFunctionSelector, pad } from 'viem';
import { MAINNET, TOPIC } from '../src/abi.mjs';
import { createThor } from '../src/thor.mjs';

const say = (...a) => console.log('[bridges]', ...a);
const thor = createThor({ log: () => {} });
const NODE = 'https://mainnet.vechain.org';
const best = await thor.bestBlock();
const GATEWAYS = { '0x8dc369fa992f2f3c38474e84b0a93cc9957b1b73': 'Wanchain gateway (from Wanchain docs)' };
const B3TR = MAINNET.b3tr.toLowerCase();
const VOT3 = MAINNET.vot3.toLowerCase();
const VTHO = '0x0000000000000000000000000000456e65726779';
const TOKENS = { [B3TR]: 'B3TR', [VOT3]: 'VOT3', [VTHO]: 'VTHO' };
const amt = (v) => Number(BigInt(v) / 10n ** 15n) / 1000;
const addr = (t) => '0x' + t.slice(26).toLowerCase();

// Event and function shapes of Wanchain's CrossDelegate contracts (EVM).
const EVENTS = parseAbi([
  'event UserLockLogger(bytes32 indexed smgID, uint256 indexed tokenPairID, address indexed tokenAccount, uint256 value, uint256 contractFee, bytes userAccount)',
  'event UserBurnLogger(bytes32 indexed smgID, uint256 indexed tokenPairID, address indexed tokenAccount, uint256 value, uint256 contractFee, uint256 fee, bytes userAccount)',
  'event SmgReleaseLogger(bytes32 indexed uniqueID, bytes32 indexed smgID, uint256 indexed tokenPairID, uint256 value, address tokenAccount, address userAccount)',
  'event SmgMintLogger(bytes32 indexed uniqueID, bytes32 indexed smgID, uint256 indexed tokenPairID, uint256 value, address tokenAccount, address userAccount)',
]);
const SIG = Object.fromEntries(EVENTS.map((e) => [toEventSelector(e), e.name]));
const USERLOCK = toFunctionSelector('userLock(bytes32,uint256,uint256,bytes)');

// Who is who: team wallets (public), rewarded wallets and new wallets (cache).
const summary = JSON.parse(await readFile('site/data/summary.json', 'utf8'));
const teamOf = new Map();
for (const a of summary.apps) for (const w of [...(a.teamWallets ?? []), ...(a.confirmedWallets ?? []).map((c) => c.wallet)]) teamOf.set(w.toLowerCase(), a.name.trim());
for (const [id, list] of Object.entries(summary.paymentWallets ?? {})) for (const p of list ?? []) if (p.wallet) teamOf.set(p.wallet.toLowerCase(), `${summary.apps.find((a) => a.id.toLowerCase() === id)?.name.trim() ?? 'app'} payment wallet`);
const pc = JSON.parse(await readFile('cache/payouts.json', 'utf8'));
const rewarded = new Map(); // wallet → { apps:Set, b3tr, first }
for (const [at, a, r, b] of pc.rows) {
  const w = pc.receivers[r];
  const x = rewarded.get(w) ?? rewarded.set(w, { apps: new Set(), b3tr: 0, first: at }).get(w);
  x.apps.add(pc.apps[a]);
  x.b3tr += b;
  x.first = Math.min(x.first, at);
}
const appName = new Map(summary.apps.map((a) => [a.id.toLowerCase(), a.name.trim()]));

// Find the gateways from the chain itself: every contract that ever emitted
// one of Wanchain's lock / burn / release / mint events.
for (const [topic, name] of Object.entries(SIG)) {
  try {
    const ls = await thor.logs([{ topic0: topic }], 0, best.number);
    const by = {};
    for (const l of ls) by[l.address.toLowerCase()] = (by[l.address.toLowerCase()] ?? 0) + 1;
    say(`${name}: ${ls.length} events from ${Object.keys(by).length} contracts`);
    for (const [a, n] of Object.entries(by)) if (n >= 5 && !GATEWAYS[a]) GATEWAYS[a] = `Wanchain-style gateway (emits ${name})`;
  } catch (e) {
    say(`${name}: lookup failed ${e.message}`);
  }
}
const out = { gateways: {}, transfers: [], byKind: {}, topicCounts: {} };
for (const [g, label] of Object.entries(GATEWAYS)) {
  const hasCode = await thor.hasCode(g).catch(() => null);
  if (!hasCode) {
    say(`${label}: not a contract on mainnet, skipped`);
    continue;
  }
  // Everything the contract itself logged, by event.
  const own = await thor.logs([{ address: g }], 0, best.number);
  const counts = {};
  for (const l of own) counts[SIG[l.topics[0]] ?? l.topics[0]] = (counts[SIG[l.topics[0]] ?? l.topics[0]] ?? 0) + 1;
  out.topicCounts[g] = counts;
  // Tokens sent INTO it, and VET sent into it.
  const tokenIn = await thor.logs([{ address: B3TR, topic0: TOPIC.transfer, topic2: pad(g, { size: 32 }) }, { address: VOT3, topic0: TOPIC.transfer, topic2: pad(g, { size: 32 }) }, { address: VTHO, topic0: TOPIC.transfer, topic2: pad(g, { size: 32 }) }], 0, best.number);
  const vetIn = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${NODE}/logs/transfer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ range: { unit: 'block', from: 0, to: best.number }, options: { offset, limit: 1000 }, criteriaSet: [{ recipient: g }], order: 'asc' }) }).then((x) => x.json());
    vetIn.push(...r);
    if (r.length < 1000 || offset >= 99_000) break;
  }
  // Decode each lock: the event if it matches Wanchain's shape, else the
  // transaction's userLock input.
  const lockByTx = new Map();
  for (const l of own) {
    if (SIG[l.topics[0]] !== 'UserLockLogger' && SIG[l.topics[0]] !== 'UserBurnLogger') continue;
    try {
      const ev = decodeEventLog({ abi: EVENTS, data: l.data, topics: l.topics });
      lockByTx.set(l.meta.txID, { pair: Number(ev.args.tokenPairID), token: ev.args.tokenAccount.toLowerCase(), value: amt(ev.args.value), to: ev.args.userAccount });
    } catch {}
  }
  const rows = [
    ...tokenIn.map((l) => ({ token: TOKENS[l.address.toLowerCase()] ?? l.address, from: addr(l.topics[1]), value: amt(l.data), at: l.meta.blockTimestamp, tx: l.meta.txID, origin: l.meta.txOrigin?.toLowerCase() })),
    ...vetIn.map((t) => ({ token: 'VET', from: String(t.sender).toLowerCase(), value: amt(t.amount), at: t.meta.blockTimestamp, tx: t.meta.txID, origin: t.meta.txOrigin?.toLowerCase() })),
  ];
  // Destination for rows without a decoded event: read the tx input.
  let readTx = 0;
  for (const r of rows) {
    const ev = lockByTx.get(r.tx);
    if (ev) {
      r.dest = ev.to;
      r.pair = ev.pair;
      continue;
    }
    if (readTx > 3000) continue;
    readTx++;
    const tx = await fetch(`${NODE}/transactions/${r.tx}`).then((x) => x.json()).catch(() => null);
    const c = tx?.clauses?.find((c) => c.to?.toLowerCase() === g && c.data?.startsWith(USERLOCK));
    if (c) {
      try {
        const [, pair, , account] = decodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }], '0x' + c.data.slice(10));
        r.dest = account;
        r.pair = Number(pair);
      } catch {}
    }
  }
  for (const r of rows) {
    const who = r.origin ?? r.from;
    const rw = rewarded.get(who) ?? rewarded.get(r.from);
    r.kind = teamOf.has(who) || teamOf.has(r.from) ? 'team' : rw ? (rw.first > best.timestamp - 7 * 86_400 ? 'new reward wallet (7d)' : 'reward wallet') : 'other';
    r.team = teamOf.get(who) ?? teamOf.get(r.from) ?? null;
    r.rewardApps = rw ? [...rw.apps].map((id) => appName.get(id) ?? id.slice(0, 10)) : [];
  }
  out.gateways[g] = { label, hasCode, ownLogs: own.length, tokenTransfersIn: tokenIn.length, vetTransfersIn: vetIn.length, decodedLocks: lockByTx.size, txInputsRead: readTx };
  out.transfers.push(...rows.map((r) => ({ gateway: g, ...r })));

  // Public: totals only.
  say(`${label}: contract=${hasCode} · ${own.length} logs by the contract (${Object.entries(counts).map(([k, v]) => `${k.length > 30 ? k.slice(0, 10) : k} ${v}`).join(', ')})`);
  const sum = (f) => rows.filter(f).reduce((a, r) => a + r.value, 0);
  for (const t of ['B3TR', 'VOT3', 'VTHO', 'VET']) {
    const n = rows.filter((r) => r.token === t).length;
    if (!n) continue;
    say(`  ${t}: ${n} transfers in, ${Math.round(sum((r) => r.token === t))} total · team ${Math.round(sum((r) => r.token === t && r.kind === 'team'))} · reward wallets ${Math.round(sum((r) => r.token === t && r.kind.startsWith('reward')))} · new reward wallets ${Math.round(sum((r) => r.token === t && r.kind.startsWith('new')))} · with destination decoded ${rows.filter((r) => r.token === t && r.dest).length}`);
  }
  const byTeam = {};
  for (const r of rows) if (r.team) byTeam[r.team] = (byTeam[r.team] ?? 0) + (r.token === 'B3TR' ? r.value : 0);
  say(`  B3TR bridged by team wallets, per app: ${Object.entries(byTeam).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round(v)}`).join(' · ') || 'none'}`);
  const byMonth = {};
  for (const r of rows) if (r.token === 'B3TR') byMonth[new Date(r.at * 1000).toISOString().slice(0, 7)] = (byMonth[new Date(r.at * 1000).toISOString().slice(0, 7)] ?? 0) + r.value;
  say(`  B3TR bridged per month: ${Object.entries(byMonth).sort().map(([m, v]) => `${m} ${Math.round(v)}`).join(' · ')}`);
}

// Other contracts that team wallets send B3TR to, beyond the ones we know
// (DEX pools, VOT3, VeBetterDAO): candidates for other bridges and apps.
const known = new Set([...Object.values(MAINNET).map((a) => a.toLowerCase()), ...Object.keys(GATEWAYS)]);
const teamWallets = [...teamOf.keys()];
const contractTotals = new Map();
for (let i = 0; i < teamWallets.length; i += 5) {
  const part = teamWallets.slice(i, i + 5).filter((w) => /^0x[0-9a-f]{40}$/.test(w));
  const logs = await thor.logs(part.map((w) => ({ address: B3TR, topic0: TOPIC.transfer, topic1: pad(w, { size: 32 }) })), 0, best.number).catch((e) => (say(`team scan part failed: ${e.message}`), []));
  for (const l of logs) {
    const to = addr(l.topics[2]);
    if (known.has(to) || teamOf.has(to)) continue;
    contractTotals.set(to, (contractTotals.get(to) ?? 0) + amt(l.data));
  }
}
const ranked = [...contractTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300);
const otherContracts = [];
for (const [a, v] of ranked) if (await thor.hasCode(a).catch(() => false)) otherContracts.push([a, Math.round(v)]);
out.otherContractsFromTeams = otherContracts.slice(0, 40);
say(`other contracts team wallets sent B3TR to (not DEX pools/VOT3/VBD): ${otherContracts.length} found; biggest takes ${otherContracts[0]?.[1] ?? 0} B3TR`);

await mkdir('investigate', { recursive: true });
await writeFile('investigate/out.json', JSON.stringify({ kind: 'bridges', at: new Date(best.timestamp * 1000).toISOString(), ...out }));
say('details written (encrypted below)');
