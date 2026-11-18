// Prints a plain-text summary of site/data/summary.json to the run log (and
// GitHub's job summary), plus sanity checks that should never fail.
import { readFile, appendFile } from 'node:fs/promises';

const d = JSON.parse(await readFile(process.argv[2] ?? 'site/data/summary.json', 'utf8'));
const b = (w) => Number(BigInt(w) / 10n ** 18n).toLocaleString('en-US');
const lines = [];
const t = d.totals;
lines.push(`Block ${d.bestBlock} · ${d.apps.length} apps`);
lines.push(`Current round #${t.currentRound}: ${b(t.currentRoundToApps)} B3TR to ${t.currentRoundApps} apps (${b(t.currentRoundToTeams)} to team wallets)`);
const usd = (n) => '$' + Number(n ?? 0).toLocaleString('en-US');
if (d.prices) lines.push(`Prices: B3TR/VET from ${d.prices.b3trVetPools.map((p) => p.pair + ' ' + p.pool).join(', ') || 'NO POOLS'} · VET/USD from ${d.prices.vetUsdSource ?? 'NONE'} · ${Object.keys(d.prices.b3trUsd ?? {}).length} priced days`);
lines.push(`At the time: allocated ${usd(t.allocatedUsd)} · taken by teams (net) ${usd(t.takenNetUsd)} · proven sold ${usd(t.soldUsd)} · to other wallets ${usd(t.toOtherWalletsUsd)}`);
lines.push(`All time: allocated ${b(t.allocated)} · paid to users ${b(t.paidToUsers)} · team share ${b(t.toTeams)} · team withdrawals ${b(t.withdrawnByTeams)} · sold ${b(t.sold)}`);
lines.push('');
lines.push('Top 15 this round:');
const cur = d.apps.filter((a) => a.current).sort((x, y) => (BigInt(y.current.total) > BigInt(x.current.total) ? 1 : -1));
for (const a of cur.slice(0, 15)) {
  lines.push(
    `  ${a.name.slice(0, 26).padEnd(26)} round ${b(a.current.total).padStart(9)} | all-time ${b(a.allocation.total).padStart(11)} | paid ${String(a.ratios.paidToUsersPctOfAllocation ?? '—').padStart(5)}% | taken by team ${String(a.ratios.takenByTeamPct ?? '—').padStart(5)}% | sold ${b(a.teamWallet.sent.sold).padStart(10)} (${a.ratios.soldPctOfTeamReceipts ?? '—'}%)`,
  );
}
// Users per app (distinct wallets paid), last 30 / 90 days.
if (d.users) {
  const u = d.users;
  const rows = d.apps
    .map((a) => ({ name: a.name, alloc: a.current ? BigInt(a.current.total) : 0n, ...(u.apps[a.id.toLowerCase()] ?? { users30: 0, users90: 0, payouts30: 0, payouts90: 0, b3tr90: 0 }) }))
    .sort((x, y) => y.users30 - x.users30);
  lines.push('', `Users (distinct wallets paid) — ecosystem: ${u.ecosystem.users30} in 30 days, ${u.ecosystem.users90} in 90 days`);
  lines.push('  app                            users30  users90  payouts30  B3TR paid 90d  alloc this round');
  for (const r of rows.filter((r) => r.users90 > 0 || r.alloc > 0n)) {
    lines.push(`  ${r.name.slice(0, 30).padEnd(30)} ${String(r.users30).padStart(7)}  ${String(r.users90).padStart(7)}  ${String(r.payouts30).padStart(9)}  ${String(r.b3tr90).padStart(13)}  ${b(r.alloc).padStart(10)}`);
  }
} else lines.push('', 'Users per app: not available this run');

// Identity: for every app, paid + taken (net) + still in pool = what
// VeBetterDAO sent it (team split + rewards-pool deposits from the allocation).
const broken = d.apps.filter((a) => {
  const p = a.rewardsPool;
  const net = BigInt(a.allocation.toTeam) + BigInt(p.withdrawnByTeam) - BigInt(p.depositsByTeam);
  return BigInt(p.paidToUsers) + net + BigInt(p.balanceNow) !== BigInt(a.allocation.toTeam) + BigInt(p.depositsFromAllocation);
});
lines.push(broken.length ? `CHECK FAILED: paid + taken + in pool ≠ received for ${broken.map((a) => a.name).join(', ')}` : 'Checks: paid + taken (net) + still in pool = received, every app ✓');
const poolIn = d.apps.reduce((x, a) => x + BigInt(a.rewardsPool.depositsFromAllocation), 0n);
const poolClaimed = d.apps.reduce((x, a) => x + BigInt(a.allocation.toRewardsPool), 0n);
lines.push(`Checks: allocation deposits into the rewards pool ${b(poolIn)} vs claim events' pool share ${b(poolClaimed)} ${poolIn === poolClaimed ? '✓' : '✗ DIFFERENT'}`);
const recyclers = d.apps.filter((a) => BigInt(a.rewardsPool.depositsByTeam) > 0n)
  .sort((x, y) => (BigInt(y.rewardsPool.depositsByTeam) > BigInt(x.rewardsPool.depositsByTeam) ? 1 : -1)).slice(0, 8);
const byEnd = [...d.apps].filter((a) => a.ratios.toEndorsersPct).sort((x, y) => y.ratios.toEndorsersPct - x.ratios.toEndorsersPct).slice(0, 10);
lines.push(`Paid to endorsers, total ${b(t.toEndorsers ?? '0')} — top apps by share of allocation:`);
for (const a of byEnd) lines.push(`  ${a.name.slice(0, 26).padEnd(26)} ${String(a.ratios.toEndorsersPct).padStart(5)}%  ${b(a.rewardsPool.toEndorsers).padStart(10)}  (${a.endorsers.paid} of ${a.endorsers.wallets} endorsers paid)`);
const byOwn = [...d.apps].filter((a) => a.ratios.toOwnTeamAsRewardsPct).sort((x, y) => y.ratios.toOwnTeamAsRewardsPct - x.ratios.toOwnTeamAsRewardsPct).slice(0, 10);
lines.push(`Paid to own team wallets as rewards, total ${b(t.toOwnTeamAsRewards ?? '0')}:`);
for (const a of byOwn) lines.push(`  ${a.name.slice(0, 26).padEnd(26)} ${String(a.ratios.toOwnTeamAsRewardsPct).padStart(5)}%  ${b(a.rewardsPool.toOwnTeamAsRewards).padStart(10)}`);
lines.push('Largest team top-ups (withdraw-and-redeposit made gross "taken" + "paid" exceed 100%):');
for (const a of recyclers) lines.push(`  ${a.name.slice(0, 26).padEnd(26)} put back ${b(a.rewardsPool.depositsByTeam).padStart(10)} · withdrew ${b(a.rewardsPool.withdrawnByTeam).padStart(10)} · paid ${a.ratios.paidToUsersPctOfAllocation}% + taken ${a.ratios.takenByTeamPct}% (gross ${a.ratios.takenByTeamGrossPct}%) + in pool ${a.ratios.stillInPoolPct}%`);
// Sanity: paid-to-users can't be negative (deposits − withdrawals − balance).
const negative = d.apps.filter((a) => BigInt(a.rewardsPool.paidToUsers) < 0n);
lines.push('');
lines.push(negative.length ? `CHECK FAILED: negative paid-to-users for ${negative.map((a) => a.name).join(', ')}` : 'Checks: paid-to-users never negative ✓');

// Independent cross-checks computed by the indexer (contract views vs events).
lines.push('');
lines.push('Cross-checks:');
for (const c of d.checks ?? []) lines.push(`  ${c.ok ? '✓' : c.ok === null ? '– not run' : '✗ FAILED'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
if (!(d.checks ?? []).length) lines.push('  (none in this summary)');

// Detail for apps people have asked about.
const WATCH = (process.env.WATCH_APPS ?? 'B3TR Beach,veDelegate,Mugshot,GreenCart,VeLottery').split(',').map((s) => s.trim().toLowerCase());
const since = Number(process.env.SINCE_ROUND ?? 54);
for (const name of WATCH) {
  const a = d.apps.find((x) => x.name.toLowerCase().replace(/\s+/g, '') === name.replace(/\s+/g, ''))
    ?? d.apps.find((x) => x.name.toLowerCase().includes(name));
  if (!a) { lines.push('', `${name}: not found`); continue; }
  const tw = a.teamWallet;
  const rx = tw.received ?? {};
  const pr = a.perRound ?? [];
  const sumR = (k, from) => pr.filter((r) => r.round >= from).reduce((x, r) => x + BigInt(r[k] ?? '0'), 0n);
  lines.push('', `── ${a.name} (${a.id.slice(0, 10)}…) wallets ${a.teamWallets.join(', ')}${a.sharedWalletWith.length ? ' [SHARED]' : ''}`);
  lines.push(`  allocation all-time ${b(a.allocation.total)} (pool ${b(a.allocation.toRewardsPool)}, team split ${b(a.allocation.toTeam)}) · rounds ${a.firstRound}–${a.lastRound}`);
  lines.push(`  since round ${since}: allocated ${b(sumR('total', since))} · withdrawn by team ${b(sumR('withdrawn', since))}`);
  lines.push(`  paid out ${b(a.rewardsPool.paidToUsers)} = users ${b(a.rewardsPool.paidToRealUsers ?? '0')} (${a.ratios.paidToUsersPctOfAllocation}%) + endorsers ${b(a.rewardsPool.toEndorsers ?? '0')} (${a.ratios.toEndorsersPct ?? 0}%, ${a.endorsers?.paid ?? 0} of ${a.endorsers?.wallets ?? 0} endorsers) + own team ${b(a.rewardsPool.toOwnTeamAsRewards ?? '0')} (${a.ratios.toOwnTeamAsRewardsPct ?? 0}%) · taken net ${a.ratios.takenByTeamPct}% · in pool ${a.ratios.stillInPoolPct}%`);
  lines.push(`  rewards pool: deposits ${b(a.rewardsPool.deposits)} (team top-ups ${b(a.rewardsPool.depositsByTeam)}) · withdrawn ${b(a.rewardsPool.withdrawnByTeam)} · balance ${b(a.rewardsPool.balanceNow)} · paid to users ${b(a.rewardsPool.paidToUsers)}`);
  lines.push(`  team wallet received: ${Object.entries(rx).filter(([, v]) => v !== '0').map(([k, v]) => `${k} ${b(v)}`).join(' · ') || 'nothing read'}`);
  lines.push(`  team wallet sent: ${Object.entries(tw.sent).filter(([, v]) => v !== '0').map(([k, v]) => `${k} ${b(v)}`).join(' · ') || 'nothing'} · balance ${b(tw.balanceNow)}`);
  if (a.valueUsd) lines.push(`  $ at the time: allocation ${usd(a.valueUsd.allocation)} · taken net ${usd(a.valueUsd.takenNet)} (withdrew ${usd(a.valueUsd.takenGross)}, put back ${usd(a.valueUsd.putBack)}) · sold ${usd(a.valueUsd.sold)} · other wallets ${usd(a.valueUsd.toOtherWallets)} · unpriced ${b(a.valueUsd.unpricedB3tr)} B3TR`);
  lines.push(`  sold ${a.ratios.soldPctOfTeamReceipts ?? '—'}% of all receipts · grants ${b(tw.grants?.total ?? '0')} = ${a.ratios.grantsShareOfReceiptsPct ?? '—'}% of receipts (direct ${b(tw.grants?.direct ?? '0')}) · returned to DAO ${b(tw.grants?.returnedToDao ?? '0')}`);
  for (const v of tw.grants?.via ?? []) lines.push(`    grant via ${v.address}: got ${b(v.grantReceived)} from grants/DAO, forwarded ${b(v.forwarded)}, counted ${b(v.counted)}`);
  for (const x of tw.topSenders ?? []) lines.push(`    from ${x.address} ${x.kind} ${b(x.amount)} (${x.count}×)`);
  for (const x of (tw.topRecipients ?? []).slice(0, 6)) lines.push(`    to ${x.address} ${x.kind} ${b(x.amount)} (${x.count}×)`);
  for (const x of tw.largestSales ?? []) lines.push(`    sale ${b(x.amount)} tx ${x.txId} ${x.at ? new Date(x.at * 1000).toISOString().slice(0, 10) : ''}`);
}
const text = lines.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');
