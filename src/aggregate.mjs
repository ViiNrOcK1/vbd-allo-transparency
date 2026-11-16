// Turn decoded events into the per-app summary the page shows. Pure.
// Amounts are BigInt wei here and decimal strings in the output JSON.

import { KINDS } from './classify.mjs';

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
export function summarize({ apps, claims, deposits, withdrawals, poolBalances, wallets, xAllocationPool }) {
  const xap = xAllocationPool.toLowerCase();

  // Every wallet that ever received an app's team share, plus the current one.
  const walletsOf = new Map();
  for (const a of apps) walletsOf.set(a.id, new Set([a.teamWallet.toLowerCase()]));
  for (const c of claims) walletsOf.get(c.appId)?.add(c.recipient.toLowerCase());

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
    const recipients = new Map();
    let walletBalance = ZERO;
    for (const w of myWallets) {
      const flows = wallets[w];
      if (!flows) continue;
      walletBalance += flows.balance;
      for (const f of flows.outflows) {
        sent[f.kind] = (sent[f.kind] ?? ZERO) + f.value;
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

    return {
      id: app.id,
      name: app.name,
      active: app.active,
      teamAllocationPercentage: app.teamAllocationPercentage,
      teamWallets: myWallets,
      currentTeamWallet: app.teamWallet.toLowerCase(),
      sharedWalletWith: [...sharedWith],
      rounds: myClaims.length,
      firstRound: myClaims[0]?.round ?? null,
      lastRound: myClaims.at(-1)?.round ?? null,
      perRound: myClaims.map((c) => ({ round: c.round, total: c.total.toString() })),
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
        balanceNow: walletBalance.toString(),
        sent: str(sent),
        topRecipients: [...recipients.values()]
          .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
          .slice(0, 10)
          .map((r) => ({ ...r, amount: r.amount.toString() })),
      },
      ratios: {
        paidToUsersPctOfAllocation: pct(paidToUsers, allocation.total),
        soldPctOfTeamReceipts: pct(sent.sold, groupReceived),
        teamSharePct: pct(allocation.toTeam, allocation.total),
      },
    };
  });

  const totals = str({
    allocated: sum(out.map((a) => BigInt(a.allocation.total))),
    toTeams: sum(out.map((a) => BigInt(a.allocation.toTeam))),
    paidToUsers: sum(out.map((a) => BigInt(a.rewardsPool.paidToUsers))),
    // Per WALLET, not per app: a wallet shared by two apps is counted once.
    sold: sum(
      Object.values(wallets).flatMap((w) => w.outflows.filter((f) => f.kind === 'sold').map((f) => f.value)),
    ),
  });

  return { apps: out, totals };
}

function str(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
}
