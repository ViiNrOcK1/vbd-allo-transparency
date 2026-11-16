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
import { classifyOutflow, poolHoldsB3tr, receiptPoolEvents } from './classify.mjs';
import { summarize } from './aggregate.mjs';
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
    return { appId: e.appId.toLowerCase(), amount: e.amount, teamWallet: e.teamWallet.toLowerCase(), reason: e.reason };
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
      return { to: e.to.toLowerCase(), value: e.value, txId: l.meta.txID };
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
        kind: classifyOutflow({ to: d.to, ownWallets: own, vbdContracts: VBD_CONTRACTS, isContract: contract, poolEvents, b3trPools }),
      });
    }
    wallets[w] = { balance, outflows };
    log(`wallet ${i + 1}/${walletList.length} ${w}: ${out.length} transfers out`);
  });

  await Promise.all([saveCache('contracts', contracts), saveCache('pools', pools), saveCache('receipts', receipts)]);

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
