// Turn decoded events into the per-app summary the page shows. Pure.
// Amounts are BigInt wei here and decimal strings in the output JSON.

import { IN_KINDS, KINDS } from './classify.mjs';

const ZERO = 0n;
const sum = (xs) => xs.reduce((a, b) => a + b, ZERO);

/** Percent with one decimal, or null when the denominator is zero. */
export function pct(part, whole) {
  if (!whole || whole === ZERO) return null;
  return Number((part * 1000n) / whole) / 10;
}

/**
 * @param {object} input
 * @param {{id:string,name:string,active:boolean,teamWallet:string,teamAllocationPercentage:number|null}[]} input.apps
 * @param {{appId:string,round:number,total:bigint,toTeam:bigint,toPool:bigint,unallocated:bigint,recipient:string}[]} input.claims
 * @param {{appId:string,amount:bigint,depositor:string}[]} input.deposits
 * @param {{appId:string,amount:bigint,teamWallet:string,reason:string}[]} input.withdrawals
 * @param {Record<string,bigint>} input.poolBalances appId → totalBalance now
 * @param {Record<string,{balance:bigint,outflows:{to:string,value:bigint,kind:string}[]}>} input.wallets lower-case wallet → flows
 * @param {string} input.xAllocationPool
 */
export function summarize({ apps, claims, deposits, withdrawals, poolBalances, wallets, xAllocationPool, grantsTo = {}, priceAt = () => null }) {
  const xap = xAllocationPool.toLowerCase();
  // Dollars at the time: each amount × the B3TR price on the day it moved.
  const usd = (wei, ts) => {
    const p = priceAt(ts);
    return p == null ? null : (Number(wei / 10n ** 12n) / 1e6) * p;
  };
  const dollars = (items) => {
    let total = 0;
    let unpriced = ZERO;
    for (const [wei, ts] of items) {
      const v = usd(wei, ts);
      if (v == null) unpriced += wei;
      else total += v;
    }
    return { total: Math.round(total), unpriced };
  };

  // Every wallet that ever received an app's team share, plus the current one.
  const walletsOf = new Map();
  for (const a of apps) walletsOf.set(a.id, new Set([a.teamWallet.toLowerCase()]));
  for (const c of claims) walletsOf.get(c.appId)?.add(c.recipient.toLowerCase());
  // A withdrawal can go to a wallet that never received a claim.
  for (const w of withdrawals) walletsOf.get(w.appId)?.add(w.teamWallet.toLowerCase());

  // Which apps share a wallet — their wallet flows cannot be split per app.
  const appsOfWallet = new Map();
  for (const [appId, ws] of walletsOf) for (const w of ws) {
    if (!appsOfWallet.has(w)) appsOfWallet.set(w, new Set());
    appsOfWallet.get(w).add(appId);
  }

  // What VeBetterDAO paid into each app's team wallet(s): its team share plus
  // what it withdrew from its rewards pool.
  const receivedOf = new Map(apps.map((a) => [a.id, ZERO]));
  for (const c of claims) if (receivedOf.has(c.appId)) receivedOf.set(c.appId, receivedOf.get(c.appId) + c.toTeam);
  for (const w of withdrawals) if (receivedOf.has(w.appId)) receivedOf.set(w.appId, receivedOf.get(w.appId) + w.amount);

  // "Current" = the newest round that's been (nearly) fully claimed. Right
  // after a round ends, apps claim one by one; showing a half-claimed round as
  // "current" would make allocations look like they collapsed.
  const currentRound = pickCurrentRound(claims);

  // Round boundaries for timing withdrawals: the first claim of round N is
  // made just after round N ends. A withdrawal is counted in the first round
  // whose boundary is at or after it (rounds are a week; this is approximate
  // to a few hours and only used for the per-round view).
  const boundary = new Map();
  for (const c of claims) if (c.at != null) boundary.set(c.round, Math.min(boundary.get(c.round) ?? Infinity, c.at));
  const bounds = [...boundary.entries()].sort((a, b) => a[0] - b[0]);
  const roundOfTime = (t) => {
    if (t == null) return null;
    for (const [r, at] of bounds) if (t <= at) return r;
    return (bounds.at(-1)?.[0] ?? 0) + 1; // after the last claimed round: the round in progress
  };

  const out = apps.map((app) => {
    const myClaims = claims.filter((c) => c.appId === app.id).sort((a, b) => a.round - b.round);
    const myDeposits = deposits.filter((d) => d.appId === app.id);
    const myWithdrawals = withdrawals.filter((w) => w.appId === app.id);

    const allocation = {
      total: sum(myClaims.map((c) => c.total)),
      toTeam: sum(myClaims.map((c) => c.toTeam)),
      toRewardsPool: sum(myClaims.map((c) => c.toPool)),
      unallocated: sum(myClaims.map((c) => c.unallocated)),
    };

    const depositsTotal = sum(myDeposits.map((d) => d.amount));
    const depositsFromAllocation = sum(myDeposits.filter((d) => d.depositor.toLowerCase() === xap).map((d) => d.amount));
    const withdrawnByTeam = sum(myWithdrawals.map((w) => w.amount));
    const balanceNow = poolBalances[app.id] ?? ZERO;
    // B3TR leaves the X2EarnRewardsPool only by distributeReward (to users) or
    // withdraw (to the team). So whatever went in and was not withdrawn and is
    // not still there was paid to users. Exact, without reading every payout.
    const paidToUsers = depositsTotal - withdrawnByTeam - balanceNow;

    const myWallets = [...(walletsOf.get(app.id) ?? [])];
    const sharedWith = new Set();
    for (const w of myWallets) for (const other of appsOfWallet.get(w) ?? []) if (other !== app.id) sharedWith.add(other);

    const sent = Object.fromEntries(KINDS.map((k) => [k, ZERO]));
    const received = Object.fromEntries(IN_KINDS.map((k) => [k, ZERO]));
    const recipients = new Map();
    const senders = new Map();
    const sales = [];
    let walletBalance = ZERO;
    for (const w of myWallets) {
      const flows = wallets[w];
      if (!flows) continue;
      walletBalance += flows.balance;
      for (const f of flows.inflows ?? []) {
        received[f.kind] = (received[f.kind] ?? ZERO) + f.value;
        if (f.kind === 'internal') continue;
        const key = f.from.toLowerCase();
        const s = senders.get(key) ?? { address: key, kind: f.kind, amount: ZERO, count: 0 };
        s.amount += f.value;
        s.count += 1;
        senders.set(key, s);
      }
      for (const f of flows.outflows) {
        sent[f.kind] = (sent[f.kind] ?? ZERO) + f.value;
        if (f.kind === 'sold' && f.txId) sales.push(f);
        if (f.kind === 'internal') continue;
        const key = f.to.toLowerCase();
        const r = recipients.get(key) ?? { address: key, kind: f.kind, amount: ZERO, count: 0 };
        r.amount += f.value;
        r.count += 1;
        recipients.set(key, r);
      }
    }
    const receivedFromVbd = allocation.toTeam + withdrawnByTeam;
    // A shared wallet's outflows belong to the whole group, so the sold
    // percentage has to be measured against the whole group's receipts —
    // otherwise one app carries every app's sales (it read 236% in testing).
    const groupReceived = receivedFromVbd + sum([...sharedWith].map((id) => receivedOf.get(id) ?? ZERO));
    // EVERYTHING that came into the wallet(s) from outside — allocation,
    // withdrawals, grants/DAO, purchases, transfers. B3TR is interchangeable,
    // so a sale can't be pinned to one source; it's measured against all of
    // it, and the grants line is shown beside it (B3TR Beach's 605k was a grant).
    const receivedExternal = sum(Object.entries(received).filter(([k]) => k !== 'internal').map(([, v]) => v));

    // Grants: direct (B3TR from a grant source; VOT3 grants count as far as
    // the wallet converted VOT3 back to B3TR) plus ONE hop — a wallet that got
    // a grant and forwarded B3TR here. Counted up to the smaller of what it
    // got as a grant and what it forwarded; it's labelled "via" so readers can
    // check the address themselves.
    const directVot3 = sum(myWallets.map((w) => grantsTo[w]?.vot3 ?? ZERO));
    const grantsDirect = received.grants_dao + (directVot3 < received.from_vot3 ? directVot3 : received.from_vot3);
    const via = [...senders.values()]
      .filter((s) => (s.kind === 'other_wallet' || s.kind === 'other_contract') && grantsTo[s.address])
      .map((s) => {
        const g = grantsTo[s.address].b3tr + grantsTo[s.address].vot3;
        return { address: s.address, forwarded: s.amount, grantReceived: g, counted: g < s.amount ? g : s.amount };
      })
      .filter((v) => v.counted > ZERO)
      .sort((a, b) => (b.counted > a.counted ? 1 : -1));
    const grantsTotal = grantsDirect + sum(via.map((v) => v.counted));

    // ── Value at the time (USD) ──
    const allocUsd = dollars(myClaims.map((c) => [c.total, c.at]));
    const shareUsd = dollars(myClaims.map((c) => [c.toTeam, c.at]));
    const withdrawnUsd = dollars(myWithdrawals.map((w) => [w.amount, w.at]));
    const putBackUsd = dollars(myDeposits.filter((d) => d.depositor.toLowerCase() !== xap).map((d) => [d.amount, d.at]));
    const outs = myWallets.flatMap((w) => wallets[w]?.outflows ?? []);
    const soldUsd = dollars(outs.filter((f) => f.kind === 'sold').map((f) => [f.value, f.at]));
    const otherUsd = dollars(outs.filter((f) => f.kind === 'other_wallet' || f.kind === 'other_contract').map((f) => [f.value, f.at]));
    const valueUsd = {
      allocation: allocUsd.total,
      takenGross: shareUsd.total + withdrawnUsd.total,
      putBack: putBackUsd.total,
      takenNet: shareUsd.total + withdrawnUsd.total - putBackUsd.total,
      sold: soldUsd.total,
      toOtherWallets: otherUsd.total,
      /** B3TR moved on days with no known price (before pools traded). */
      unpricedB3tr: [allocUsd, withdrawnUsd, soldUsd, otherUsd].reduce((a, x) => a + x.unpriced, ZERO).toString(),
    };

    return {
      id: app.id,
      name: app.name,
      valueUsd,
      active: app.active,
      teamAllocationPercentage: app.teamAllocationPercentage,
      teamWallets: myWallets,
      currentTeamWallet: app.teamWallet.toLowerCase(),
      sharedWalletWith: [...sharedWith],
      rounds: myClaims.length,
      firstRound: myClaims[0]?.round ?? null,
      lastRound: myClaims.at(-1)?.round ?? null,
      perRound: (() => {
        const wd = new Map();
        for (const w of myWithdrawals) {
          const r = roundOfTime(w.at);
          if (r != null) wd.set(r, (wd.get(r) ?? ZERO) + w.amount);
        }
        const rounds = [...new Set([...myClaims.map((c) => c.round), ...wd.keys()])].sort((a, b) => a - b);
        const byRound = new Map(myClaims.map((c) => [c.round, c]));
        return rounds.map((r) => ({
          round: r,
          total: (byRound.get(r)?.total ?? ZERO).toString(),
          withdrawn: (wd.get(r) ?? ZERO).toString(),
        }));
      })(),
      current: (() => {
        const c = myClaims.find((x) => x.round === currentRound);
        return c ? { round: c.round, total: c.total.toString(), toTeam: c.toTeam.toString(), toRewardsPool: c.toPool.toString() } : null;
      })(),
      allocation: str(allocation),
      rewardsPool: str({
        deposits: depositsTotal,
        depositsFromAllocation,
        depositsByTeam: depositsTotal - depositsFromAllocation,
        withdrawnByTeam,
        balanceNow,
        paidToUsers,
      }),
      teamWallet: {
        receivedFromVeBetterDAO: receivedFromVbd.toString(),
        // Equal to the above unless the wallet is shared; then it covers every app sharing it.
        receivedByWalletGroup: groupReceived.toString(),
        /** Every B3TR transfer INTO the wallet(s), by where it came from. */
        received: str(received),
        receivedExternal: receivedExternal.toString(),
        grants: {
          direct: grantsDirect.toString(),
          via: via.slice(0, 5).map((v) => str(v)),
          total: grantsTotal.toString(),
          /** Sent back to the Treasury / GrantsManager / Timelock / multisig. */
          returnedToDao: sent.to_dao.toString(),
        },
        /** The largest proven sales, with their transactions, for anyone to check. */
        largestSales: sales
          .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
          .slice(0, 5)
          .map((f) => ({ txId: f.txId, at: f.at ?? null, amount: f.value.toString() })),
        topSenders: [...senders.values()]
          .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
          .slice(0, 10)
          .map((s) => ({ ...s, amount: s.amount.toString() })),
        balanceNow: walletBalance.toString(),
        sent: str(sent),
        topRecipients: [...recipients.values()]
          .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
          .slice(0, 10)
          .map((r) => ({ ...r, amount: r.amount.toString() })),
      },
      ratios: {
        paidToUsersPctOfAllocation: pct(paidToUsers, allocation.total),
        // Sold as a share of ALL B3TR the wallet received (falls back to the
        // VeBetterDAO receipts when inflows weren't read).
        soldPctOfTeamReceipts: pct(sent.sold, receivedExternal > ZERO ? receivedExternal : groupReceived),
        grantsShareOfReceiptsPct: pct(grantsTotal, receivedExternal),
        teamSharePct: pct(allocation.toTeam, allocation.total),
        // What the team actually took, NET: the official split plus pool
        // withdrawals, minus what the team put back into its pool. On mainnet
        // almost every app's split is 0% and teams take B3TR by withdrawing.
        // Net, because teams recycle (withdraw, then top the pool up again):
        // gross withdrawals counted that B3TR twice — once as taken, once as
        // paid — and paid% + taken% went over 100% (Vinny, 2026-11-16).
        // With the net figure, every app adds up exactly:
        //   paid + taken (net) + still in pool = allocation   (100%)
        // Net can be negative: the team added more than it took.
        takenByTeamPct: pct(receivedFromVbd - (depositsTotal - depositsFromAllocation), allocation.total),
        takenByTeamGrossPct: pct(receivedFromVbd, allocation.total),
        putBackByTeamPct: pct(depositsTotal - depositsFromAllocation, allocation.total),
        stillInPoolPct: pct(balanceNow, allocation.total),
      },
    };
  });

  // The newest round anyone has claimed, and what apps got in it: all-time
  // totals hide emission cuts, the latest round shows them.
  const latestRound = claims.reduce((m, c) => Math.max(m, c.round), 0);
  const inCurrent = claims.filter((c) => c.round === currentRound);
  const totals = str({
    latestRound: BigInt(latestRound),
    latestRoundToApps: sum(claims.filter((c) => c.round === latestRound).map((c) => c.total)),
    currentRound: BigInt(currentRound),
    currentRoundToApps: sum(inCurrent.map((c) => c.total)),
    currentRoundToTeams: sum(inCurrent.map((c) => c.toTeam)),
    currentRoundApps: BigInt(inCurrent.length),
    allocated: sum(out.map((a) => BigInt(a.allocation.total))),
    toTeams: sum(out.map((a) => BigInt(a.allocation.toTeam))),
    withdrawnByTeams: sum(out.map((a) => BigInt(a.rewardsPool.withdrawnByTeam))),
    depositsByTeams: sum(out.map((a) => BigInt(a.rewardsPool.depositsByTeam))),
    paidToUsers: sum(out.map((a) => BigInt(a.rewardsPool.paidToUsers))),
    // Per WALLET, not per app: a wallet shared by two apps is counted once.
    soldUsd: BigInt(
      dollars(Object.values(wallets).flatMap((w) => w.outflows.filter((f) => f.kind === 'sold').map((f) => [f.value, f.at]))).total,
    ),
    toOtherWalletsUsd: BigInt(
      dollars(
        Object.values(wallets).flatMap((w) =>
          w.outflows.filter((f) => f.kind === 'other_wallet' || f.kind === 'other_contract').map((f) => [f.value, f.at]),
        ),
      ).total,
    ),
    allocatedUsd: BigInt(out.reduce((a, x) => a + x.valueUsd.allocation, 0)),
    takenNetUsd: BigInt(out.reduce((a, x) => a + x.valueUsd.takenNet, 0)),
    withdrawnUsd: BigInt(out.reduce((a, x) => a + x.valueUsd.takenGross, 0)),
    putBackUsd: BigInt(out.reduce((a, x) => a + x.valueUsd.putBack, 0)),
    sold: sum(
      Object.values(wallets).flatMap((w) => w.outflows.filter((f) => f.kind === 'sold').map((f) => f.value)),
    ),
  });

  return { apps: out, totals };
}

function str(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
}

/**
 * The newest round whose claims are (nearly) complete: at least 90% as many
 * claims as the round before it. Otherwise the round before.
 */
export function pickCurrentRound(claims) {
  const count = new Map();
  for (const c of claims) count.set(c.round, (count.get(c.round) ?? 0) + 1);
  const rounds = [...count.keys()].sort((a, b) => b - a);
  if (rounds.length === 0) return 0;
  const [newest, previous] = rounds;
  if (previous === undefined) return newest;
  return count.get(newest) >= 0.9 * count.get(previous) ? newest : previous;
}
