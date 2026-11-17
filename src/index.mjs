// Build data/summary.json from VeChain mainnet.
//
//   node src/index.mjs [--node https://mainnet.vechain.org] [--out site/data]
//
// Read-only. Caches (cache/*.json) remember which addresses are contracts,
// which pools hold B3TR, and what each transaction did, so a daily run only
// asks the node about what is new.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, pad } from 'viem';
import { ABI, MAINNET, TOPIC, VBD_CONTRACTS } from './abi.mjs';
import { classifyInflow, classifyOutflow, poolHoldsB3tr, receiptPoolEvents } from './classify.mjs';
import { pickCurrentRound, summarize } from './aggregate.mjs';
import { createThor, mapLimit } from './thor.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const OUT = args.out ?? 'site/data';
const CACHE_DIR = 'cache';
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);
const thor = createThor({ node: args.node, log });

async function loadCache(name) {
  try {
    return JSON.parse(await readFile(`${CACHE_DIR}/${name}.json`, 'utf8'));
  } catch {
    return {};
  }
}
async function saveCache(name, value) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(`${CACHE_DIR}/${name}.json`, JSON.stringify(value));
}

async function read(address, functionName, argsList = []) {
  const data = await thor.call(address, encodeFunctionData({ abi: ABI, functionName, args: argsList }));
  return data === null ? null : decodeFunctionResult({ abi: ABI, functionName, data });
}

const decode = (l) => decodeEventLog({ abi: ABI, topics: l.topics, data: l.data });

async function main() {
  const best = await thor.bestBlock();
  log(`best block ${best.number}`);

  // ── apps ──
  const rawApps = await read(MAINNET.x2EarnApps, 'apps');
  const apps = await mapLimit(rawApps, 8, async (a) => {
    const pctRaw = await read(MAINNET.x2EarnApps, 'teamAllocationPercentage', [a.id]).catch(() => null);
    return {
      id: a.id.toLowerCase(),
      name: a.name,
      active: a.appAvailableForAllocationVoting,
      teamWallet: a.teamWalletAddress.toLowerCase(),
      teamAllocationPercentage: pctRaw === null ? null : Number(pctRaw),
    };
  });
  log(`${apps.length} apps`);

  // ── allocation claims ──
  const claimLogs = await thor.logs([{ address: MAINNET.xAllocationPool, topic0: TOPIC.claimed }], 0, best.number);
  const claims = claimLogs.map((l) => {
    const { args: e } = decode(l);
    return {
      appId: e.appId.toLowerCase(),
      round: Number(e.roundId),
      total: e.totalAmount,
      toTeam: e.teamAllocationAmount,
      toPool: e.rewardsAllocationAmount,
      unallocated: e.unallocatedAmount,
      recipient: e.recipient.toLowerCase(),
      at: l.meta?.blockTimestamp ?? null,
    };
  });
  log(`${claims.length} allocation claims`);

  // ── rewards pool in / out ──
  const depositLogs = await thor.logs([{ address: MAINNET.x2EarnRewardsPool, topic0: TOPIC.deposit }], 0, best.number);
  const deposits = depositLogs.map((l) => {
    const { args: e } = decode(l);
    return { appId: e.appId.toLowerCase(), amount: e.amount, depositor: e.depositor.toLowerCase() };
  });
  const withdrawalLogs = await thor.logs(
    [{ address: MAINNET.x2EarnRewardsPool, topic0: TOPIC.withdrawal }],
    0,
    best.number,
  );
  const withdrawals = withdrawalLogs.map((l) => {
    const { args: e } = decode(l);
    return { appId: e.appId.toLowerCase(), amount: e.amount, teamWallet: e.teamWallet.toLowerCase(), reason: e.reason, at: l.meta?.blockTimestamp ?? null };
  });
  log(`${deposits.length} deposits, ${withdrawals.length} team withdrawals`);

  const poolBalances = Object.fromEntries(
    await mapLimit(apps, 8, async (a) => [a.id, (await read(MAINNET.x2EarnRewardsPool, 'totalBalance', [a.id])) ?? 0n]),
  );

  // ── team wallets ──
  const walletSet = new Set(apps.map((a) => a.teamWallet));
  for (const c of claims) walletSet.add(c.recipient);
  for (const w of withdrawals) walletSet.add(w.teamWallet);
  // Wallets that belong to the same app(s), for "internal" moves.
  const groupOf = new Map();
  const appWallets = new Map(apps.map((a) => [a.id, new Set([a.teamWallet])]));
  for (const c of claims) appWallets.get(c.appId)?.add(c.recipient);
  for (const w of withdrawals) appWallets.get(w.appId)?.add(w.teamWallet);
  for (const ws of appWallets.values()) for (const w of ws) {
    const g = groupOf.get(w) ?? new Set();
    for (const x of ws) g.add(x);
    groupOf.set(w, g);
  }

  const contracts = await loadCache('contracts'); // address → bool
  const pools = await loadCache('pools'); // address → bool (holds B3TR)
  const receipts = await loadCache('receipts'); // txId → {swaps:[],mints:[]}

  const isContract = async (addr) => {
    if (!(addr in contracts)) contracts[addr] = await thor.hasCode(addr).catch(() => false);
    return contracts[addr];
  };
  const b3trPools = new Set(Object.keys(pools).filter((p) => pools[p]));
  const holdsB3tr = async (addr) => {
    if (!(addr in pools)) {
      const [t0, t1] = await Promise.all([
        read(addr, 'token0').catch(() => null),
        read(addr, 'token1').catch(() => null),
      ]);
      pools[addr] = poolHoldsB3tr(t0, t1, MAINNET.b3tr);
      if (pools[addr]) b3trPools.add(addr);
    }
    return pools[addr];
  };
  const poolEventsOf = async (txId) => {
    if (!receipts[txId]) {
      const r = await thor.receipt(txId);
      const { swaps, mints } = receiptPoolEvents(r);
      receipts[txId] = { swaps: [...swaps], mints: [...mints] };
    }
    return { swaps: new Set(receipts[txId].swaps), mints: new Set(receipts[txId].mints) };
  };

  const wallets = {};
  const walletList = [...walletSet];
  await mapLimit(walletList, 4, async (w, i) => {
    const out = await thor.logs(
      [{ address: MAINNET.b3tr, topic0: TOPIC.transfer, topic1: pad(w, { size: 32 }) }],
      0,
      best.number,
    );
    const balance = (await read(MAINNET.b3tr, 'balanceOf', [w])) ?? 0n;
    const own = groupOf.get(w) ?? new Set([w]);
    const decoded = out.map((l) => {
      const { args: e } = decode(l);
      return { to: e.to.toLowerCase(), value: e.value, txId: l.meta.txID, at: l.meta.blockTimestamp };
    });

    // In parallel and cached: which recipients are contracts, then — only for
    // contracts we don't recognise — what their transactions did.
    const unknown = new Set([...new Set(decoded.map((d) => d.to))].filter((to) => !own.has(to) && !VBD_CONTRACTS[to]));
    await mapLimit([...unknown], 10, (to) => isContract(to));
    const needsReceipt = [...new Set(decoded.filter((d) => unknown.has(d.to) && contracts[d.to]).map((d) => d.txId))];
    await mapLimit(needsReceipt, 8, async (txId) => {
      const ev = await poolEventsOf(txId);
      for (const p of [...ev.swaps, ...ev.mints]) await holdsB3tr(p);
    });

    const outflows = [];
    for (const d of decoded) {
      const known = own.has(d.to) || Boolean(VBD_CONTRACTS[d.to]);
      const contract = known ? true : contracts[d.to];
      const poolEvents = !known && contract ? await poolEventsOf(d.txId) : null;
      outflows.push({
        to: d.to,
        value: d.value,
        txId: d.txId,
        at: d.at,
        kind: classifyOutflow({ to: d.to, ownWallets: own, vbdContracts: VBD_CONTRACTS, isContract: contract, poolEvents, b3trPools }),
      });
    }
    // ── Inflows: where this wallet's B3TR came from (allocation, pool
    //    withdrawals, grants/DAO, purchases, …). Without this, selling grant
    //    money read as selling the allocation (B3TR Beach, 2026-11-16).
    const inLogs = await thor.logs(
      [{ address: MAINNET.b3tr, topic0: TOPIC.transfer, topic2: pad(w, { size: 32 }) }],
      0,
      best.number,
    );
    const inDecoded = inLogs.map((l) => {
      const { args: e } = decode(l);
      return { from: e.from.toLowerCase(), value: e.value };
    });
    const senders = [...new Set(inDecoded.map((d) => d.from))].filter((f) => !own.has(f) && !VBD_CONTRACTS[f]);
    await mapLimit(senders, 10, (f) => isContract(f));
    await mapLimit(senders.filter((f) => contracts[f]), 8, (f) => holdsB3tr(f));
    const inflows = inDecoded.map((d) => ({
      from: d.from,
      value: d.value,
      kind: classifyInflow({ from: d.from, ownWallets: own, vbdContracts: VBD_CONTRACTS, isContract: Boolean(contracts[d.from]), isB3trPool: Boolean(pools[d.from]) }),
    }));
    wallets[w] = { balance, outflows, inflows };
    log(`wallet ${i + 1}/${walletList.length} ${w}: ${out.length} transfers out`);
  });

  await Promise.all([saveCache('contracts', contracts), saveCache('pools', pools), saveCache('receipts', receipts)]);

  // ── Cross-checks: the same facts from independent on-chain sources ──
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const fmt = (w) => (Number(w / 10n ** 14n) / 1e4).toLocaleString('en-US');
  try {
    // 1. Every claim in the current round vs the pool's own roundEarnings().
    const cur = pickCurrentRound(claims);
    const inCur = claims.filter((c) => c.round === cur);
    let mismatches = 0;
    await mapLimit(inCur, 8, async (c) => {
      const r = await read(MAINNET.xAllocationPool, 'roundEarnings', [BigInt(cur), c.appId]).catch(() => null);
      if (!r || r[0] !== c.total || r[2] !== c.toTeam) mismatches++;
    });
    add(`Round #${cur}: each claim event = XAllocationPool.roundEarnings()`, mismatches === 0, `${inCur.length - mismatches}/${inCur.length} match`);
    // 2. Round total vs what Emissions says apps got that round.
    const emitted = await read(MAINNET.emissions, 'getXAllocationAmount', [BigInt(cur)]).catch(() => null);
    if (emitted !== null) {
      const claimed = inCur.reduce((a, c) => a + c.total + c.unallocated, 0n);
      add(
        `Round #${cur}: claimed (incl. unallocated) vs Emissions.getXAllocationAmount()`,
        claimed <= emitted,
        `${fmt(claimed)} of ${fmt(emitted)} B3TR (${emitted ? Number((claimed * 1000n) / emitted) / 10 : 0}%) — apps that haven't claimed yet make up the rest`,
      );
    }
    // 3. Team-share transfers seen arriving vs team share in claim events.
    const tracked = new Set(Object.keys(wallets));
    const shareEvents = claims.filter((c) => tracked.has(c.recipient)).reduce((a, c) => a + c.toTeam, 0n);
    const shareTransfers = Object.values(wallets).flatMap((x) => x.inflows).filter((f) => f.kind === 'allocation').reduce((a, f) => a + f.value, 0n);
    add('Team share: B3TR transfers into team wallets = claim events', shareEvents === shareTransfers, `${fmt(shareTransfers)} vs ${fmt(shareEvents)} B3TR`);
    // 4. Withdrawal transfers vs TeamWithdrawal events.
    const wdEvents = withdrawals.filter((x) => tracked.has(x.teamWallet)).reduce((a, x) => a + x.amount, 0n);
    const wdTransfers = Object.values(wallets).flatMap((x) => x.inflows).filter((f) => f.kind === 'pool_withdrawal').reduce((a, f) => a + f.value, 0n);
    // The pool also pays rewards (distributeReward) — a team wallet that used
    // its own or another app as a user receives those too, so transfers may
    // exceed withdrawals by that much, never fall short.
    const extra = wdTransfers - wdEvents;
    add(
      'Pool withdrawals: B3TR transfers into team wallets ≥ TeamWithdrawal events',
      extra >= 0n,
      `${fmt(wdTransfers)} vs ${fmt(wdEvents)} B3TR${extra > 0n ? ` (+${fmt(extra)} = rewards paid to team wallets as users)` : ''}`,
    );
    // 5. The rewards pool's actual B3TR vs the sum of per-app balances.
    const poolHeld = (await read(MAINNET.b3tr, 'balanceOf', [MAINNET.x2EarnRewardsPool])) ?? 0n;
    const sumApps = Object.values(poolBalances).reduce((a, b) => a + b, 0n);
    add('Rewards pool: B3TR held ≥ sum of every app\'s balance', poolHeld >= sumApps, `holds ${fmt(poolHeld)}, apps' balances ${fmt(sumApps)} B3TR`);
  } catch (e) {
    add('cross-checks ran', false, String(e?.message ?? e).slice(0, 200));
  }

  const summary = summarize({
    apps,
    claims,
    deposits,
    withdrawals,
    poolBalances,
    wallets,
    xAllocationPool: MAINNET.xAllocationPool,
  });

  await mkdir(OUT, { recursive: true });
  await writeFile(
    `${OUT}/summary.json`,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        bestBlock: best.number,
        source: 'VeChain mainnet, read directly from the VeBetterDAO contracts',
        checks,
        contracts: MAINNET,
        ...summary,
      },
      null,
      1,
    ),
  );
  log(`wrote ${OUT}/summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
