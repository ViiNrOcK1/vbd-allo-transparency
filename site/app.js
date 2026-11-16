// Renders data/summary.json. No framework, no tracking.

const EXPLORER = 'https://explore.vechain.org/accounts/';
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
const pctTxt = (p) => (p === null || p === undefined ? '—' : `${p}%`);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const KIND_LABEL = {
  sold: 'Sold (swap in a B3TR pool)',
  liquidity: 'Added to a B3TR pool (liquidity)',
  rewards_pool: 'Back into the rewards pool',
  vot3: 'Converted to VOT3',
  vbd_contract: 'Other VeBetterDAO contract',
  other_contract: 'Other contract',
  other_wallet: 'Other wallet',
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
    teamPct: a.ratios.teamSharePct ?? -1,
    sold: b3(a.teamWallet.sent.sold),
    held: b3(a.teamWallet.balanceNow),
  }));
}

function renderTotals(d) {
  const t = d.totals;
  const allocated = b3(t.allocated);
  const cards = [
    [`Round #${t.currentRound} to apps`, fmt(b3(t.currentRoundToApps)) + ' B3TR', `${t.currentRoundApps} apps · ${fmt(b3(t.currentRoundToTeams))} of it to team wallets`],
    ['Allocated to apps', fmt(allocated) + ' B3TR', `${d.apps.filter((a) => a.rounds > 0).length} apps, all rounds`],
    ['Paid to users', fmt(b3(t.paidToUsers)) + ' B3TR', `${allocated ? ((b3(t.paidToUsers) / allocated) * 100).toFixed(1) : '—'}% of allocations`],
    ['Sent to team wallets', fmt(b3(t.toTeams)) + ' B3TR', `${allocated ? ((b3(t.toTeams) / allocated) * 100).toFixed(1) : '—'}% of allocations`],
    ['Sold by teams', fmt(b3(t.sold)) + ' B3TR', 'swapped in B3TR pools'],
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
  const recips = a.teamWallet.topRecipients
    .map((r) => `<li><a class="addr" href="${EXPLORER}${esc(r.address)}" target="_blank" rel="noopener">${esc(short(r.address))}</a> · ${fmt(b3(r.amount))} B3TR · ${esc(KIND_LABEL[r.kind] ?? r.kind)} (${r.count}×)</li>`)
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
        <dt>Paid to users</dt><dd>${fmt(b3(pool.paidToUsers))}</dd>
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
    ${recips ? `<div class="dbox"><h3>Largest recipients</h3><ol class="recips">${recips}</ol></div>` : ''}
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
      const tags = `${a.sharedWalletWith.length ? '<span class="tag">shared wallet</span>' : ''}${a.active ? '' : '<span class="tag off">inactive</span>'}`;
      const main = `<tr class="row" data-id="${esc(a.id)}" tabindex="0" aria-expanded="${open === a.id}">
        <td class="l"><strong>${esc(a.name)}</strong>${tags}<span class="sub">${a.rounds} rounds${a.perRound.length ? ` · last: ${fmt(b3(a.perRound.at(-1).total))} in #${a.perRound.at(-1).round}` : ''}</span></td>
        <td data-label="Round #${DATA.totals.currentRound}">${current < 0 ? '—' : fmt(current)}</td>
        <td data-label="All-time allocated">${fmt(allocated)}</td>
        <td data-label="Paid to users">${pctTxt(paidPct < 0 ? null : paidPct)}<span class="pctbar"><i style="width:${Math.max(0, Math.min(100, paidPct))}%"></i></span></td>
        <td data-label="Team share">${pctTxt(teamPct < 0 ? null : teamPct)}</td>
        <td data-label="Sold by team" class="${soldPct >= 50 ? 'sold-hi' : ''}">${fmt(sold)}<span class="sub">${soldPct === null ? '—' : `${soldPct}% of team receipts${a.sharedWalletWith.length ? ' (shared)' : ''}`}</span></td>
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
  const head = document.getElementById('curHead');
  if (head) head.textContent = `Round #${DATA.totals.currentRound}`;
  render();

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
