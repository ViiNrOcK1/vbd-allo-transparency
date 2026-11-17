// Prints a plain-text summary of site/data/summary.json to the run log (and
// GitHub's job summary), plus sanity checks that should never fail.
import { readFile, appendFile } from 'node:fs/promises';

const d = JSON.parse(await readFile(process.argv[2] ?? 'site/data/summary.json', 'utf8'));
const b = (w) => Number(BigInt(w) / 10n ** 18n).toLocaleString('en-US');
const lines = [];
const t = d.totals;
lines.push(`Block ${d.bestBlock} · ${d.apps.length} apps`);
lines.push(`Current round #${t.currentRound}: ${b(t.currentRoundToApps)} B3TR to ${t.currentRoundApps} apps (${b(t.currentRoundToTeams)} to team wallets)`);
lines.push(`All time: allocated ${b(t.allocated)} · paid to users ${b(t.paidToUsers)} · team share ${b(t.toTeams)} · team withdrawals ${b(t.withdrawnByTeams)} · sold ${b(t.sold)}`);
lines.push('');
lines.push('Top 15 this round:');
const cur = d.apps.filter((a) => a.current).sort((x, y) => (BigInt(y.current.total) > BigInt(x.current.total) ? 1 : -1));
for (const a of cur.slice(0, 15)) {
  lines.push(
    `  ${a.name.slice(0, 26).padEnd(26)} round ${b(a.current.total).padStart(9)} | all-time ${b(a.allocation.total).padStart(11)} | paid ${String(a.ratios.paidToUsersPctOfAllocation ?? '—').padStart(5)}% | taken by team ${String(a.ratios.takenByTeamPct ?? '—').padStart(5)}% | sold ${b(a.teamWallet.sent.sold).padStart(10)} (${a.ratios.soldPctOfTeamReceipts ?? '—'}%)`,
  );
}
// Sanity: paid-to-users can't be negative (deposits − withdrawals − balance).
const negative = d.apps.filter((a) => BigInt(a.rewardsPool.paidToUsers) < 0n);
lines.push('');
lines.push(negative.length ? `CHECK FAILED: negative paid-to-users for ${negative.map((a) => a.name).join(', ')}` : 'Checks: paid-to-users never negative ✓');

// Independent cross-checks computed by the indexer (contract views vs events).
lines.push('');
lines.push('Cross-checks:');
for (const c of d.checks ?? []) lines.push(`  ${c.ok ? '✓' : '✗ FAILED'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
if (!(d.checks ?? []).length) lines.push('  (none in this summary)');

// Detail for apps people have asked about.
const WATCH = (process.env.WATCH_APPS ?? 'B3TR Beach,veDelegate,Mugshot,GreenCart').split(',').map((s) => s.trim().toLowerCase());
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
  lines.push(`  rewards pool: deposits ${b(a.rewardsPool.deposits)} (team top-ups ${b(a.rewardsPool.depositsByTeam)}) · withdrawn ${b(a.rewardsPool.withdrawnByTeam)} · balance ${b(a.rewardsPool.balanceNow)} · paid to users ${b(a.rewardsPool.paidToUsers)}`);
  lines.push(`  team wallet received: ${Object.entries(rx).filter(([, v]) => v !== '0').map(([k, v]) => `${k} ${b(v)}`).join(' · ') || 'nothing read'}`);
  lines.push(`  team wallet sent: ${Object.entries(tw.sent).filter(([, v]) => v !== '0').map(([k, v]) => `${k} ${b(v)}`).join(' · ') || 'nothing'} · balance ${b(tw.balanceNow)}`);
  lines.push(`  sold ${a.ratios.soldPctOfTeamReceipts ?? '—'}% of all receipts · grants ${a.ratios.grantsShareOfReceiptsPct ?? '—'}% of receipts`);
  for (const x of tw.topSenders ?? []) lines.push(`    from ${x.address} ${x.kind} ${b(x.amount)} (${x.count}×)`);
  for (const x of tw.largestSales ?? []) lines.push(`    sale ${b(x.amount)} tx ${x.txId} ${x.at ? new Date(x.at * 1000).toISOString().slice(0, 10) : ''}`);
}
const text = lines.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');
