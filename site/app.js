// Renders data/summary.json. No framework, no tracking.

import { renderCharts } from './charts.js';

const EXPLORER = 'https://explore.vechain.org/accounts/';
const TX = 'https://explore.vechain.org/transactions/';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** wei string → B3TR number (loses precision past 2^53 wei-units of B3TR, which is fine for display). */
const b3 = (wei) => Number(BigInt(wei || '0') / 10n ** 14n) / 1e4;
const fmt = (n) => {
  const a = Math.abs(n);
  if (n === 0) return '0';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  return n.toFixed(a >= 10 ? 0 : 1);
};
/** Whole dollars → "$1.2M". */
const usdTxt = (n) => (n === null || n === undefined ? '—' : (n < 0 ? '−$' : '$') + fmt(Math.abs(n)));
const pctTxt = (p) => (p === null || p === undefined ? '—' : `${p}%`);
const shareTxt = (p) => (p < 1 ? 'under 1%' : `${Math.round(p)}%`);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const KIND_LABEL = {
  sold: 'Sold (swap in a B3TR pool)',
  liquidity: 'Added to a B3TR pool (liquidity)',
  rewards_pool: 'Back into the rewards pool',
  vot3: 'Converted to VOT3',
  to_dao: 'Returned to the DAO treasury / grants',
  vbd_contract: 'Other VeBetterDAO contract',
  other_contract: 'Other contract',
  other_wallet: 'Other wallet',
};

const IN_LABEL = {
  allocation: 'Allocation (team share)',
  pool_withdrawal: 'Withdrawn from its rewards pool',
  grants_dao: 'Grants / DAO / foundation',
  bought: 'Bought (out of a B3TR pool)',
  from_vot3: 'Converted back from VOT3',
  vbd_other: 'Other VeBetterDAO contract',
  other_contract: 'Other contract',
  other_wallet: 'Other wallets (likely exchanges / payroll)',
};

let DATA = null;
let sortKey = 'current';
let sortDir = -1;
let open = null;

function rowsOf(apps) {
  return apps.map((a) => ({
    a,
    name: a.name.toLowerCase(),
    current: a.current ? b3(a.current.total) : -1,
    allocated: b3(a.allocation.total),
    paidPct: a.ratios.paidToUsersPctOfAllocation ?? -1,
    teamPct: a.ratios.takenByTeamPct ?? -Infinity,
    sold: b3(a.teamWallet.sent.sold),
    held: b3(a.teamWallet.balanceNow),
  }));
}

/** Net taken (withdrawn + official share − put back). Paid + this + still in pool = 100%. */
function takenCell(a) {
  const r = a.ratios;
  if (r.takenByTeamPct === null || r.takenByTeamPct === undefined) return '—';
  const back = r.putBackByTeamPct ? ` − ${r.putBackByTeamPct}% put back` : '';
  const viaRewards = r.toOwnTeamAsRewardsPct ? `, ${r.toOwnTeamAsRewardsPct}% paid to its own wallets as “rewards”` : '';
  const how = r.teamSharePct
    ? `${r.takenByTeamGrossPct}% incl. official share${viaRewards}${back}`
    : r.takenByTeamGrossPct
      ? `took ${r.takenByTeamGrossPct}%${viaRewards}${back}`
      : '';
  if (r.takenByTeamPct <= 0) {
    const added = b3(a.rewardsPool.depositsByTeam) - b3(a.teamWallet.receivedFromVeBetterDAO);
    return `None<span class="sub">${added > 0 ? `added ${fmt(added)} of its own` : how || 'nothing withdrawn'}</span>`;
  }
  const v = a.valueUsd;
  return `${r.takenByTeamPct}%<span class="sub">${how}${v && v.takenNet > 0 ? ` · ≈${usdTxt(v.takenNet)} then` : ''}</span>`;
}

function renderTotals(d) {
  const t = d.totals;
  const allocated = b3(t.allocated);
  const cards = [
    [`Round #${t.currentRound} to apps`, fmt(b3(t.currentRoundToApps)) + ' B3TR', `${t.currentRoundApps} apps · ${fmt(b3(t.currentRoundToTeams))} of it to team wallets`],
    ['Allocated to apps', fmt(allocated) + ' B3TR', `${d.apps.filter((a) => a.rounds > 0).length} apps, all rounds · ≈${usdTxt(Number(t.allocatedUsd ?? 0))} when received`],
    ['Paid to users', fmt(b3(t.paidToUsers)) + ' B3TR', `${allocated ? ((b3(t.paidToUsers) / allocated) * 100).toFixed(1) : '—'}% of allocations · not counting rewards apps paid to their own team or endorsers`],
    ['Paid to endorsers', fmt(b3(t.toEndorsers ?? '0')) + ' B3TR', `${allocated ? ((b3(t.toEndorsers ?? '0') / allocated) * 100).toFixed(1) : '—'}% of allocations · ≈${usdTxt(Number(t.toEndorsersUsd ?? 0))} at the time · rewards apps paid to wallets that endorse them`],
    (() => {
      const net = b3(t.toTeams) + b3(t.withdrawnByTeams) - b3(t.depositsByTeams ?? '0');
      return ['Taken by teams (net)', fmt(net) + ' B3TR', `${allocated ? ((net / allocated) * 100).toFixed(1) : '—'}% of allocations · ≈${usdTxt(Number(t.takenNetUsd ?? 0))} at the time · withdrew ${fmt(b3(t.withdrawnByTeams))}, put back ${fmt(b3(t.depositsByTeams ?? '0'))}`];
    })(),
    ['Sold by teams (proven)', fmt(b3(t.sold)) + ' B3TR', `≈${usdTxt(Number(t.soldUsd ?? 0))} when sold · swapped in B3TR pools`],
    ['Moved to other wallets', usdTxt(Number(t.toOtherWalletsUsd ?? 0)), 'value when moved · usually exchanges or payroll — most likely sold for expenses'],
  ];
  $('#totals').innerHTML = cards
    .map(([k, v, s]) => `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`)
    .join('');
}

function detailHtml(a) {
  const alloc = b3(a.allocation.total) || 1;
  const toPool = b3(a.allocation.toRewardsPool);
  const toTeam = b3(a.allocation.toTeam);
  const pool = a.rewardsPool;
  const sent = a.teamWallet.sent;
  const max = Math.max(1, ...a.perRound.map((r) => b3(r.total)));
  const bars = a.perRound.map((r) => `<i title="Round ${r.round}: ${fmt(b3(r.total))} B3TR" style="height:${Math.max(2, (b3(r.total) / max) * 100)}%"></i>`).join('');
  const sentRows = Object.entries(KIND_LABEL)
    .map(([k, label]) => [label, b3(sent[k])])
    .filter(([, v]) => v > 0)
    .map(([label, v]) => `<dt>${esc(label)}</dt><dd>${fmt(v)}</dd>`)
    .join('');
  // "Largest recipients": where the team wallet's B3TR went, biggest first.
  // ReCircleCreator (2026-11-18) found the old one-liner hard to read, so each
  // entry now says what the address is, its share of everything sent, and
  // how many transfers it took, in words.
  // Same basis as the list: moves between its own wallets ('internal') excluded.
  const sentTotal = Object.entries(sent).reduce((t, [k, v]) => (k === 'internal' ? t : t + b3(v)), 0) || 1;
  const recips = a.teamWallet.topRecipients
    .map((r) => {
      const amt = b3(r.amount);
      const n = r.count === 1 ? '1 transfer' : `${r.count} transfers`;
      return `<li><span class="rk">${esc(KIND_LABEL[r.kind] ?? r.kind)}</span>
        <a class="addr" href="${EXPLORER}${esc(r.address)}" target="_blank" rel="noopener">${esc(short(r.address))}</a><br>
        <strong>${fmt(amt)} B3TR</strong> · ${shareTxt((amt / sentTotal) * 100)} of all it sent · ${n}</li>`;
    })
    .join('');
  const rx = a.teamWallet.received ?? {};
  const rxRows = Object.entries(IN_LABEL)
    .map(([k, label]) => [label, b3(rx[k])])
    .filter(([, v]) => v > 0)
    .map(([label, v]) => `<dt>${esc(label)}</dt><dd>${fmt(v)}</dd>`)
    .join('');
  const g = a.teamWallet.grants ?? { total: rx.grants_dao ?? '0', via: [] };
  const grants = b3(g.total);
  const viaTxt = (g.via ?? [])
    .map((v) => `<a class="addr" href="${EXPLORER}${esc(v.address)}" target="_blank" rel="noopener">${esc(short(v.address))}</a> (${fmt(b3(v.counted))})`)
    .join(', ');
  const sales = (a.teamWallet.largestSales ?? [])
    .map((s) => `<li><a class="addr" href="${TX}${esc(s.txId)}" target="_blank" rel="noopener">${esc(short(s.txId))}</a> · ${fmt(b3(s.amount))} B3TR${s.at ? ` · ${esc(new Date(s.at * 1000).toISOString().slice(0, 10))}` : ''}</li>`)
    .join('');
  const wallets = a.teamWallets
    .map((w) => `<a class="addr" href="${EXPLORER}${esc(w)}" target="_blank" rel="noopener">${esc(short(w))}</a>${w === a.currentTeamWallet ? ' (current)' : ''}`)
    .join(', ');
  return `<div class="dgrid">
    <div class="dbox">
      <h3>Allocation split</h3>
      <div class="flow" aria-hidden="true">
        <i style="width:${(toPool / alloc) * 100}%;background:var(--bar-users)"></i>
        <i style="width:${(toTeam / alloc) * 100}%;background:var(--bar-team)"></i>
      </div>
      <dl class="kv">
        <dt>To rewards pool</dt><dd>${fmt(toPool)}</dd>
        <dt>To team wallet</dt><dd>${fmt(toTeam)}</dd>
        <dt>Rounds claimed</dt><dd>${a.rounds}${a.firstRound ? ` (#${a.firstRound}–#${a.lastRound})` : ''}</dd>
      </dl>
      <div class="rounds" title="Allocation per round">${bars}</div>
    </div>
    <div class="dbox">
      <h3>Rewards pool</h3>
      <dl class="kv">
        <dt>Deposited</dt><dd>${fmt(b3(pool.deposits))}</dd>
        <dt>…of which topped up by team</dt><dd>${fmt(b3(pool.depositsByTeam))}</dd>
        <dt>Paid to users</dt><dd>${fmt(b3(pool.paidToRealUsers ?? pool.paidToUsers))}</dd>
        ${b3(pool.toEndorsers ?? '0') > 0 ? `<dt>Paid to its endorsers (${a.endorsers?.paid ?? 0} of ${a.endorsers?.wallets ?? 0})</dt><dd>${fmt(b3(pool.toEndorsers))}</dd>` : ''}
        ${b3(pool.toOwnTeamAsRewards ?? '0') > 0 ? `<dt>Paid to its own team wallets as “rewards”</dt><dd>${fmt(b3(pool.toOwnTeamAsRewards))}</dd>` : ''}
        <dt>Withdrawn by team</dt><dd>${fmt(b3(pool.withdrawnByTeam))}</dd>
        <dt>Still in pool</dt><dd>${fmt(b3(pool.balanceNow))}</dd>
      </dl>
    </div>
    <div class="dbox">
      <h3>Team wallet</h3>
      <dl class="kv">
        <dt>Received from VeBetterDAO</dt><dd>${fmt(b3(a.teamWallet.receivedFromVeBetterDAO))}</dd>
        ${a.sharedWalletWith.length ? `<dt>…by all apps sharing the wallet</dt><dd>${fmt(b3(a.teamWallet.receivedByWalletGroup))}</dd>` : ''}
        ${sentRows || '<dt>Sent out</dt><dd>nothing</dd>'}
        <dt>Balance now</dt><dd>${fmt(b3(a.teamWallet.balanceNow))}</dd>
      </dl>
      <p class="fine">Wallet${a.teamWallets.length > 1 ? 's' : ''}: ${wallets}${a.sharedWalletWith.length ? '<br>Shared with other apps: flows can’t be split between them.' : ''}</p>
    </div>
    ${(() => {
      const u = DATA.users?.apps?.[a.id.toLowerCase()];
      if (!u) return '';
      const top = u.topReceiver90;
      return `<div class="dbox"><h3>Users, last 30 / 90 days</h3><dl class="kv">
        <dt>Wallets paid, 30 days</dt><dd>${fmt(u.users30)}</dd>
        <dt>Wallets paid, 90 days</dt><dd>${fmt(u.users90)}</dd>
        <dt>B3TR paid to them, 90 days</dt><dd>${fmt(u.b3tr90)}</dd>
        ${top ? `<dt>Biggest single receiver</dt><dd>${top.sharePct}%</dd><dt>Top 5 receivers</dt><dd>${u.top5SharePct90}%</dd>` : ''}
      </dl>${top ? `<p class="fine">Biggest receiver: <a class="addr" href="${EXPLORER}${esc(top.address)}" target="_blank" rel="noopener">${esc(short(top.address))}</a> (${fmt(top.b3tr)} B3TR). When one wallet takes most of an app’s rewards, the app may be paying in bulk to a wallet that hands them out by plain transfers, or paying a team wallet it never registered — or it has one very active user. Open the address to check.</p>` : ''}<p class="fine">Not counted as users: the app’s own team wallets and wallets that have endorsed it.</p></div>`;
    })()}
    ${a.valueUsd ? `<div class="dbox"><h3>Value at the time (USD)</h3><dl class="kv">
        <dt>Allocation, when received</dt><dd>${usdTxt(a.valueUsd.allocation)}</dd>
        <dt>Taken by team, net</dt><dd>${usdTxt(a.valueUsd.takenNet)}</dd>
        ${a.valueUsd.putBack ? `<dt>…withdrawn ${usdTxt(a.valueUsd.takenGross)}, put back</dt><dd>${usdTxt(a.valueUsd.putBack)}</dd>` : ''}
        <dt>Sold (proven swaps)</dt><dd>${usdTxt(a.valueUsd.sold)}</dd>
        <dt>Sent to other wallets</dt><dd>${usdTxt(a.valueUsd.toOtherWallets)}</dd>
      </dl><p class="fine">Each transfer is valued at that day’s B3TR price. “Other wallets” are usually exchanges or payroll — most of it is likely sold to cover costs, but the chain can’t prove where it ended up.</p></div>` : ''}
    ${rxRows ? `<div class="dbox"><h3>Where the wallet’s B3TR came from</h3><dl class="kv">${rxRows}</dl>
      <p class="fine">${grants > 0 ? `<strong>About ${fmt(grants)} B3TR of this was grant / DAO funding</strong>${viaTxt ? `, partly passed on by ${viaTxt}, which received it from VeBetterDAO` : ''}. ` : ''}B3TR is interchangeable, so a sale can’t be tied to one source — “sold %” is measured against everything received.</p></div>` : ''}
    ${sales ? `<div class="dbox"><h3>Largest sales</h3><ol class="recips">${sales}</ol><p class="fine">Each is a transaction that swapped B3TR in a pool — open it to check. B3TR moved to another wallet or an exchange first and sold there isn’t counted, so “sold” is a floor.</p></div>` : ''}
    ${recips ? `<div class="dbox"><h3>Largest recipients</h3>
      <p class="fine">The addresses this app’s team wallet sent the most B3TR to, all time, biggest first. The label says what the address is: a B3TR pool (a sale), the app’s own rewards pool, VeBetterDAO, or an <em>other wallet</em> we can’t identify (often an exchange deposit address or payroll, but we don’t assume). Moves between the app’s own wallets aren’t counted. Tap an address to check it on the explorer.</p>
      <ol class="recips">${recips}</ol></div>` : ''}
  </div>`;
}

function render() {
  const q = $('#q').value.trim().toLowerCase();
  const activeOnly = $('#activeOnly').checked;
  const rows = rowsOf(DATA.apps)
    .filter((r) => (!activeOnly || r.a.active) && (!q || r.name.includes(q)))
    .sort((x, y) => (x[sortKey] < y[sortKey] ? -1 : x[sortKey] > y[sortKey] ? 1 : 0) * sortDir);

  document.querySelectorAll('th[data-k]').forEach((th) => {
    if (th.dataset.k === sortKey) th.setAttribute('aria-sort', sortDir > 0 ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  });

  $('#empty').hidden = rows.length > 0;
  $('#apps tbody').innerHTML = rows
    .map(({ a, current, allocated, paidPct, teamPct, sold, held }) => {
      const soldPct = a.ratios.soldPctOfTeamReceipts;
      const u = DATA.users?.apps?.[a.id.toLowerCase()];
      const conc = u?.topReceiver90 && u.topReceiver90.sharePct >= 50 && u.b3tr90 >= 1000;
      const tags = `${a.sharedWalletWith.length ? '<span class="tag">shared wallet</span>' : ''}${a.active ? '' : '<span class="tag off">inactive</span>'}${conc ? `<span class="tag" title="One wallet received ${u.topReceiver90.sharePct}% of this app’s rewards in the last 90 days">1 wallet: ${u.topReceiver90.sharePct}% of rewards</span>` : ''}`;
      const usersLine = DATA.users ? ` · ${fmt(u?.users30 ?? 0)} users in 30 days` : '';
      const main = `<tr class="row" data-id="${esc(a.id)}" tabindex="0" aria-expanded="${open === a.id}">
        <td class="l"><strong>${esc(a.name)}</strong>${tags}<span class="sub">${a.rounds} rounds${a.lastRound ? ` · last: ${fmt(b3((a.perRound.find((r) => r.round === a.lastRound) ?? { total: '0' }).total))} in #${a.lastRound}` : ''}${usersLine}</span></td>
        <td data-label="Round #${DATA.totals.currentRound}">${current < 0 ? '—' : fmt(current)}</td>
        <td data-label="All-time allocated">${fmt(allocated)}</td>
        <td data-label="Paid to users" title="Paid to users + paid to its endorsers + taken by team + still in the pool = 100% of the allocation">${pctTxt(paidPct < 0 ? null : paidPct)}<span class="pctbar"><i style="width:${Math.max(0, Math.min(100, paidPct))}%"></i></span>${a.ratios.toEndorsersPct ? `<span class="sub">+ ${a.ratios.toEndorsersPct}% to its endorsers</span>` : ''}${a.ratios.stillInPoolPct ? `<span class="sub">${a.ratios.stillInPoolPct}% still in pool</span>` : ''}</td>
        <td data-label="Taken by team">${takenCell(a)}</td>
        <td data-label="Sold by team" class="${soldPct >= 50 ? 'sold-hi' : ''}">${fmt(sold)}<span class="sub">${soldPct === null ? '—' : `${soldPct}% of all received${a.sharedWalletWith.length ? ' (shared)' : ''}`}${a.valueUsd?.sold ? ` · ${usdTxt(a.valueUsd.sold)}` : ''}${a.valueUsd?.toOtherWallets ? `<br>+ ${usdTxt(a.valueUsd.toOtherWallets)} to other wallets` : ''}</span></td>
        <td data-label="Team wallet now">${fmt(held)}</td>
      </tr>`;
      return open === a.id ? `${main}<tr class="detail"><td colspan="7">${detailHtml(a)}</td></tr>` : main;
    })
    .join('');
}

async function main() {
  const res = await fetch('data/summary.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`summary.json: HTTP ${res.status}`);
  DATA = await res.json();
  const when = new Date(DATA.generatedAt);
  $('#meta').textContent = `Updated ${when.toLocaleString()} · block ${DATA.bestBlock.toLocaleString()} · ${DATA.apps.length} apps`;
  renderTotals(DATA);
  try {
    renderCharts(DATA);
  } catch (e) {
    console.error('charts', e);
  }
  const head = document.getElementById('curHead');
  if (head) head.textContent = `Round #${DATA.totals.currentRound}`;
  render();
  const checks = DATA.checks ?? [];
  if (checks.length && $('#checks')) {
    const bad = checks.filter((c) => c.ok === false).length;
    $('#checks').innerHTML = `<h2>${bad ? `⚠ ${bad} of ${checks.length} cross-checks failed` : `✓ All ${checks.length} cross-checks passed`}</h2>
      <p class="fine">Each run re-reads the same facts from a second, independent place on-chain and compares.</p>
      <ul>${checks.map((c) => `<li>${c.ok ? '✓' : c.ok === null ? '–' : '✗'} ${esc(c.name)}${c.detail ? ` <span class="sub">${esc(c.detail)}</span>` : ''}</li>`).join('')}</ul>`;
    $('#checks').hidden = false;
  }

  $('#q').addEventListener('input', render);
  $('#activeOnly').addEventListener('change', render);
  $('#sortSel').addEventListener('change', (e) => {
    sortKey = e.target.value;
    sortDir = sortKey === 'name' ? 1 : -1;
    render();
  });
  document.querySelectorAll('th[data-k]').forEach((th) =>
    th.addEventListener('click', () => {
      const k = th.dataset.k;
      sortDir = sortKey === k ? -sortDir : k === 'name' ? 1 : -1;
      sortKey = k;
      render();
    }),
  );
  const toggle = (tr) => {
    open = open === tr.dataset.id ? null : tr.dataset.id;
    render();
  };
  $('#apps tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr.row');
    if (tr && !e.target.closest('a')) toggle(tr);
  });
  $('#apps tbody').addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr.row');
    if (tr && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggle(tr);
    }
  });
}

main().catch((err) => {
  $('#meta').textContent = `Could not load the data: ${err.message}`;
});
