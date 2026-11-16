// Prints a plain-text summary of site/data/summary.json to the run log (and
// GitHub's job summary), plus sanity checks that should never fail.
import { readFile, appendFile } from 'node:fs/promises';

const d = JSON.parse(await readFile(process.argv[2] ?? 'site/data/summary.json', 'utf8'));
const b = (w) => Number(BigInt(w) / 10n ** 18n).toLocaleString('en-US');
const lines = [];
const t = d.totals;
lines.push(`Block ${d.bestBlock} · ${d.apps.length} apps`);
lines.push(`Current round #${t.currentRound}: ${b(t.currentRoundToApps)} B3TR to ${t.currentRoundApps} apps (${b(t.currentRoundToTeams)} to team wallets)`);
lines.push(`All time: allocated ${b(t.allocated)} · paid to users ${b(t.paidToUsers)} · to teams ${b(t.toTeams)} · sold ${b(t.sold)}`);
lines.push('');
lines.push('Top 15 this round:');
const cur = d.apps.filter((a) => a.current).sort((x, y) => (BigInt(y.current.total) > BigInt(x.current.total) ? 1 : -1));
for (const a of cur.slice(0, 15)) {
  lines.push(
    `  ${a.name.slice(0, 26).padEnd(26)} round ${b(a.current.total).padStart(9)} | all-time ${b(a.allocation.total).padStart(11)} | paid ${String(a.ratios.paidToUsersPctOfAllocation ?? '—').padStart(5)}% | team ${String(a.ratios.teamSharePct ?? '—').padStart(4)}% | sold ${b(a.teamWallet.sent.sold).padStart(10)} (${a.ratios.soldPctOfTeamReceipts ?? '—'}%)`,
  );
}
// Sanity: paid-to-users can't be negative (deposits − withdrawals − balance).
const negative = d.apps.filter((a) => BigInt(a.rewardsPool.paidToUsers) < 0n);
lines.push('');
lines.push(negative.length ? `CHECK FAILED: negative paid-to-users for ${negative.map((a) => a.name).join(', ')}` : 'Checks: paid-to-users never negative ✓');
const text = lines.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');
