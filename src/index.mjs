// Build data/summary.json from VeChain mainnet.
//
//   node src/index.mjs [--node https://mainnet.vechain.org] [--out site/data]
//
// Read-only. Caches (cache/*.json) remember which addresses are contracts,
// which pools hold B3TR, and what each transaction did, so a daily run only
// asks the node about what is new.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { decodeAbiParameters, decodeEventLog, decodeFunctionResult, encodeFunctionData, pad, parseAbiParameters } from 'viem';
import { ABI, GRANT_SOURCES, MAINNET, TOPIC, VBD_CONTRACTS } from './abi.mjs';
import { classifyInflow, classifyOutflow, poolHoldsB3tr, receiptPoolEvents } from './classify.mjs';
import { pickCurrentRound, summarize } from './aggregate.mjs';
import { createThor, mapLimit } from './thor.mjs';
import { emptyPayouts, foldPayouts, reviewedNetworkStats, userStats, WINDOW_DAYS } from './users.mjs';
import { currentLinks, decodePassportLog, personOfFactory } from './people.mjs';
import { BUSY_CAP, busyLimit, earliestFunding, funderConfirmed, funderEvidence, funderLinks } from './funders.mjs';
import { flowOf, forwardLinks } from './forwards.mjs';
import { APP_PAYMENT_WALLETS, CONFIRMED_TEAM_WALLETS, KNOWN_SERVICE_WALLETS, priceLikeCollectors } from './services.mjs';
import { MIN_B3TR as PASS_MIN, traceLots } from './passthrough.mjs';
import { REVIEWED_LINKS, reviewedPairs } from './reviewed.mjs';
import { depositExchange, EXCHANGE_SOURCE, EXCHANGE_WALLETS, exchangeTotals } from './exchanges.mjs';
const SERVICE_HUB_TX = 1000;
// Second-generation linking (Morb's review, 2026-11-21): a shared funder
// needs a second sign, and collector networks are followed 1–2 hops. Off
// Public since 2026-11-21 (Vinny: "go", after the audit matched Morb on 5 of
// 6 funder groups); LINKS_V2_PUBLIC=0 shows the old rules for comparison.
const LINKS_V2_PUBLIC = process.env.LINKS_V2_PUBLIC !== '0';
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
  // Extra wallets a team uses, confirmed by name (services.mjs).
  for (const c of CONFIRMED_TEAM_WALLETS) {
    const ws = appWallets.get(c.appId.toLowerCase()) ?? appWallets.get(c.appId);
    if (!ws) continue;
    ws.add(c.wallet.toLowerCase());
    walletSet.add(c.wallet.toLowerCase());
  }
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

  // One wallet's B3TR in and out, every transfer labelled (classify.mjs).
  async function scanWallet(w, own) {
    const out = await thor.logs(
      [{ address: MAINNET.b3tr, topic0: TOPIC.transfer, topic1: pad(w, { size: 32 }) }],
      0,
      best.number,
    );
    const balance = (await read(MAINNET.b3tr, 'balanceOf', [w])) ?? 0n;
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
      return { from: e.from.toLowerCase(), value: e.value, at: l.meta.blockTimestamp };
    });
    const senders = [...new Set(inDecoded.map((d) => d.from))].filter((f) => !own.has(f) && !VBD_CONTRACTS[f]);
    await mapLimit(senders, 10, (f) => isContract(f));
    await mapLimit(senders.filter((f) => contracts[f]), 8, (f) => holdsB3tr(f));
    const inflows = inDecoded.map((d) => ({
      from: d.from,
      value: d.value,
      at: d.at,
      kind: classifyInflow({ from: d.from, ownWallets: own, vbdContracts: VBD_CONTRACTS, isContract: Boolean(contracts[d.from]), isB3trPool: Boolean(pools[d.from]) }),
    }));
    return { balance, outflows, inflows, transfersOut: out.length };
  }

  const wallets = {};
  const walletList = [...walletSet];
  await mapLimit(walletList, 4, async (w, i) => {
    const r = await scanWallet(w, groupOf.get(w) ?? new Set([w]));
    wallets[w] = { balance: r.balance, outflows: r.outflows, inflows: r.inflows };
    log(`wallet ${i + 1}/${walletList.length} ${w}: ${r.transfersOut} transfers out`);
  });

  // ── Team money sold from another wallet (passthrough.mjs) ──
  // Followed hop by hop (Vinny 2026-11-25: "follow all the hops u can"): a
  // plain wallet that got ≥1,000 B3TR from a team and had (nearly) no other
  // income is a pass-through; what it swaps within 30 days of receiving it
  // counts as the team's sale (`via` = the wallet that swapped, `hop` = how
  // many wallets from the team), and what it moves on is followed further.
  // Busy wallets (exchanges, services) end the trail. Every wallet a team paid
  // directly is checked, for every app; deeper hops get a budget per app,
  // biggest amounts first. Logs give counts only.
  const allTeam = new Set([...walletSet, ...APP_PAYMENT_WALLETS.map((p) => p.wallet.toLowerCase())]);
  const lotCache = new Map();
  const LOT_DEEP = Number(process.env.LOT_DEEP_WALLETS ?? 150); // per app, past hop 1
  let appsTraced = 0;
  let lotFailed = 0;
  async function lotFlowsOf(w) {
    try {
      const n = await thor.countLogs({ address: MAINNET.b3tr, topic0: TOPIC.transfer, topic1: pad(w, { size: 32 }) }, 0, best.number, 1000);
      if (n >= 1000) return null;
      const r = await scanWallet(w, new Set([w]));
      return { outflows: r.outflows, inflows: r.inflows };
    } catch {
      lotFailed++; // next run
      return null;
    }
  }
  async function applyPassThrough(walletMap, groups, label) {
    let found = 0;
    let deepest = 0;
    let passCount = 0;
    let capped = 0;
    let moved = 0n;
    let usedOther = 0n;
    // Every app with a team transfer is traced; big ones first.
    const size = (g) => [...g].reduce((a, w) => a + (walletMap[w]?.outflows ?? []).reduce((x, f) => x + (f.kind === 'other_wallet' ? f.value : 0n), 0n), 0n);
    const sorted = groups.map((g) => [g, size(g)]).sort((a, b) => (b[1] > a[1] ? 1 : -1));
    for (const [g] of sorted) {
      const seeds = new Map();
      for (const w of g) {
        for (const f of walletMap[w]?.outflows ?? []) {
          if (f.kind !== 'other_wallet' || f.value < PASS_MIN || !f.to || f.at == null || allTeam.has(f.to)) continue;
          (seeds.get(f.to) ?? seeds.set(f.to, []).get(f.to)).push({ ref: { w, f }, value: f.value, at: f.at });
        }
      }
      if (!seeds.size) continue;
      const { sold, stats } = await traceLots({ seeds, flowsOf: lotFlowsOf, isTeam: (x) => g.has(x), isStop: (x) => allTeam.has(x), cache: lotCache, maxDeep: LOT_DEEP });
      appsTraced++;
      deepest = Math.max(deepest, stats.deepestHop);
      passCount += stats.passThrough;
      capped += stats.stoppedAtCap;
      moved += stats.moved;
      usedOther += stats.usedOther;
      for (const [{ w, f }, parts] of sold) {
        const list = walletMap[w].outflows;
        const at = list.indexOf(f);
        if (at < 0) continue;
        const soldFlows = parts.map((s) => ({ to: f.to, via: s.via, hop: s.hop, value: s.value, txId: s.txId, at: s.at, saleValue: s.saleValue, kind: 'sold' }));
        const rest = f.value - parts.reduce((a, s) => a + s.value, 0n);
        list.splice(at, 1, ...soldFlows, ...(rest > 0n ? [{ ...f, value: rest }] : []));
        found += soldFlows.length;
      }
    }
    log(`${label}: ${found} sales from other wallets found, ${passCount} pass-through wallets, deepest hop ${deepest}, ${Number(moved / 10n ** 18n)} B3TR moved on a hop, ${Number(usedOther / 10n ** 18n)} B3TR left the trail another way (VOT3, contracts, small sends), ${appsTraced} apps traced, ${lotCache.size} wallets checked so far${capped ? `, ${capped} deeper wallets not followed (budget)` : ''}${lotFailed ? `, ${lotFailed} lookups FAILED` : ''}`);
  }
  for (const c of CONFIRMED_TEAM_WALLETS) {
    const f = wallets[c.wallet.toLowerCase()];
    if (!f) continue;
    const by = {};
    for (const i of f.inflows) by[i.kind] = (by[i.kind] ?? 0n) + i.value;
    const fromPay = f.inflows.filter((i) => APP_PAYMENT_WALLETS.some((p) => p.wallet.toLowerCase() === i.from)).reduce((a, i) => a + i.value, 0n);
    const sold = f.outflows.filter((o) => o.kind === 'sold').reduce((a, o) => a + o.value, 0n);
    const b = (x) => Number(x / 10n ** 18n);
    log(`confirmed team wallet "${c.label}": received ${Object.entries(by).map(([k, v]) => `${k} ${b(v)}`).join(' · ')} (from payment wallets ${b(fromPay)}) · sold itself ${b(sold)}`);
  }
  const teamGroups = [...new Map([...appWallets.values()].map((ws) => [[...ws].sort().join(','), ws])).values()];
  await applyPassThrough(wallets, teamGroups, 'team pass-through');

  // ── App payment wallets (services.mjs): subscriptions etc. Not DAO money,
  //    so kept apart from the team totals, but what they sell is shown. ──
  const paymentWallets = {};
  await mapLimit(APP_PAYMENT_WALLETS, 2, async (p) => {
    const w = p.wallet.toLowerCase();
    const own = new Set([w, ...(appWallets.get(p.appId.toLowerCase()) ?? [])]);
    try {
      const r = await scanWallet(w, own);
      paymentWallets[w] = { balance: r.balance, outflows: r.outflows, inflows: r.inflows };
    } catch (e) {
      log(`payment wallet ${w}: FAILED ${e?.message ?? e}`);
    }
  });
  await applyPassThrough(
    paymentWallets,
    APP_PAYMENT_WALLETS.map((p) => new Set([p.wallet.toLowerCase(), ...(appWallets.get(p.appId.toLowerCase()) ?? [])])),
    'payment-wallet pass-through',
  );

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
  for (const [owner, flows] of [...Object.entries(wallets), ...Object.entries(paymentWallets)]) {
    // A sale made from another wallet (passthrough) paid that wallet.
    const byTx = new Map(); // `${txId}|${seller}` → flows
    for (const f of flows.outflows) if (f.kind === 'sold' && f.txId) {
      const k = `${f.txId}|${f.via ?? owner}`;
      byTx.set(k, [...(byTx.get(k) ?? []), f]);
    }
    await mapLimit([...byTx.keys()], 8, async (k) => {
      const [txId, w] = k.split('|');
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
    for (const [k, fs] of byTx) {
      const [txId, w] = k.split('|');
      const p = proceeds[`${txId}:${w}`];
      const vu = vetUsdAt(dayOf(fs[0].at));
      if (!p || p.unpriced || (!p.vet && !p.usdTokens) || (p.vet && vu == null)) continue;
      const usdTotal = p.vet * (vu ?? 0) + p.usdTokens;
      // Via a pass-through: the share of that wallet's swap this flow was.
      const sent = fs[0].saleValue ?? fs.reduce((a, f) => a + f.value, 0n);
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
  let linksV2 = null;
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
      // 'sweeps2': the audit added otherIn (transfers from non-reward
      // wallets), so the window is read again once.
      const cached = await loadCache('sweeps2');
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
        await saveCache('sweeps2', sc);
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
          await saveCache('sweeps2', sc);
          log(`sweeps: ${vl.length} VOT3 transfers read`);
        }
      }
      const teamWallets = new Set([...appWallets.values()].flatMap((ws) => [...ws].map((x) => x.toLowerCase())));
      const vbd = new Set(Object.keys(VBD_CONTRACTS).map((x) => x.toLowerCase()));
      const cands = candidateDestinations(sc, payoutCache, best.timestamp);
      await mapLimit(cands, 10, (d) => isContract(d));
      await saveCache('contracts', contracts);
      // Lifetime activity: VET, VTHO and B3TR transfers out over the whole
      // chain, each capped at 1,000 (node limit). Exchanges and services run
      // into the thousands; a farm's funder or collection wallet makes a few
      // hundred at most. Whole history, because old exchange hot wallets
      // (e.g. Binance 1) funded wallets years ago and are quiet now.
      const VTHO_ADDR = '0x0000000000000000000000000000456E65726779';
      const yearAgo = 0;
      const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);
      async function activityOut(a) {
        const [vet, vtho, b3tr] = await Promise.all([
          thor.countVetOut(a, yearAgo, best.number, BUSY_CAP),
          thor.countLogs({ address: VTHO_ADDR, topic0: TOPIC.transfer, topic1: pad(a) }, yearAgo, best.number, BUSY_CAP),
          thor.countLogs({ address: MAINNET.b3tr, topic0: TOPIC.transfer, topic1: pad(a) }, yearAgo, best.number, BUSY_CAP),
        ]);
        return vet + vtho + b3tr;
      }
      const ZERO_A = '0x' + '0'.repeat(40);
      const DEAD = '0x000000000000000000000000000000000000dead';
      const excluded = (a) => a === ZERO_A || a === DEAD || KNOWN_SERVICE_WALLETS.has(a) || teamWallets.has(a) || vbd.has(a) || GRANT_SOURCES.has(a) || Boolean(contracts[a]) || a === MAINNET.x2EarnRewardsPool.toLowerCase();
      // Shared wallets with service-level activity (audit: 'Thunder Legacy',
      // 42,932 transactions since 2018) are services, not collectors.
      const hubAct = await loadCache('hubactivity3'); // addr → { day, n }
      const week = Math.floor(best.timestamp / 86_400 / 7);
      const pre = sweepLinks(sc, payoutCache, best.timestamp, excluded);
      let hubErr = 0;
      await mapLimit(
        pre.groups.map((g) => g.dest).filter((d) => hubAct[d]?.day !== week),
        6,
        async (d) => {
          try {
            hubAct[d] = { day: week, n: await activityOut(d) };
          } catch {
            hubErr++;
          }
        },
      );
      await saveCache('hubactivity3', hubAct);
      const busyHub = (d) => hubAct[d]?.day === week && hubAct[d].n >= SERVICE_HUB_TX;
      if (hubErr) log(`sweeps: ${hubErr} shared-wallet activity lookups failed (kept as collectors)`);
      const sw = sweepLinks(sc, payoutCache, best.timestamp, (a) => excluded(a) || busyHub(a));
      log(`sweeps: ${pre.groups.filter((g) => busyHub(g.dest)).length} shared wallets dropped for service-level activity (${SERVICE_HUB_TX}+ transfers out, whole history)`);

      // Same funder (funders.mjs): each reward wallet's first VET / VTHO.
      // Never changes, so it's cached forever; up to 6,000 new wallets per
      // run, so the first few runs fill it in.
      let fund = null;
      let fund2 = null;
      let topAppOf = () => undefined;
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
        // Busy funders = exchanges / services (audit: Coinbase, Binance, MEXC,
        // Bitget hot wallets were the biggest "funders"). Lifetime VET and
        // VTHO transfers out (capped), re-checked weekly.
        const busy = await loadCache('busyfunders5'); // addr → { week, n }
        const today = Math.floor(best.timestamp / 86_400 / 7);
        let busyErr = 0;
        let firstErr = '';
        await mapLimit(
          funderCands.filter((f) => counts.get(f) >= 2 && busy[f]?.day !== today),
          6,
          async (f) => {
            try {
              busy[f] = { day: today, n: await activityOut(f) };
            } catch (e) {
              busyErr++;
              firstErr ||= String(e?.message ?? e).slice(0, 160);
              /* unknown: treated as busy below, so it can't link anyone */
            }
          },
        );
        await saveCache('busyfunders5', busy);
        if (busyErr) log(`funders: ${busyErr} activity lookups failed (treated as services); first error: ${firstErr}`);
        const isService = (f) => !(busy[f]?.day === today) || busy[f].n > busyLimit(counts.get(f) ?? 0);
        const fl = funderLinks(fc, [...recent], excluded, { isService });
        // v2: a shared funder needs a second sign (funders.mjs). First-funding
        // times for wallets in candidate groups ('fundtime', never changes).
        const ft = await loadCache('fundtime'); // wallet → unix ts | null
        const candW = [...fl.groups, ...fl.unconfirmed].flatMap((g) => g.wallets).filter((w) => !(w in ft));
        await mapLimit(candW.slice(0, 8000), 10, async (w) => {
          try {
            const [vet, vthoLog] = await Promise.all([
              thor.firstVetIn(w, best.number),
              thor.firstLog({ address: VTHO, topic0: TOPIC.transfer, topic2: '0x' + '0'.repeat(24) + w.slice(2) }, best.number),
            ]);
            const vtho = vthoLog ? { from: '0x' + vthoLog.topics[1].slice(26), block: vthoLog.meta.blockNumber, at: vthoLog.meta.blockTimestamp } : null;
            ft[w] = earliestFunding(vet, vtho)?.at ?? null;
          } catch {
            /* next run */
          }
        });
        await saveCache('fundtime', ft);
        const appTotals = new Map(); // wallet → Map(app → b3tr), 90 days
        for (const [at, ai, r, amt] of payoutCache.rows) {
          if (at < since) continue;
          const w = payoutCache.receivers[r];
          const m = appTotals.get(w) ?? appTotals.set(w, new Map()).get(w);
          m.set(ai, (m.get(ai) ?? 0) + amt);
        }
        topAppOf = (w) => {
          const m = appTotals.get(w);
          return m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : undefined;
        };
        const sentPair = new Map();
        for (const [at, f, d, amt] of sc.rows) if (at >= since) sentPair.set(`${sc.addrs[f]}|${sc.addrs[d]}`, (sentPair.get(`${sc.addrs[f]}|${sc.addrs[d]}`) ?? 0) + amt);
        const evidence = new Map();
        const confirm = (funder, ws) => {
          const ev = funderEvidence(ws, { fundedAt: (w) => ft[w] ?? undefined, topAppOf, sentBack: (w) => sentPair.get(`${w}|${funder}`) ?? 0 });
          evidence.set(funder, ev);
          return funderConfirmed(ev);
        };
        const fl2 = funderLinks(fc, [...recent], excluded, { isService, confirm });
        fund2 = {
          pairs: fl2.pairs,
          confirmedGroups: fl2.groups.length,
          confirmedWallets: fl2.groups.reduce((t, g) => t + g.wallets.length, 0),
          unconfirmedGroups: fl2.unconfirmed.length,
          evidence: [...evidence.entries()].map(([funder, ev]) => ({ funder, ...ev, topApp: payoutCache.apps[ev.topApp] ?? null, confirmed: funderConfirmed(ev) })),
        };
        log(`funders v2: ${fl2.groups.length} groups confirmed (${fl2.groups.reduce((t, g) => t + g.wallets.length, 0)} wallets), ${fl2.unconfirmed.length} shared funders without a second sign (${fl2.unconfirmed.reduce((t, g) => t + g.wallets.length, 0)} wallets) not linked`);
        const busyCount = funderCands.filter((f) => counts.get(f) >= 2 && isService(f)).length;
        log(`funders: ${busyCount} busy funders (exchanges/services) never link`);
        const known = [...recent].filter((w) => w in fc).length;
        fund = {
          checkedWallets: known,
          ofWallets: recent.size,
          caughtUp: known >= recent.size,
          groups: fl.groups.length,
          walletsInGroups: fl.groups.reduce((t, g) => t + g.wallets.length, 0),
          tooBig: fl.tooBig.length,
          pairs: fl.pairs,
          groupList: fl.groups,
        };
        if (LINKS_V2_PUBLIC && fund2) {
          fund.groups = fund2.confirmedGroups;
          fund.walletsInGroups = fund2.confirmedWallets;
          fund.unconfirmedGroups = fund2.unconfirmedGroups;
        }
        log(`funders: ${done} new wallets checked (${known} of ${recent.size}), ${fund.groups} groups, ${fund.walletsInGroups} wallets, ${fl.tooBig.length} service-sized funders skipped`);
      } catch (e) {
        log(`funders FAILED (skipped): ${e?.message ?? e}`);
      }
      // Days of transfer history read, out of the 90-day window (10 s blocks).
      const caughtUp = sc.lastBlock >= best.number;
      const coveredDays = Math.max(0, Math.min(90, Math.floor((sc.lastBlock - (best.number - 90 * 8640)) / 8640)));
      personOf = personOfFactory([...passportPairs, ...sw.pairs, ...(fund?.pairs ?? [])]);
      // ── v2: collector networks (forwards.mjs) + collectors' own funders ──
      let net = { pairs: [], links: [], funderGroups: [], nodes: 0 };
      try {
        const since90 = best.timestamp - 90 * 86_400;
        const fromBlock = Math.max(0, best.number - 90 * 8640);
        const flowCache = await loadCache('flows1'); // addr → { day, in, out: [[to, amt]], senders: [addr] }
        const today = Math.floor(best.timestamp / 86_400);
        const receivers = new Set(payoutCache.receivers);
        const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);
        const ZERO_ADDR = '0x' + '0'.repeat(40);
        async function transfersOf(a) {
          const crit = (token) => [
            { address: token, topic0: TOPIC.transfer, topic1: pad(a) },
            { address: token, topic0: TOPIC.transfer, topic2: pad(a) },
          ];
          const ls = await thor.logs([...crit(MAINNET.b3tr), ...crit(MAINNET.vot3)], fromBlock, best.number);
          return ls
            .map((l) => ({ from: '0x' + l.topics[1].slice(26), to: '0x' + l.topics[2].slice(26), amount: Number(BigInt(l.data) / 10n ** 15n) / 1000 }))
            .filter((t) => t.from !== ZERO_ADDR && t.to !== ZERO_ADDR);
        }
        const nodes = new Set(sw.groups.map((g) => g.dest));
        const flows = new Map();
        let frontier = [...nodes];
        let flowErr = 0;
        // Price-list wallets (many people paying the same round amount) are
        // shops, not the next wallet of one farmer.
        const priceList = new Set(priceLikeCollectors(sc, [...new Set(sc.addrs)], since90).map((p) => p.dest));
        const bad = (a) => excluded(a) || busyHub(a) || priceList.has(a);
        let fl = { pairs: [], links: [], skipped: [] };
        for (let hop = 0; hop <= 2 && frontier.length; hop++) {
          frontier = frontier.slice(0, 600);
          await mapLimit(frontier.filter((a) => flowCache[a]?.day !== today), 6, async (a) => {
            try {
              const ts = await transfersOf(a);
              const f = flowOf(a, ts);
              const senders = [...new Set(ts.filter((t) => t.to.toLowerCase() === a).map((t) => t.from.toLowerCase()))];
              flowCache[a] = { day: today, in: f.in, out: [...f.out.entries()], senders: senders.slice(0, 2000) };
            } catch {
              flowErr++;
            }
          });
          for (const a of frontier) {
            const c = flowCache[a];
            if (!c) continue;
            const outsiders = c.senders.filter((x) => !receivers.has(x) && !nodes.has(x)).length;
            flows.set(a, { in: c.in, out: new Map(c.out), sources: outsiders });
          }
          if (hop === 2) break;
          // Next hop: wallets these nodes forward a majority to. Check them
          // for contract code and service-level activity before following.
          const pre = forwardLinks(flows, excluded);
          const next = [...new Set(pre.links.map((l) => l.to))].filter((a) => !nodes.has(a));
          await mapLimit(next, 10, (a) => isContract(a));
          await mapLimit(next.filter((a) => !contracts[a] && hubAct[a]?.day !== week), 6, async (a) => {
            try {
              hubAct[a] = { day: week, n: await activityOut(a) };
            } catch {
              /* unknown: not followed */
            }
          });
          frontier = next.filter((a) => !bad(a) && hubAct[a]?.day === week);
          for (const a of frontier) nodes.add(a);
        }
        await saveCache('flows1', flowCache);
        await saveCache('hubactivity3', hubAct);
        await saveCache('contracts', contracts);
        // The next wallet's own outsiders count is only known once it's a node.
        fl = forwardLinks(flows, (a) => bad(a) || !(hubAct[a]?.day === week || nodes.has(a)));
        // Collectors' own first funders: two collectors funded by the same
        // plain, quiet wallet are one operator.
        const fc2 = await loadCache('funders');
        const todo = [...nodes].filter((a) => !(a in fc2));
        await mapLimit(todo, 10, async (a) => {
          try {
            const [vet, vthoLog] = await Promise.all([
              thor.firstVetIn(a, best.number),
              thor.firstLog({ address: '0x0000000000000000000000000000456E65726779', topic0: TOPIC.transfer, topic2: pad(a) }, best.number),
            ]);
            const vtho = vthoLog ? { from: ('0x' + vthoLog.topics[1].slice(26)).toLowerCase(), block: vthoLog.meta.blockNumber } : null;
            fc2[a] = earliestFunding(vet, vtho)?.from ?? null;
          } catch {
            /* next run */
          }
        });
        await saveCache('funders', fc2);
        const nCount = new Map();
        for (const a of nodes) if (fc2[a]) nCount.set(fc2[a], (nCount.get(fc2[a]) ?? 0) + 1);
        const nf = [...nCount.entries()].filter(([f, n]) => n >= 2 && !excluded(f)).map(([f]) => f);
        await mapLimit(nf, 10, (f) => isContract(f));
        await mapLimit(nf.filter((f) => !contracts[f] && hubAct[f]?.day !== week), 6, async (f) => {
          try {
            hubAct[f] = { day: week, n: await activityOut(f) };
          } catch {
            /* unknown: no link */
          }
        });
        await saveCache('hubactivity3', hubAct);
        const quiet = (f) => !excluded(f) && hubAct[f]?.day === week && hubAct[f].n <= busyLimit(nCount.get(f));
        const cf = funderLinks(fc2, [...nodes], (f) => !quiet(f), { maxFunded: 50 });
        net = { pairs: [...fl.pairs, ...cf.pairs], links: fl.links, funderGroups: cf.groups, nodes: nodes.size, skipped: fl.skipped.length };
        log(`networks v2: ${nodes.size} collector-network wallets, ${fl.links.length} forwarding links (${fl.skipped.length} to services skipped), ${cf.groups.length} shared collector funders${flowErr ? `, ${flowErr} lookups failed` : ''}`);
      } catch (e) {
        log(`networks v2 FAILED (skipped): ${e?.message ?? e}`);
      }
      const personOfV1 = personOf;
      const personOfV2 = personOfFactory([...passportPairs, ...sw.pairs, ...(fund2?.pairs ?? fund?.pairs ?? []), ...net.pairs, ...reviewedPairs()]);
      if (LINKS_V2_PUBLIC) personOf = personOfV2;
      linksV2 = { personOfV1, personOfV2 };
      const priceLike = priceLikeCollectors(sc, sw.groups.map((g) => g.dest), best.timestamp - 90 * 86_400);
      log(`price-list collectors to review (not excluded automatically): ${priceLike.length}`);
      // For scripts/audit.mjs only. The Actions cache is private to this
      // repo's workflows; the audit encrypts anything with addresses.
      await saveCache('auditgroups', {
        sweeps: sw.groups,
        funders: fund?.groupList ?? [],
        passport: passportPairs,
        v2: { funderEvidence: fund2?.evidence ?? [], funderPairs: fund2?.pairs ?? [], forwards: net.links, collectorFunders: net.funderGroups, priceLike, public: LINKS_V2_PUBLIC },
      });
      // What the biggest merged groups are made of (counts only): one huge
      // sweep hub is strong evidence of a farm; a long chain of small hubs
      // would be weaker.
      {
        const hubInfo = new Map(); // group → { sweepHubs, funderHubs, passport, biggestHub }
        const bump = (g, k, n = 1) => {
          const x = hubInfo.get(g) ?? { sweepHubs: 0, funderHubs: 0, passport: 0, biggestSweepHub: 0, biggestFunderHub: 0 };
          x[k] = k.startsWith('biggest') ? Math.max(x[k], n) : x[k] + n;
          hubInfo.set(g, x);
        };
        for (const g of sw.groups) {
          const p = personOf(g.dest);
          bump(p, 'sweepHubs');
          bump(p, 'biggestSweepHub', g.wallets.length);
        }
        for (const g of fund?.groupList ?? []) {
          const p = personOf(g.funder);
          bump(p, 'funderHubs');
          bump(p, 'biggestFunderHub', g.wallets.length);
        }
        for (const [a] of passportPairs) bump(personOf(a), 'passport');
        const since90 = best.timestamp - 90 * 86_400;
        const size = new Map();
        const seen = new Set();
        for (const [at, , r] of payoutCache.rows) {
          if (at < since90 || seen.has(r)) continue;
          seen.add(r);
          const p = personOf(payoutCache.receivers[r]);
          size.set(p, (size.get(p) ?? 0) + 1);
        }
        const top = [...size.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8);
        for (const [p, n] of top) log(`group of ${n} reward wallets: ${JSON.stringify(hubInfo.get(p) ?? {})}`);
      }
      sweepInfo = {
        coveredDays,
        caughtUp,
        groups: sw.groups.length,
        walletsInGroups: sw.groups.reduce((t, g) => t + g.wallets.length, 0),
        // Counts only: no addresses in the public file (nobody is named a
        // farm without a person looking first).
        largestGroup: sw.groups[0]?.wallets.length ?? 0,
        tooBig: sw.tooBig.length,
        funders: fund ? { ...fund, pairs: undefined, groupList: undefined } : null,
        networks: LINKS_V2_PUBLIC ? { forwardingLinks: net.links.length, wallets: net.nodes } : null,
        reviewedLinks: LINKS_V2_PUBLIC ? REVIEWED_LINKS.length : 0,
      };
      sweepInfo.linksSkippedByCap = personOf.skipped ?? 0;
      log(`links skipped by the 5,000-address group cap: ${sweepInfo.linksSkippedByCap}`);
      log(`sweeps: ${sw.services.length} shared wallets treated as public services (paymasters, shops, sponsors)`);
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
    await saveCache('excludeof', Object.fromEntries(Object.entries(excludeOf).map(([k, v]) => [k, [...v]])));
    users = userStats(payoutCache, best.timestamp, excludeOf, personOf);
    users.sweeps = sweepInfo;
    {
      const nw = Object.entries(users.apps)
        .filter(([, x]) => x.newWallets)
        .map(([id, x]) => [apps.find((a) => a.id === id)?.name ?? id.slice(0, 10), x.newWallets])
        .sort((a, b) => b[1].perWeek[0] - a[1].perWeek[0])
        .slice(0, 8);
      log(`new wallets per week (newest first; no reward from any app in ${users.newWallets?.lookbackDays ?? '?'} days before): ${nw.map(([n, x]) => `${n} ${x.perWeek.join('/')} (linked ${x.linked7})`).join(' · ') || 'n/a'}`);
    }
    // Hand-reviewed networks: what they were paid, and how they voted, so the
    // page proves it from the data alone (Vinny, 2026-11-21).
    if (personOf && LINKS_V2_PUBLIC && REVIEWED_LINKS.length) {
      try {
        const nets = reviewedNetworkStats(payoutCache, best.timestamp, personOf, REVIEWED_LINKS);
        const fromBlock = Math.max(0, best.number - 90 * 8640);
        const voteParams = parseAbiParameters('bytes32[] appsIds, uint256[] voteWeights');
        for (const n of nets) {
          const voters = [...new Set([...n.members, ...n.wallets.map((w) => w.toLowerCase())])];
          const byApp = new Map();
          const rounds = new Set();
          const voted = new Set();
          let failed = 0;
          await mapLimit(voters, 6, async (v) => {
            try {
              const ls = await thor.logs([{ address: MAINNET.xAllocationVoting, topic0: TOPIC.allocationVoteCast, topic1: '0x' + '0'.repeat(24) + v.slice(2) }], fromBlock, best.number);
              for (const l of ls) {
                const [ids, ws] = decodeAbiParameters(voteParams, l.data);
                voted.add(v);
                rounds.add(Number(BigInt(l.topics[2])));
                ids.forEach((id, i) => byApp.set(id.toLowerCase(), (byApp.get(id.toLowerCase()) ?? 0) + Number(ws[i] / 10n ** 15n) / 1000));
              }
            } catch {
              failed++;
            }
          });
          n.votes90 = {
            voters: voted.size,
            rounds: [...rounds].sort((a, b) => a - b),
            vot3ByApp: Object.fromEntries([...byApp.entries()].sort((a, b) => b[1] - a[1]).map(([k, w]) => [k, Math.round(w)])),
            ...(failed ? { lookupsFailed: failed } : {}),
          };
        }
        users.reviewedNetworks = nets;
        log(`reviewed networks: ${nets.map((n) => `${n.rewardWallets90} wallets, ${n.b3tr90} B3TR, ${n.votes90.voters} voters`).join(' · ')}`);
      } catch (e) {
        log(`reviewed networks FAILED (skipped): ${e?.message ?? e}`);
      }
    }
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
    if (linksV2) {
      // The other rule set, for comparison (counts only).
      const other = userStats(payoutCache, best.timestamp, excludeOf, LINKS_V2_PUBLIC ? linksV2.personOfV1 : linksV2.personOfV2);
      const label = LINKS_V2_PUBLIC ? 'v1 (old rules)' : 'v2 (not public yet)';
      const top2 = Object.entries(other.apps)
        .sort((x, y) => y[1].users30 - x[1].users30)
        .slice(0, 20)
        .map(([id, u]) => `${nameOf.get(id) ?? id.slice(0, 10)} ${u.users30}→${u.people30} (−${u.users30 ? Math.round((1 - u.people30 / u.users30) * 100) : 0}%)`);
      log(`wallets→people ${label}, 30d: ${top2.join(' · ')}`);
      log(`${label}: ecosystem 30d ${other.ecosystem.users30} wallets / ${other.ecosystem.people30} people, 90d ${other.ecosystem.users90} / ${other.ecosystem.people90}`);
    }
    log(`users (excl. own team + endorsers): ecosystem 30d ${users.ecosystem.users30} wallets / ${users.ecosystem.people30} people, 90d ${users.ecosystem.users90} / ${users.ecosystem.people90}`);
  }

  // Payment wallets per app (services.mjs), valued like team sales.
  const paymentByApp = {};
  for (const p of APP_PAYMENT_WALLETS) {
    const w = p.wallet.toLowerCase();
    const f = paymentWallets[w];
    if (!f) continue;
    const toUsd = (x) => {
      if (typeof x.usd === 'number') return x.usd;
      const pr = priceAt(x.at);
      return pr == null ? 0 : (Number(x.value / 10n ** 12n) / 1e6) * pr;
    };
    const sold = f.outflows.filter((x) => x.kind === 'sold');
    const other = f.outflows.filter((x) => x.kind === 'other_wallet' || x.kind === 'other_contract');
    const received = f.inflows.filter((x) => x.kind !== 'internal').reduce((a, x) => a + x.value, 0n);
    (paymentByApp[p.appId.toLowerCase()] ??= []).push({
      wallet: w,
      label: p.label,
      confirmedBy: p.confirmedBy,
      received: received.toString(),
      sold: sold.reduce((a, x) => a + x.value, 0n).toString(),
      soldUsd: Math.round(sold.reduce((a, x) => a + toUsd(x), 0)),
      toOtherWallets: other.reduce((a, x) => a + x.value, 0n).toString(),
      balanceNow: f.balance.toString(),
      sales: sold
        .slice()
        .sort((x, y) => y.at - x.at)
        .slice(0, 10)
        .map((x) => ({ txId: x.txId, at: x.at, amount: x.value.toString(), ...(x.via ? { via: x.via } : {}) })),
    });
  }
  log(`payment wallets: ${Object.values(paymentByApp).flat().map((p) => `${p.label} sold ${Number(BigInt(p.sold) / 10n ** 18n)} B3TR`).join(' · ') || 'none'}`);

  // ── Team money sent to exchanges (exchanges.mjs) ──
  // B3TR: the team / payment wallets' plain-wallet outflows (after pass-through
  // sales were split out). VET: every VET transfer out of those wallets
  // (mostly sale proceeds). Deposit addresses are cached; one checked as "not a
  // deposit" is checked again after a week.
  const exchangeByApp = {};
  try {
    const NODE = process.env.VECHAIN_NODE || 'https://mainnet.vechain.org';
    const postJ = (path, body) => fetch(NODE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const vetTransfers = async (criteria, cap) => {
      const out = [];
      for (let offset = 0; offset < cap; offset += 1000) {
        const r = await postJ('/logs/transfer', { range: { unit: 'block', from: 0, to: best.number }, options: { offset, limit: 1000 }, criteriaSet: [criteria], order: 'asc' });
        if (!Array.isArray(r)) throw new Error('transfer logs failed');
        out.push(...r);
        if (r.length < 1000) break;
      }
      return out;
    };
    const appOfWallet = new Map();
    for (const [id, ws] of appWallets) for (const w of ws) if (!appOfWallet.has(w)) appOfWallet.set(w, id);
    for (const p of APP_PAYMENT_WALLETS) appOfWallet.set(p.wallet.toLowerCase(), p.appId.toLowerCase());
    const flows = [];
    for (const [owner, f] of [...Object.entries(wallets), ...Object.entries(paymentWallets)]) {
      const app = appOfWallet.get(owner);
      if (!app) continue;
      for (const o of f.outflows) if (o.kind === 'other_wallet' && o.to && !walletSet.has(o.to)) flows.push({ app, token: 'B3TR', to: o.to, value: Number(o.value / 10n ** 15n) / 1000, at: o.at });
    }
    let vetWallets = 0;
    await mapLimit([...appOfWallet.keys()], 4, async (w) => {
      const xs = await vetTransfers({ sender: w }, 30_000);
      vetWallets++;
      for (const x of xs) {
        const to = String(x.recipient).toLowerCase();
        if (walletSet.has(to)) continue;
        flows.push({ app: appOfWallet.get(w), token: 'VET', to, value: Number(BigInt(x.amount) / 10n ** 15n) / 1000, at: x.meta.blockTimestamp });
      }
    });
    const depCache = await loadCache('deposits'); // `${token}|${addr}` → { ex, at, v }
    // A new exchange on the list means every "not a deposit" answer is stale.
    const exListVersion = [...EXCHANGE_WALLETS.keys()].sort().join(',').length + ':' + EXCHANGE_WALLETS.size;
    const totalTo = new Map();
    for (const f of flows) totalTo.set(`${f.token}|${f.to}`, (totalTo.get(`${f.token}|${f.to}`) ?? 0) + f.value);
    let checked = 0;
    const classify = async (token, to) => {
      const k = `${token}|${to}`;
      const c = depCache[k];
      if (c && c.v === exListVersion && (c.ex || c.at > best.timestamp - 7 * 86_400)) return c.ex;
      if ((totalTo.get(k) ?? 0) < (token === 'VET' ? 1000 : 100)) return null; // dust: not worth a lookup
      if (await isContract(to)) return (depCache[k] = { ex: null, at: best.timestamp, v: exListVersion }).ex;
      checked++;
      const outs =
        token === 'VET'
          ? (await vetTransfers({ sender: to }, 5000)).map((x) => ({ to: String(x.recipient).toLowerCase(), value: Number(BigInt(x.amount) / 10n ** 15n) / 1000 }))
          : (await thor.logs([{ address: MAINNET.b3tr, topic0: TOPIC.transfer, topic1: pad(to, { size: 32 }) }], 0, best.number)).map((l) => ({ to: ('0x' + l.topics[2].slice(26)).toLowerCase(), value: Number(BigInt(l.data) / 10n ** 15n) / 1000 }));
      depCache[k] = { ex: depositExchange(outs), at: best.timestamp, v: exListVersion };
      return depCache[k].ex;
    };
    const totals = await exchangeTotals(flows, classify, (token, ts) => (token === 'VET' ? vetUsdAt(dayOf(ts)) : priceAt(ts)));
    await saveCache('deposits', depCache);
    for (const [app, t] of Object.entries(totals)) exchangeByApp[app] = t;
    const top = Object.entries(totals)
      .map(([id, t]) => [apps.find((a) => a.id === id)?.name ?? id.slice(0, 10), (t.B3TR?.usd ?? 0) + (t.VET?.usd ?? 0)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    log(`exchanges: ${flows.length} team transfers (${vetWallets} wallets' VET), ${checked} deposit addresses checked; to exchanges, $ at the time: ${top.map(([n, u]) => `${n} $${Math.round(u)}`).join(' · ')}`);
  } catch (e) {
    log(`exchanges: FAILED ${e.message} (left out this run)`);
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
    extraWallets: CONFIRMED_TEAM_WALLETS,
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
        paymentWallets: paymentByApp,
        exchanges: { source: EXCHANGE_SOURCE, wallets: Object.fromEntries(EXCHANGE_WALLETS), byApp: exchangeByApp },
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
