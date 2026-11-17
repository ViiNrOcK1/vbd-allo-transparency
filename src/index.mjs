// Build data/summary.json from VeChain mainnet.
//
//   node src/index.mjs [--node https://mainnet.vechain.org] [--out site/data]
//
// Read-only. Caches (cache/*.json) remember which addresses are contracts,
// which pools hold B3TR, and what each transaction did, so a daily run only
// asks the node about what is new.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, pad } from 'viem';
import { ABI, GRANT_SOURCES, MAINNET, TOPIC, VBD_CONTRACTS } from './abi.mjs';
import { classifyInflow, classifyOutflow, poolHoldsB3tr, receiptPoolEvents } from './classify.mjs';
import { pickCurrentRound, summarize } from './aggregate.mjs';
import { createThor, mapLimit } from './thor.mjs';
import { coingeckoDaily, dailyB3trVet, dayOf, fetchVetUsd, foldSyncs, makePriceAt } from './prices.mjs';

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
    return { appId: e.appId.toLowerCase(), amount: e.amount, depositor: e.depositor.toLowerCase(), at: l.meta?.blockTimestamp ?? null };
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

  // ── Prices: B3TR/VET from the B3TR–VVET pools' Sync events × VET/USD ──
  const poolMeta = await loadCache('poolmeta'); // pool → { other, symbol, b3trIs0 }
  await mapLimit([...b3trPools], 6, async (p) => {
    if (poolMeta[p]) return;
    const [t0, t1] = await Promise.all([read(p, 'token0').catch(() => null), read(p, 'token1').catch(() => null)]);
    if (!t0 || !t1) return;
    const b3trIs0 = String(t0).toLowerCase() === MAINNET.b3tr.toLowerCase();
    const other = String(b3trIs0 ? t1 : t0).toLowerCase();
    const symbol = await read(other, 'symbol').catch(() => null);
    poolMeta[p] = { other, symbol, b3trIs0 };
  });
  log(`B3TR pools: ${[...b3trPools].map((p) => `${p} B3TR/${poolMeta[p]?.symbol ?? '?'}`).join(', ')}`);
  const vetPools = [...b3trPools].filter((p) => /^(v?vet|wvet)$/i.test(String(poolMeta[p]?.symbol ?? '')));
  const priceCache = await loadCache('prices');
  priceCache.pools ??= {};
  for (const p of vetPools) {
    const c = (priceCache.pools[p] ??= { lastBlock: -1, days: {} });
    const syncs = await thor.logs([{ address: p, topic0: TOPIC.sync }], c.lastBlock + 1, best.number);
    const b0 = poolMeta[p].b3trIs0;
    foldSyncs(
      c.days,
      syncs.map((l) => {
        const { args: e } = decode(l);
        return { at: l.meta.blockTimestamp, b3tr: b0 ? e.reserve0 : e.reserve1, vet: b0 ? e.reserve1 : e.reserve0 };
      }),
    );
    c.lastBlock = best.number;
    log(`price pool ${p} (B3TR/${poolMeta[p].symbol}): ${syncs.length} new trades, ${Object.keys(c.days).length} days`);
  }
  const claimTimes = claims.map((c) => c.at).filter((t) => t != null);
  const fromTs = (claimTimes.length ? Math.min(...claimTimes) : best.timestamp) - 30 * 86_400;
  const vet = await fetchVetUsd(fetch, fromTs, best.timestamp);
  priceCache.vetUsd = { ...(priceCache.vetUsd ?? {}), ...vet.series };
  log(`VET/USD: ${vet.source || 'NONE'} — ${Object.keys(vet.series).length} days${vet.errors.length ? ` (failed: ${vet.errors.join('; ')})` : ''}`);
  await Promise.all([saveCache('poolmeta', poolMeta), saveCache('prices', priceCache)]);
  const b3trVet = dailyB3trVet(Object.fromEntries(vetPools.map((p) => [p, priceCache.pools[p].days])));
  const priceAt = makePriceAt(b3trVet, priceCache.vetUsd);
  const priceSeries = {};
  for (let t = fromTs; t <= best.timestamp; t += 86_400) {
    const p = priceAt(t);
    if (p != null) priceSeries[dayOf(t)] = Number(p.toPrecision(5));
  }
  log(`B3TR/USD: ${Object.keys(priceSeries).length} priced days; today ${priceAt(best.timestamp)}`);

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
    // 6. Our historical B3TR price vs CoinGecko's, last 365 days.
    try {
      const cg = await coingeckoDaily(fetch, 'vebetterdao');
      // CoinGecko's daily point is the price AT 00:00 UTC — i.e. the close
      // of the day before — so compare it with our close of the previous day.
      const rows = [];
      for (const [d, p] of Object.entries(cg)) {
        const ours = priceAt(Date.parse(d) / 1000 - 1);
        if (ours && p) rows.push({ d, ours, cg: p, dev: Math.abs(ours / p - 1) });
      }
      const devs = rows.map((r) => r.dev).sort((a, b) => a - b);
      for (const r of [...rows].sort((a, b) => b.dev - a.dev).slice(0, 12)) {
        log(`price check worst: ${r.d} ours ${r.ours.toPrecision(4)} coingecko ${r.cg.toPrecision(4)} (${(r.dev * 100).toFixed(0)}%)`);
      }
      const med = devs.length ? devs[devs.length >> 1] : 1;
      // CoinGecko's B3TR series is ~2× every other source from about 20 Feb
      // to 31 Mar 2026 (CoinLore's monthly closes — Feb $0.00995, Mar $0.00904
      // — match the on-chain price, checked 2026-11-17). Report the spread
      // with and without that window so the gap is explained, not hidden.
      const odd = (d) => d >= '2026-02-20' && d <= '2026-03-31';
      const rest = rows.filter((r) => !odd(r.d)).map((r) => r.dev).sort((a, b) => a - b);
      const p90 = rest.length ? rest[Math.floor(rest.length * 0.9)] : 1;
      const inOdd = rows.filter((r) => odd(r.d)).length;
      add(
        'B3TR price used for $ values (on-chain pool × VET/USD) vs CoinGecko, last year',
        devs.length >= 200 && med < 0.1,
        `${devs.length} days compared · median difference ${(med * 100).toFixed(1)}% · 90% of days within ${(p90 * 100).toFixed(1)}%${inOdd ? ` (excluding ${inOdd} days, 20 Feb–31 Mar 2026, when CoinGecko shows about 2× the on-chain price; CoinLore’s monthly closes for those months match ours)` : ''}`,
      );
    } catch (e) {
      add('B3TR price vs CoinGecko', null, `could not reach CoinGecko this run (${String(e?.message ?? e).slice(0, 80)})`);
    }
  } catch (e) {
    add('cross-checks ran', false, String(e?.message ?? e).slice(0, 200));
  }

  // ── Grants / DAO payouts, in B3TR and VOT3, to ANY address ──
  // A grant is often paid to a founder's or project wallet and only then moved
  // to the team wallet (B3TR Beach's was), so looking only at the team
  // wallet's direct senders misses it. One hop is traced in aggregate.mjs.
  const grantCriteria = [MAINNET.b3tr, MAINNET.vot3].flatMap((token) =>
    [...GRANT_SOURCES].map((src) => ({ address: token, topic0: TOPIC.transfer, topic1: pad(src, { size: 32 }) })),
  );
  const grantLogs = await thor.logs(grantCriteria, 0, best.number);
  const grantsTo = {}; // recipient → { b3tr, vot3 }
  for (const l of grantLogs) {
    const { args: e } = decode(l);
    const to = e.to.toLowerCase();
    if (GRANT_SOURCES.has(to)) continue; // moves between DAO contracts
    const token = String(l.address).toLowerCase() === MAINNET.vot3.toLowerCase() ? 'vot3' : 'b3tr';
    grantsTo[to] ??= { b3tr: 0n, vot3: 0n };
    grantsTo[to][token] += e.value;
  }
  log(`${grantLogs.length} grant / DAO transfers to ${Object.keys(grantsTo).length} addresses`);

  const summary = summarize({
    apps,
    grantsTo,
    claims,
    deposits,
    withdrawals,
    poolBalances,
    wallets,
    xAllocationPool: MAINNET.xAllocationPool,
    priceAt,
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
        prices: {
          method: 'Each transfer is valued at that UTC day’s B3TR price: the last trade of the day in the deepest B3TR–VVET pool on VeChain, times that day’s VET/USD close.',
          b3trVetPools: vetPools.map((p) => ({ pool: p, pair: `B3TR/${poolMeta[p].symbol}` })),
          vetUsdSource: vet.source || null,
          b3trUsd: priceSeries,
        },
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
