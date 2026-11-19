// Overview charts across all apps (Pokerdutchie asked for charts on
// 2026-11-19: "an overview of all apps"). Plain SVG/HTML, no library.
//
//   1. Where each app's allocation went: one 100% bar per app, split into
//      paid to users / to its endorsers / taken by team (net) / still in pool.
//      These four add up to the whole allocation (the page's identity check).
//   2. Every round: B3TR allocated to all apps vs withdrawn by teams.
//   3. Users in the last 30 days, top apps, beside each app's share of the
//      latest round's allocation.
//
// Colours: categorical slots 1–3 of the dataviz reference palette, validated
// for both themes on this page's panel colours (blue / aqua / orange
// adjacent: CVD ΔE ≥ 9.2, normal ≥ 20.9). Aqua is under 3:1 on white, so
// every bar also carries its numbers in text and the table below is the
// full table view. "Still in pool" is a neutral grey, not a category.

const b3 = (wei) => Number(BigInt(wei || '0') / 10n ** 14n) / 1e4;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => {
  const a = Math.abs(n);
  if (n === 0) return '0';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  return n.toFixed(a >= 10 ? 0 : 1);
};
const pct = (p) => (p === null || p === undefined ? '—' : `${Math.round(p)}%`);

const SEGMENTS = [
  { key: 'users', label: 'Paid to users', cls: 's1' },
  { key: 'endorsers', label: 'To its endorsers', cls: 's3' },
  { key: 'team', label: 'Taken by team (net)', cls: 's2' },
  { key: 'pool', label: 'Still in pool', cls: 'sn' },
];
const ROWS_COLLAPSED = 12;

/** One app's split of its allocation, in % (team share net of top-ups). */
export function splitOf(a) {
  const r = a.ratios ?? {};
  const raw = {
    users: r.paidToUsersPctOfAllocation ?? 0,
    endorsers: r.toEndorsersPct ?? 0,
    team: r.takenByTeamPct ?? 0,
    pool: r.stillInPoolPct ?? 0,
  };
  // A team that put back more than it took has a negative "taken"; the bar
  // can't draw that, so it draws 0 and the text says so.
  const draw = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Math.max(0, Number(v) || 0)]));
  const sum = Object.values(draw).reduce((t, v) => t + v, 0) || 1;
  return { raw, widths: Object.fromEntries(Object.entries(draw).map(([k, v]) => [k, (v / sum) * 100])) };
}

/** Ecosystem totals per round: { round, allocated, withdrawn } ascending. */
export function perRoundTotals(apps) {
  const by = new Map();
  for (const a of apps) {
    for (const r of a.perRound ?? []) {
      const t = by.get(r.round) ?? { round: r.round, allocated: 0, withdrawn: 0 };
      t.allocated += b3(r.total);
      t.withdrawn += b3(r.withdrawn);
      by.set(r.round, t);
    }
  }
  return [...by.values()].sort((x, y) => x.round - y.round);
}

// ── shared tooltip ──
let tip;
function tooltip() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'viz-tip';
  tip.setAttribute('role', 'status');
  tip.hidden = true;
  document.body.appendChild(tip);
  return tip;
}
function showTip(html, x, y) {
  const t = tooltip();
  t.innerHTML = html;
  t.hidden = false;
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  const left = Math.min(Math.max(8, x + 14), window.innerWidth - w - 8);
  const top = y - h - 12 < 8 ? y + 16 : y - h - 12;
  t.style.left = `${left + window.scrollX}px`;
  t.style.top = `${top + window.scrollY}px`;
}
const hideTip = () => tip && (tip.hidden = true);

// ── 1. where the allocation went ──
function splitChart(el, apps, state = { sort: 'allocated', all: false }) {
  const list = apps.filter((a) => b3(a.allocation?.total) > 0);
  const sorters = {
    allocated: (a) => b3(a.allocation.total),
    team: (a) => a.ratios?.takenByTeamPct ?? 0,
    users: (a) => a.ratios?.paidToUsersPctOfAllocation ?? 0,
    // Pokerdutchie: "which app pays the least".
    usersLeast: (a) => -(a.ratios?.paidToUsersPctOfAllocation ?? 0),
  };
  const draw = () => {
    const rows = [...list].sort((x, y) => sorters[state.sort](y) - sorters[state.sort](x));
    const shown = state.all ? rows : rows.slice(0, ROWS_COLLAPSED);
    el.querySelector('.split-rows').innerHTML = shown
      .map((a) => {
        const { raw, widths } = splitOf(a);
        const segs = SEGMENTS.filter((s) => widths[s.key] > 0)
          .map((s) => `<i class="${s.cls}" style="width:${widths[s.key].toFixed(2)}%"></i>`)
          .join('');
        // Fubar (#BEASTMODE): a team that never took anything didn't "put
        // back" — it added its own B3TR. Say which one happened.
        const tookNone = !(a.ratios?.takenByTeamGrossPct > 0);
        const negTxt = tookNone ? `team took none and added its own B3TR (+${pct(-raw.team)})` : `team put back ${pct(-raw.team)} more than it took`;
        const teamTxt = raw.team < 0 ? negTxt : raw.team === 0 && tookNone ? 'team took none' : `${pct(raw.team)} team`;
        const tipHtml = `<strong>${esc(a.name)}</strong><br>${fmt(b3(a.allocation.total))} B3TR allocated, all time<br>${SEGMENTS.map(
          (s) => `<span class="sw ${s.cls}"></span>${s.label}: ${s.key === 'team' && raw.team < 0 ? (tookNone ? `none (added its own B3TR, +${pct(-raw.team)})` : `−${pct(-raw.team)} (put back more than it took)`) : pct(raw[s.key])}`,
        ).join('<br>')}`;
        return `<div class="split-row" tabindex="0" data-tip="${esc(tipHtml)}">
          <div class="split-head"><span class="nm">${esc(a.name)}</span><span class="amt">${fmt(b3(a.allocation.total))} B3TR</span></div>
          <div class="split-bar" aria-hidden="true">${segs}</div>
          <div class="split-txt">${pct(raw.users)} users · ${teamTxt}${raw.endorsers ? ` · ${pct(raw.endorsers)} endorsers` : ''}${raw.pool ? ` · ${pct(raw.pool)} in pool` : ''}</div>
        </div>`;
      })
      .join('');
    const more = el.querySelector('.split-more');
    more.hidden = rows.length <= ROWS_COLLAPSED;
    more.textContent = state.all ? `Show top ${ROWS_COLLAPSED}` : `Show all ${rows.length} apps`;
  };
  el.innerHTML = `<div class="viz-head"><h3>Where each app’s allocation went</h3>
      <label class="viz-ctl">Sort <select>
        <option value="allocated">Most allocated</option>
        <option value="team">Most taken by team</option>
        <option value="users">Most paid to users</option>
        <option value="usersLeast">Least paid to users</option>
      </select></label></div>
    <div class="viz-legend">${SEGMENTS.map((s) => `<span><span class="sw ${s.cls}"></span>${s.label}</span>`).join('')}</div>
    <div class="split-rows"></div>
    <button type="button" class="split-more"></button>
    <p class="fine">Each bar is one app’s whole allocation since it started. The four parts add up to 100%. “Taken by team” is net: what the team took minus what it put back.</p>`;
  el.querySelector('select').value = state.sort;
  el.querySelector('select').addEventListener('change', (e) => {
    state.sort = e.target.value;
    draw();
  });
  el.querySelector('.split-more').addEventListener('click', () => {
    state.all = !state.all;
    draw();
  });
  draw();
}

// ── 2. every round ──
function roundsChart(el, apps) {
  const pts = perRoundTotals(apps).filter((p) => p.allocated > 0 || p.withdrawn > 0);
  if (pts.length < 2) {
    el.hidden = true;
    return;
  }
  // Drawn at the card's real pixel width so text stays 11px on phones too.
  const W = Math.max(280, Math.round(el.clientWidth - 32));
  const H = W < 520 ? 200 : 260;
  const m = { l: 44, r: 12, t: 12, b: 26 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const r0 = pts[0].round;
  const r1 = pts.at(-1).round;
  const top = Math.max(...pts.map((p) => Math.max(p.allocated, p.withdrawn))) || 1;
  const mag = 10 ** Math.floor(Math.log10(top / 4));
  const tickStep = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((st) => st * 4 >= top);
  const yMax = tickStep * 4;
  const x = (r) => m.l + ((r - r0) / Math.max(1, r1 - r0)) * iw;
  const y = (v) => m.t + ih - (v / yMax) * ih;
  const path = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.round).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
  const ticks = [0, 1, 2, 3, 4].map((i) => tickStep * i);
  const xt = [];
  const step = Math.max(1, Math.ceil((r1 - r0) / (W < 520 ? 4 : 7) / 5) * 5);
  for (let r = Math.ceil(r0 / step) * step; r <= r1; r += step) xt.push(r);
  const totalAlloc = pts.reduce((t, p) => t + p.allocated, 0);
  const totalWd = pts.reduce((t, p) => t + p.withdrawn, 0);
  el.innerHTML = `<div class="viz-head"><h3>Every round, all apps</h3></div>
    <div class="viz-legend"><span><span class="sw s1"></span>Allocated to apps</span><span><span class="sw s2"></span>Withdrawn by teams from their rewards pools</span></div>
    <svg viewBox="0 0 ${W} ${H}" class="viz-svg" role="img" aria-label="B3TR allocated to all apps and withdrawn by teams, per round, rounds ${r0} to ${r1}">
      ${ticks.map((t) => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text class="ax" x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join('')}
      ${xt.map((r) => `<text class="ax" x="${x(r)}" y="${H - 8}" text-anchor="${x(r) > W - m.r - 18 ? 'end' : 'middle'}">#${r}</text>`).join('')}
      <path class="ln s1" d="${path('allocated')}"/>
      <path class="ln s2" d="${path('withdrawn')}"/>
      <line class="cross" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>
      <circle class="dot s1" r="4" visibility="hidden"/><circle class="dot s2" r="4" visibility="hidden"/>
      <rect class="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/>
    </svg>
    <p class="fine">B3TR per round, all apps together. Since round #${r0}: ${fmt(totalAlloc)} allocated, ${fmt(totalWd)} withdrawn by teams (${pct((totalWd / (totalAlloc || 1)) * 100)}). Withdrawals are counted in the round they happened. The latest round can still be filling in while apps claim.</p>`;
  const svg = el.querySelector('svg');
  const cross = svg.querySelector('.cross');
  const [d1, d2] = svg.querySelectorAll('.dot');
  const move = (clientX, clientY) => {
    const box = svg.getBoundingClientRect();
    const sx = ((clientX - box.left) / box.width) * W;
    const r = Math.round(r0 + ((sx - m.l) / iw) * (r1 - r0));
    const p = pts.reduce((best, q) => (Math.abs(q.round - r) < Math.abs(best.round - r) ? q : best), pts[0]);
    const px = x(p.round);
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    d1.setAttribute('cx', px);
    d1.setAttribute('cy', y(p.allocated));
    d2.setAttribute('cx', px);
    d2.setAttribute('cy', y(p.withdrawn));
    for (const n of [cross, d1, d2]) n.setAttribute('visibility', 'visible');
    showTip(
      `<strong>Round #${p.round}</strong><br><span class="sw s1"></span>Allocated: ${fmt(p.allocated)} B3TR<br><span class="sw s2"></span>Withdrawn by teams: ${fmt(p.withdrawn)} B3TR`,
      clientX,
      clientY,
    );
  };
  const leave = () => {
    for (const n of [cross, d1, d2]) n.setAttribute('visibility', 'hidden');
    hideTip();
  };
  const hit = svg.querySelector('.hit');
  hit.addEventListener('pointermove', (e) => move(e.clientX, e.clientY));
  hit.addEventListener('pointerdown', (e) => move(e.clientX, e.clientY));
  hit.addEventListener('pointerleave', leave);
}

// ── 4. what teams sold / moved out, in dollars at the time ──
/**
 * One row per team wallet: apps that share a wallet are one row (their flows
 * can't be split), so nothing is counted twice. Ranked by sold + moved out.
 */
export function sellerRows(apps) {
  const by = new Map();
  for (const a of apps) {
    const v = a.valueUsd;
    if (!v) continue;
    const key = [...(a.teamWallets ?? [a.currentTeamWallet ?? a.id])].map((w) => String(w).toLowerCase()).sort().join(',');
    const r = by.get(key) ?? { names: [], sold: 0, other: 0, allocated: 0 };
    r.names.push(a.name.trim());
    // Same wallet → same flows on every app that shares it: take them once.
    r.sold = Math.max(r.sold, v.sold ?? 0);
    r.other = Math.max(r.other, v.toOtherWallets ?? 0);
    r.allocated += v.allocation ?? 0;
    by.set(key, r);
  }
  return [...by.values()].filter((r) => r.sold + r.other > 0).sort((x, y) => y.sold + y.other - (x.sold + x.other));
}

function sellersChart(el, apps) {
  const all = sellerRows(apps);
  if (!all.length) {
    el.hidden = true;
    return;
  }
  const rows = all.slice(0, 15);
  const max = rows[0].sold + rows[0].other || 1;
  const usd = (n) => '$' + fmt(n);
  const totalSold = all.reduce((t, r) => t + r.sold, 0);
  const totalOther = all.reduce((t, r) => t + r.other, 0);
  el.innerHTML = `<div class="viz-head"><h3>Sold or moved out by team wallets, in $ at the time</h3></div>
    <div class="viz-legend"><span><span class="sw s2"></span>Sold (proven swaps)</span><span><span class="sw s4"></span>Sent to other wallets (usually exchanges or payroll)</span></div>
    <div class="users-row users-hd" aria-hidden="true"><span></span><span></span><span class="v">Total</span><span class="sh">Allocated</span></div>
    <div class="users-rows">${rows
      .map((r) => {
        const name = r.names.join(' + ');
        const tipHtml = `<strong>${esc(name)}</strong>${r.names.length > 1 ? ' (one shared wallet)' : ''}<br><span class="sw s2"></span>Sold: ${usd(r.sold)}<br><span class="sw s4"></span>To other wallets: ${usd(r.other)}<br>Allocation was worth ${usd(r.allocated)} when received`;
        return `<div class="users-row" tabindex="0" data-tip="${esc(tipHtml)}">
          <span class="nm">${esc(name)}</span>
          <span class="bar split-bar">${r.sold ? `<i class="s2" style="width:${((r.sold / max) * 100).toFixed(2)}%"></i>` : ''}${r.other ? `<i class="s4" style="width:${((r.other / max) * 100).toFixed(2)}%"></i>` : ''}</span>
          <span class="v">${usd(r.sold + r.other)}</span>
          <span class="sh">${usd(r.allocated)}</span>
        </div>`;
      })
      .join('')}</div>
    <p class="fine">All time, each transfer valued at that day’s B3TR price. All apps: ${usd(totalSold)} sold in proven swaps, ${usd(totalOther)} sent to other wallets. “Sold” only counts swaps we can prove on-chain, so it’s a floor. Apps that share one team wallet are one row. Moving B3TR out isn’t wrong in itself — teams pay real costs — this just shows the size.</p>`;
}

// ── 3. users vs share of the allocation ──
function usersChart(el, data) {
  const u = data.users?.apps;
  if (!u) {
    el.hidden = true;
    return;
  }
  const roundTotal = b3(data.totals?.currentRoundToApps) || 0;
  const rows = data.apps
    .map((a) => ({ a, users: u[a.id.toLowerCase()]?.users30 ?? 0, share: roundTotal && a.current ? (b3(a.current.total) / roundTotal) * 100 : null }))
    .filter((r) => r.users > 0)
    .sort((x, y) => y.users - x.users)
    .slice(0, 15);
  if (!rows.length) {
    el.hidden = true;
    return;
  }
  const max = rows[0].users;
  const eco = data.users.ecosystem?.users30;
  el.innerHTML = `<div class="viz-head"><h3>Users in the last 30 days</h3></div>
    <div class="users-row users-hd" aria-hidden="true"><span></span><span></span><span class="v">Users</span><span class="sh">Round share</span></div>
    <div class="users-rows">${rows
      .map(
        (r) => `<div class="users-row" tabindex="0" data-tip="${esc(`<strong>${esc(r.a.name)}</strong><br>${r.users.toLocaleString()} wallets paid a reward in the last 30 days${r.share === null ? '' : `<br>${r.share.toFixed(1)}% of round #${data.totals.currentRound}’s allocation`}`)}">
          <span class="nm">${esc(r.a.name)}</span>
          <span class="bar"><i class="s1" style="width:${Math.max(0.5, (r.users / max) * 100).toFixed(2)}%"></i></span>
          <span class="v">${r.users.toLocaleString()}</span>
          <span class="sh">${r.share === null ? '—' : `${r.share < 0.1 ? '<0.1' : r.share.toFixed(1)}%`}</span>
        </div>`,
      )
      .join('')}</div>
    <p class="fine">Wallets that got at least one reward from the app in the last 30 days (its own team wallets and endorsers left out). The right column is the app’s share of round #${data.totals.currentRound}’s allocation, so you can compare who has users with who gets the B3TR.${eco ? ` Across all apps: ${eco.toLocaleString()} different wallets.` : ''}</p>`;
}

/**
 * Each chart has its own Active / All apps filter, Active by default
 * (Pokerdutchie, 2026-11-19: active apps are the priority).
 */
function withFilter(card, draw) {
  let mode = 'active';
  const paint = () => {
    draw(mode);
    const head = card.querySelector('.viz-head');
    if (!head) return;
    const f = document.createElement('div');
    f.className = 'viz-filter';
    f.setAttribute('role', 'group');
    f.setAttribute('aria-label', 'Which apps');
    for (const [m, label] of [['active', 'Active apps'], ['all', 'All apps']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(mode === m));
      b.addEventListener('click', () => {
        if (mode === m) return;
        mode = m;
        card.hidden = false;
        paint();
      });
      f.appendChild(b);
    }
    const ctl = head.querySelector('.viz-ctl');
    const box = document.createElement('div');
    box.className = 'viz-ctls';
    box.appendChild(f);
    if (ctl) box.appendChild(ctl);
    head.appendChild(box);
  };
  paint();
  return paint;
}

export function renderCharts(data) {
  const root = document.getElementById('charts');
  if (!root || !data?.apps?.length) return;
  root.innerHTML = `<h2>Charts — all apps</h2>
    <div class="viz-card" id="viz-split"></div>
    <div class="viz-card" id="viz-sellers"></div>
    <div class="viz-card" id="viz-rounds"></div>
    <div class="viz-card" id="viz-users"></div>`;
  const pick = (mode) => (mode === 'all' ? data.apps : data.apps.filter((a) => a.active));
  const splitState = { sort: 'allocated', all: false };
  withFilter(root.querySelector('#viz-split'), (mode) => splitChart(root.querySelector('#viz-split'), pick(mode), splitState));
  withFilter(root.querySelector('#viz-sellers'), (mode) => sellersChart(root.querySelector('#viz-sellers'), pick(mode)));
  const rounds = root.querySelector('#viz-rounds');
  const repaintRounds = withFilter(rounds, (mode) => roundsChart(rounds, pick(mode)));
  let lastW = rounds.clientWidth;
  window.addEventListener('resize', () => {
    if (Math.abs(rounds.clientWidth - lastW) < 40) return;
    lastW = rounds.clientWidth;
    repaintRounds();
  });
  withFilter(root.querySelector('#viz-users'), (mode) => usersChart(root.querySelector('#viz-users'), { ...data, apps: pick(mode) }));
  root.hidden = false;
  // Hover and keyboard focus show the same tooltip for bar rows.
  const at = (e) => e.target.closest?.('[data-tip]');
  root.addEventListener('pointermove', (e) => {
    const t = at(e);
    if (t) showTip(t.dataset.tip, e.clientX, e.clientY);
    else if (!e.target.closest?.('svg')) hideTip();
  });
  root.addEventListener('pointerleave', hideTip);
  root.addEventListener('focusin', (e) => {
    const t = at(e);
    if (!t) return;
    const b = t.getBoundingClientRect();
    showTip(t.dataset.tip, b.left + 20, b.top);
  });
  root.addEventListener('focusout', hideTip);
}
