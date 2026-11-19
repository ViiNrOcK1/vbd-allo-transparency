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
import { emptyPayouts, foldPayouts, userStats, WINDOW_DAYS } from './users.mjs';
import { currentLinks, decodePassportLog, personOfFactory } from './people.mjs';
import { earliestFunding, funderLinks } from './funders.mjs';
import { candidateDestinations, emptySweeps, foldSweeps, KEEP_DAYS as SWEEP_KEEP_DAYS, sweepLinks } from './sweeps.mjs';
import { coingeckoDaily, dailyB3trVet, dayOf, fetchVetUsd, foldSyncs, makePriceAt, seriesLookup } from './prices.mjs';

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

  // ── Users per app: distinct wallets paid in the last 30 / 90 days ──
  let users = null;
  let payoutCache = null;
  try {
    const cached = await loadCache('payouts');
    const pc = Array.isArray(cached.rows) ? cached : emptyPayouts();
    const windowStart = Math.max(0, best.number - (WINDOW_DAYS + 10) * 8640);
    const from = Math.max(pc.lastBlock + 1, windowStart);
    const pl = await thor.logs([{ address: MAINNET.x2EarnRewardsPool, topic0: TOPIC.rewardDistributed }], from, best.number);
    foldPayouts(
      pc,
      pl.map((l) => {
        const { args: e } = decode(l);
        return { at: l.meta.blockTimestamp, appId: e.appId, receiver: e.receiver, amount: e.amount };
      }),
      best.timestamp,
    );
    pc.lastBlock = best.number;
    await saveCache('payouts', pc);
    payoutCache = pc;
    log(`payouts: ${pl.length} new, ${pc.rows.length} kept`);
  } catch (e) {
    log(`users per app FAILED: ${e?.message ?? e}`);
  }

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

  // ── What each proven sale actually returned ──
  // A sale is valued by what came back to the wallet in the same transaction
  // (native VET, or VVET / a USD stablecoin), at that day's VET/USD — not by
  // the day's B3TR price. Falls back to the day price when the proceeds went
  // elsewhere or came back in a token we can't price.
  const proceeds = await loadCache('proceeds'); // txId → { vet, usdTokens } (B3TR-free, in whole units)
  const symbols = await loadCache('symbols');
  const symbolOf = async (t) => {
    if (!(t in symbols)) symbols[t] = (await read(t, 'symbol').catch(() => null)) ?? '';
    return symbols[t];
  };
  const vetUsdAt = seriesLookup(priceCache.vetUsd);
  const units = (wei) => Number(BigInt(wei) / 10n ** 12n) / 1e6;
  let exactSales = 0;
  for (const [w, flows] of Object.entries(wallets)) {
    const byTx = new Map();
    for (const f of flows.outflows) if (f.kind === 'sold' && f.txId) byTx.set(f.txId, [...(byTx.get(f.txId) ?? []), f]);
    await mapLimit([...byTx.keys()], 8, async (txId) => {
      const key = `${txId}:${w}`;
      if (!proceeds[key]) {
        const r = await thor.receipt(txId);
        let vet = 0;
        let usdTokens = 0;
        let unpriced = false;
        for (const o of r?.outputs ?? []) {
          for (const t of o.transfers ?? []) if (String(t.recipient).toLowerCase() === w) vet += units(t.amount);
          for (const ev of o.events ?? []) {
            if (ev.topics?.[0] !== TOPIC.transfer || ev.topics.length < 3) continue;
            if ('0x' + ev.topics[2].slice(26).toLowerCase() !== w) continue;
            const token = String(ev.address).toLowerCase();
            if (token === MAINNET.b3tr.toLowerCase()) continue;
            const sym = await symbolOf(token);
            if (/^(v?vet|wvet)$/i.test(sym)) vet += units(ev.data);
            else if (/^(usdc|usdt|usdglo|glo|veusd|dai|usd)/i.test(sym)) usdTokens += units(ev.data);
            else unpriced = true;
          }
        }
        proceeds[key] = { vet, usdTokens, unpriced };
      }
    });
    for (const [txId, fs] of byTx) {
      const p = proceeds[`${txId}:${w}`];
      const vu = vetUsdAt(dayOf(fs[0].at));
      if (!p || p.unpriced || (!p.vet && !p.usdTokens) || (p.vet && vu == null)) continue;
      const usdTotal = p.vet * (vu ?? 0) + p.usdTokens;
      const sent = fs.reduce((a, f) => a + f.value, 0n);
      for (const f of fs) f.usd = sent ? (usdTotal * Number((f.value * 10_000n) / sent)) / 10_000 : 0;
      exactSales++;
    }
  }
  await Promise.all([saveCache('proceeds', proceeds), saveCache('symbols', symbols)]);
  log(`sales valued by their actual proceeds: ${exactSales}`);

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

  // ── Endorsers, and rewards an app paid to its own team or its endorsers ──
  // Morb (2026-11-18): endorser rewards and some teams' share are paid with
  // distributeReward, the same call as user rewards, so "paid to users" over-
  // counted. Every wallet that has ever endorsed an app (AppEndorsed, all
  // versions) and every team wallet is looked up as a RewardDistributed
  // receiver; payouts to them FROM THAT SAME APP are split out.
  const endorsersOf = {}; // appId → Set(wallet)
  const rewardsTo = {}; // `${appId}|${wallet}` → { wei: string, usd: number }
  try {
    const el = await thor.logs(
      [
        { address: MAINNET.x2EarnApps, topic0: TOPIC.appEndorsedOld },
        { address: MAINNET.x2EarnApps, topic0: TOPIC.appEndorsedNew },
      ],
      0,
      best.number,
    );
    for (const l of el) {
      const appId = String(l.topics[1]).toLowerCase();
      let who = null;
      if (l.topics[0] === TOPIC.appEndorsedNew) who = '0x' + String(l.data).slice(2 + 24, 2 + 64);
      else if (BigInt('0x' + String(l.data).slice(2 + 64, 2 + 128)) === 1n) who = l.meta.txOrigin; // endorsed = true
      if (!who) continue;
      (endorsersOf[appId] ??= new Set()).add(String(who).toLowerCase());
    }
    const nEndorsers = new Set(Object.values(endorsersOf).flatMap((s) => [...s])).size;
    log(`endorsements: ${el.length} events, ${nEndorsers} endorser wallets across ${Object.keys(endorsersOf).length} apps`);

    const rc = await loadCache('rewardsto'); // wallet → { lastBlock, by: { appId: { wei, usd } } }
    const targets = new Set([...[...walletSet].map((w) => w.toLowerCase()), ...Object.values(endorsersOf).flatMap((s) => [...s])]);
    await mapLimit([...targets], 8, async (w) => {
      const c = (rc[w] ??= { lastBlock: -1, by: {} });
      if (c.lastBlock >= best.number) return;
      const ls = await thor.logs(
        [{ address: MAINNET.x2EarnRewardsPool, topic0: TOPIC.rewardDistributed, topic2: pad(w, { size: 32 }) }],
        c.lastBlock + 1,
        best.number,
      );
      for (const l of ls) {
        const appId = String(l.topics[1]).toLowerCase();
        const amount = BigInt('0x' + String(l.data).slice(2, 66));
        const e = (c.by[appId] ??= { wei: '0', usd: 0 });
        e.wei = (BigInt(e.wei) + amount).toString();
        const p = priceAt(l.meta.blockTimestamp);
        if (p != null) e.usd += (Number(amount / 10n ** 12n) / 1e6) * p;
      }
      c.lastBlock = best.number;
    });
    await saveCache('rewardsto', rc);
    for (const [w, c] of Object.entries(rc)) for (const [appId, e] of Object.entries(c.by)) rewardsTo[`${appId}|${w}`] = e;
    log(`rewards to team/endorser wallets: ${Object.keys(rewardsTo).length} (app, wallet) pairs`);
  } catch (e) {
    log(`endorser / team rewards FAILED: ${e?.message ?? e}`);
  }

  // Wallets one person linked together through VeBetter Passport.
  let personOf = null;
  let passportPairs = [];
  try {
    const cached = await loadCache('passportlinks');
    const pl = Array.isArray(cached.events) ? cached : { lastBlock: -1, events: [] };
    const fresh = await thor.logs(
      [TOPIC.linkCreated, TOPIC.linkRemoved, TOPIC.delegationCreated, TOPIC.delegationRevoked].map((t) => ({ address: MAINNET.veBetterPassport, topic0: t })),
      pl.lastBlock + 1,
      best.number,
    );
    for (const l of fresh) {
      const e = decodePassportLog(l, TOPIC);
      if (e) pl.events.push(e);
    }
    pl.lastBlock = best.number;
    await saveCache('passportlinks', pl);
    const pairs = currentLinks(pl.events);
    passportPairs = pairs;
    personOf = personOfFactory(pairs);
    log(`passport links: ${fresh.length} new events, ${pairs.length} links in force`);
  } catch (e) {
    log(`passport links FAILED (counting wallets only): ${e?.message ?? e}`);
  }

  // Sweeps: reward wallets sending most of their rewards to one wallet
  // (sweeps.mjs). Reads every B3TR transfer (~430k per 3 weeks, under a
  // minute), so the whole window is read in one run; the cap only guards
  // against a slow node.
  let sweepInfo = null;
  if (payoutCache && personOf) {
    try {
      const cached = await loadCache('sweeps');
      const sc = Array.isArray(cached.rows) ? cached : emptySweeps();
      const windowStart = Math.max(0, best.number - (SWEEP_KEEP_DAYS + 2) * 8640);
      const from = Math.max(sc.lastBlock + 1, windowStart);
      const to = Math.min(best.number, from + 120 * 8640); // ≤ 120 days of blocks per run
      const receivers = new Set(payoutCache.receivers);
      if (from <= to) {
        const tl = await thor.logs([{ address: MAINNET.b3tr, topic0: TOPIC.transfer }], from, to);
        foldSweeps(
          sc,
          tl.map((l) => ({
            at: l.meta.blockTimestamp,
            from: '0x' + l.topics[1].slice(26),
            to: '0x' + l.topics[2].slice(26),
            amount: BigInt(l.data),
          })),
          (a) => receivers.has(a),
          best.timestamp,
        );
        sc.lastBlock = to;
        await saveCache('sweeps', sc);
        log(`sweeps: blocks ${from}–${to}, ${tl.length} B3TR transfers read, ${sc.rows.length} kept`);
      }
      // VOT3 too (Vinny, 2026-11-19): some farmers convert to VOT3 first and
      // move the VOT3. 1 VOT3 = 1 B3TR, so it adds to the same totals. Mints
      // and burns (to/from the zero address) are conversions, not sweeps.
      {
        const vFrom = Math.max((sc.lastBlockVot3 ?? -1) + 1, windowStart);
        const vTo = Math.min(best.number, vFrom + 120 * 8640);
        if (vFrom <= vTo) {
          const vl = await thor.logs([{ address: MAINNET.vot3, topic0: TOPIC.transfer }], vFrom, vTo);
          const ZERO_ADDR = '0x' + '0'.repeat(40);
          foldSweeps(
            sc,
            vl
              .map((l) => ({ at: l.meta.blockTimestamp, from: '0x' + l.topics[1].slice(26), to: '0x' + l.topics[2].slice(26), amount: BigInt(l.data) }))
              .filter((t) => t.from !== ZERO_ADDR && t.to !== ZERO_ADDR),
            (a) => receivers.has(a),
            best.timestamp,
          );
          sc.lastBlockVot3 = vTo;
          await saveCache('sweeps', sc);
          log(`sweeps: ${vl.length} VOT3 transfers read`);
        }
      }
      const teamWallets = new Set([...appWallets.values()].flatMap((ws) => [...ws].map((x) => x.toLowerCase())));
      const vbd = new Set(Object.keys(VBD_CONTRACTS).map((x) => x.toLowerCase()));
      const cands = candidateDestinations(sc, payoutCache, best.timestamp);
      await mapLimit(cands, 10, (d) => isContract(d));
      await saveCache('contracts', contracts);
      const ZERO_A = '0x' + '0'.repeat(40);
      const excluded = (a) => a === ZERO_A || teamWallets.has(a) || vbd.has(a) || GRANT_SOURCES.has(a) || Boolean(contracts[a]) || a === MAINNET.x2EarnRewardsPool.toLowerCase();
      const sw = sweepLinks(sc, payoutCache, best.timestamp, excluded);

      // Same funder (funders.mjs): each reward wallet's first VET / VTHO.
      // Never changes, so it's cached forever; up to 6,000 new wallets per
      // run, so the first few runs fill it in.
      let fund = null;
      try {
        const fc = await loadCache('funders'); // wallet → funder | null
        const VTHO = '0x0000000000000000000000000000456E65726779';
        const recent = new Set();
        const since = best.timestamp - 90 * 86_400;
        for (const [at, , r] of payoutCache.rows) if (at >= since) recent.add(payoutCache.receivers[r]);
        const todo = [...recent].filter((w) => !(w in fc)).slice(0, 6000);
        let done = 0;
        await mapLimit(todo, 10, async (w) => {
          try {
            const [vet, vthoLog] = await Promise.all([
              thor.firstVetIn(w, best.number),
              thor.firstLog({ address: VTHO, topic0: TOPIC.transfer, topic2: '0x' + '0'.repeat(24) + w.slice(2) }, best.number),
            ]);
            const vtho = vthoLog ? { from: ('0x' + vthoLog.topics[1].slice(26)).toLowerCase(), block: vthoLog.meta.blockNumber } : null;
            fc[w] = earliestFunding(vet, vtho)?.from ?? null;
            done++;
          } catch {
            /* try again next run */
          }
        });
        await saveCache('funders', fc);
        const funderCands = [...new Set([...recent].map((w) => fc[w]).filter(Boolean))];
        const counts = new Map();
        for (const w of recent) if (fc[w]) counts.set(fc[w], (counts.get(fc[w]) ?? 0) + 1);
        await mapLimit(funderCands.filter((f) => counts.get(f) >= 2), 10, (f) => isContract(f));
        await saveCache('contracts', contracts);
        const fl = funderLinks(fc, [...recent], excluded);
        const known = [...recent].filter((w) => w in fc).length;
        fund = {
          checkedWallets: known,
          ofWallets: recent.size,
          caughtUp: known >= recent.size,
          groups: fl.groups.length,
          walletsInGroups: fl.groups.reduce((t, g) => t + g.wallets.length, 0),
          tooBig: fl.tooBig.length,
          pairs: fl.pairs,
        };
        log(`funders: ${done} new wallets checked (${known} of ${recent.size}), ${fund.groups} groups, ${fund.walletsInGroups} wallets, ${fl.tooBig.length} service-sized funders skipped`);
      } catch (e) {
        log(`funders FAILED (skipped): ${e?.message ?? e}`);
      }
      // Days of transfer history read, out of the 90-day window (10 s blocks).
      const caughtUp = sc.lastBlock >= best.number;
      const coveredDays = Math.max(0, Math.min(90, Math.floor((sc.lastBlock - (best.number - 90 * 8640)) / 8640)));
      personOf = personOfFactory([...passportPairs, ...sw.pairs, ...(fund?.pairs ?? [])]);
      sweepInfo = {
        coveredDays,
        caughtUp,
        groups: sw.groups.length,
        walletsInGroups: sw.groups.reduce((t, g) => t + g.wallets.length, 0),
        // Counts only: no addresses in the public file (nobody is named a
        // farm without a person looking first).
        largestGroup: sw.groups[0]?.wallets.length ?? 0,
        tooBig: sw.tooBig.length,
        funders: fund ? { ...fund, pairs: undefined } : null,
      };
      log(`sweeps: ${sweepInfo.groups} groups, ${sweepInfo.walletsInGroups} wallets, ${sw.tooBig.length} service-sized destinations skipped, covered ${sweepInfo.coveredDays} days${caughtUp ? '' : ' (catching up)'}`);
    } catch (e) {
      log(`sweeps FAILED (Passport links only): ${e?.message ?? e}`);
    }
  }

  // Users per app, now that we know whose wallets are not users.
  if (payoutCache) {
    const excludeOf = {};
    for (const [id, ws] of appWallets) excludeOf[id.toLowerCase()] = new Set([...ws].map((w) => w.toLowerCase()));
    for (const [id, es] of Object.entries(endorsersOf)) for (const e of es) (excludeOf[id] ??= new Set()).add(e);
    users = userStats(payoutCache, best.timestamp, excludeOf, personOf);
    users.sweeps = sweepInfo;
    // Sanity check on linking: size of the biggest merged groups among
    // recent reward wallets. A giant group would mean chained false links.
    if (personOf) {
      const since90 = best.timestamp - 90 * 86_400;
      const comp = new Map();
      const seenW = new Set();
      for (const [at, , r] of payoutCache.rows) {
        if (at < since90 || seenW.has(r)) continue;
        seenW.add(r);
        const p = personOf(payoutCache.receivers[r]);
        comp.set(p, (comp.get(p) ?? 0) + 1);
      }
      const sizes = [...comp.values()].sort((x, y) => y - x);
      const hist = { '1': 0, '2-5': 0, '6-20': 0, '21-50': 0, '51-300': 0, '300+': 0 };
      for (const n of sizes) hist[n === 1 ? '1' : n <= 5 ? '2-5' : n <= 20 ? '6-20' : n <= 50 ? '21-50' : n <= 300 ? '51-300' : '300+']++;
      users.groupSizes = { largest: sizes.slice(0, 10), hist };
      log(`linked group sizes (90d wallets): largest ${sizes.slice(0, 10).join(', ')} · histogram ${JSON.stringify(hist)}`);
    }
    // Per-app wallets vs people, biggest apps first (names and counts only).
    const nameOf = new Map(apps.map((x) => [x.id.toLowerCase(), x.name.trim()]));
    const top = Object.entries(users.apps)
      .sort((x, y) => y[1].users30 - x[1].users30)
      .slice(0, 20)
      .map(([id, u]) => `${nameOf.get(id) ?? id.slice(0, 10)} ${u.users30}→${u.people30} (−${u.users30 ? Math.round((1 - u.people30 / u.users30) * 100) : 0}%)`);
    log(`wallets→people, 30d: ${top.join(' · ')}`);
    log(`users (excl. own team + endorsers): ecosystem 30d ${users.ecosystem.users30} wallets / ${users.ecosystem.people30} people, 90d ${users.ecosystem.users90} / ${users.ecosystem.people90}`);
  }

  const summary = summarize({
    apps,
    endorsersOf,
    rewardsTo,
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
        users,
        prices: {
          method: 'Each transfer is valued at that UTC day’s B3TR price: the last trade of the day in the deepest B3TR–VVET pool on VeChain, times that day’s VET/USD close.',
          b3trVetPools: vetPools.map((p) => ({ pool: p, pair: `B3TR/${poolMeta[p].symbol}` })),
          vetUsdSource: vet.source || null,
          b3trUsd: priceSeries,
          vetUsd: Object.fromEntries(Object.entries(priceCache.vetUsd).filter(([d]) => d >= dayOf(fromTs)).sort()),
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
