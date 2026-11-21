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
  // Stop at the last round whose allocation has been claimed: the round in
  // progress has no allocation yet (it's claimed after the round ends), so
  // drawing it made the line crash to 0 (Vinny, 2026-11-19).
  const all = perRoundTotals(apps);
  const lastClaimed = Math.max(...all.filter((p) => p.allocated > 0).map((p) => p.round), -Infinity);
  const pts = all.filter((p) => p.round <= lastClaimed && (p.allocated > 0 || p.withdrawn > 0));
  if (pts.length < 2) {
    el.hidden = true;
    return;
  }
  // Drawn at the card's real pixel width so text stays 11px on phones too.
  // Card width, falling back to the page width if the card isn't laid out yet.
  const W = Math.max(280, Math.round((el.getBoundingClientRect().width || document.documentElement.clientWidth - 32) - 32));
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
    <p class="fine">B3TR per round, all apps together. Since round #${r0}: ${fmt(totalAlloc)} allocated, ${fmt(totalWd)} withdrawn by teams (${pct((totalWd / (totalAlloc || 1)) * 100)}). Withdrawals are counted in the round they happened. Ends at round #${r1}, the last round whose allocation has been claimed; the round in progress is added once it ends.</p>`;
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

// Lists show the top TOP_N rows, with a button for every app (Vinny,
// 2026-11-19: every active app, and with "All apps" every app ever listed).
const TOP_N = 15;
function showAllButton(el, total, state, repaint) {
  if (total <= TOP_N) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'split-more';
  b.textContent = state.all ? `Show top ${TOP_N}` : `Show all ${total} apps`;
  b.addEventListener('click', () => {
    state.all = !state.all;
    repaint();
  });
  el.querySelector('.users-rows').after(b);
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
  // Every team wallet, including ones that never sold or moved anything out.
  return [...by.values()].sort((x, y) => y.sold + y.other - (x.sold + x.other) || x.names[0].localeCompare(y.names[0]));
}

function sellersChart(el, apps, state = { all: false }, repaint = () => {}) {
  const all = sellerRows(apps);
  if (!all.length) {
    el.hidden = true;
    return;
  }
  const rows = state.all ? all : all.slice(0, TOP_N);
  const max = all[0].sold + all[0].other || 1;
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
          <span class="bar split-bar">${r.sold ? `<i class="s2" style="width:${((r.sold / max) * 100).toFixed(2)}%"></i>` : ''}${r.other ? `<i class="s4" style="width:${((r.other / max) * 100).toFixed(2)}%"></i>` : ''}${!r.sold && !r.other ? '<span class="none">none</span>' : ''}</span>
          <span class="v">${usd(r.sold + r.other)}</span>
          <span class="sh">${usd(r.allocated)}</span>
        </div>`;
      })
      .join('')}</div>
    <p class="fine">All time, each transfer valued at that day’s B3TR price. All apps: ${usd(totalSold)} sold in proven swaps, ${usd(totalOther)} sent to other wallets. “Sold” only counts swaps we can prove on-chain, so it’s a floor. Apps that share one team wallet are one row. Moving B3TR out isn’t wrong in itself — teams pay real costs — this just shows the size.</p>`;
  showAllButton(el, all.length, state, repaint);
}

// ── 3. users vs share of the allocation ──
function usersChart(el, data, state = { all: false }, repaint = () => {}) {
  const u = data.users?.apps;
  if (!u) {
    el.hidden = true;
    return;
  }
  const roundTotal = b3(data.totals?.currentRoundToApps) || 0;
  const rows = data.apps
    .map((a) => {
      const x = u[a.id.toLowerCase()];
      // People = wallets with Passport-linked ones merged (falls back to wallets).
      return { a, wallets: x?.users30 ?? 0, users: x?.people30 ?? x?.users30 ?? 0, share: roundTotal && a.current ? (b3(a.current.total) / roundTotal) * 100 : null };
    })
    // Every app in the filter, including ones with nobody paid this month.
    .sort((x, y) => y.users - x.users || y.wallets - x.wallets || x.a.name.localeCompare(y.a.name));
  const allRows = rows.slice();
  if (!state.all) rows.splice(TOP_N);
  if (!rows.length) {
    el.hidden = true;
    return;
  }
  const eco = data.users.ecosystem ?? {};
  const linked = Boolean(data.users.peopleLinked);
  // Bars are scaled to wallets: the solid part is people, the faded rest is
  // the extra wallets merged into them (Vinny: show both, compactly).
  const max = Math.max(1, ...allRows.map((r) => r.wallets || r.users));
  const dupPct = (r) => (r.wallets > 0 ? Math.round((1 - r.users / r.wallets) * 100) : 0);
  el.innerHTML = `<div class="viz-head"><h3>${linked ? 'Multi-wallet users &amp; connections · last 30 days' : 'Wallets paid in the last 30 days'}</h3></div>
    ${linked ? '<div class="viz-legend"><span><span class="sw s1"></span>People</span><span><span class="sw s1 faded"></span>Extra wallets merged into them</span></div>' : ''}
    <div class="users-row ${linked ? 'ppl ' : ''}users-hd" aria-hidden="true"><span></span><span></span><span class="v">${linked ? 'People' : 'Wallets'}</span>${linked ? '<span class="v">Wallets</span><span class="dp">Dupes</span>' : ''}<span class="sh">Round share</span></div>
    <div class="users-rows">${rows
      .map(
        (r) => `<div class="users-row${linked ? ' ppl' : ''}" tabindex="0" data-tip="${esc(`<strong>${esc(r.a.name)}</strong><br>${linked ? `${r.users.toLocaleString()} people (${r.wallets.toLocaleString()} wallets, linked ones merged)` : `${r.users.toLocaleString()} wallets`} paid a reward in the last 30 days${r.share === null ? '' : `<br>${r.share.toFixed(1)}% of round #${data.totals.currentRound}’s allocation`}`)}">
          <span class="nm">${esc(r.a.name)}</span>
          <span class="bar">${linked ? `<span class="track" style="width:${Math.max(0.5, ((r.wallets || r.users) / max) * 100).toFixed(2)}%"><i class="s1" style="width:${(r.wallets ? (r.users / r.wallets) * 100 : 100).toFixed(2)}%"></i></span>` : `<i class="s1" style="width:${Math.max(0.5, (r.users / max) * 100).toFixed(2)}%"></i>`}</span>
          <span class="v">${r.users.toLocaleString()}</span>
          ${linked ? `<span class="v wl">${r.wallets.toLocaleString()}</span><span class="dp">${dupPct(r) > 0 ? `−${dupPct(r)}%` : '0%'}</span>` : ''}
          <span class="sh">${r.share === null ? '—' : `${r.share < 0.1 ? '<0.1' : r.share.toFixed(1)}%`}</span>
        </div>`,
      )
      .join('')}</div>
    <p class="fine">Who got at least one reward from the app in the last 30 days (not all time; its own team wallets and endorsers left out).${linked ? ' Wallets count as one person when they’re linked in VeBetterDAO’s Passport, when several of them sent most of their rewards to the same wallet, when their first VET/VTHO came from the same wallet and they were set up as a batch for the same app or sent rewards back to it, or when collector wallets passed most of their money on to the same wallet (the usual farm patterns). App and shop payment wallets (e.g. Mugshot subscriptions) and exchanges never link anyone. A few links were checked by hand and are listed with their on-chain evidence in <a href="https://github.com/ViiNrOcK1/vbd-allo-transparency/blob/main/src/reviewed.mjs">src/reviewed.mjs</a>.' : ''}${(() => {
      const sw = data.users.sweeps;
      if (!sw) return '';
      const f = sw.funders;
      return ` In the last 90 days: ${sw.walletsInGroups.toLocaleString()} wallets in ${sw.groups.toLocaleString()} groups that sent their rewards (B3TR or VOT3) to the same wallet${sw.caughtUp ? '' : ` (still reading history: ${sw.coveredDays} of 90 days)`}${f ? `, and ${f.walletsInGroups.toLocaleString()} wallets in ${f.groups.toLocaleString()} groups whose first VET or VTHO came from the same wallet${f.caughtUp ? '' : ` (checked ${f.checkedWallets.toLocaleString()} of ${f.ofWallets.toLocaleString()} wallets so far, so this grows)`}` : ''}. A wallet can be in both.${data.users.groupSizes?.largest?.[0] > 50 ? ` The biggest linked networks have ${data.users.groupSizes.largest.filter((n) => n > 50).map((n) => n.toLocaleString()).join(', ')} reward wallets.` : ''} We count every linked network as one person: deliberate multi-wallet setups are rarely innocent.`;
    })()} Someone running several wallets they never linked still counts several times, so treat this as a ceiling on real users. The right column is the app’s share of round #${data.totals.currentRound}’s allocation, so you can compare who has users with who gets the B3TR.${eco.users30 ? ` Across all apps: ${linked && eco.people30 ? `${eco.people30.toLocaleString()} people from ${eco.users30.toLocaleString()} wallets in 30 days (−${Math.round((1 - eco.people30 / eco.users30) * 100)}%)${eco.people90 ? `; ${eco.people90.toLocaleString()} people from ${eco.users90.toLocaleString()} wallets in 90 days (−${Math.round((1 - eco.people90 / eco.users90) * 100)}%)` : ''}` : `${eco.users30.toLocaleString()} different wallets`}.` : ''}</p>`;
  showAllButton(el, allRows.length, state, repaint);
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
  // Visible BEFORE drawing, so the line chart measures its real width (it was
  // measuring a hidden card and drawing at 280px, then scaling up huge).
  root.hidden = false;
  const splitState = { sort: 'allocated', all: false };
  withFilter(root.querySelector('#viz-split'), (mode) => splitChart(root.querySelector('#viz-split'), pick(mode), splitState));
  const sellersState = { all: false };
  let repaintSellers = () => {};
  repaintSellers = withFilter(root.querySelector('#viz-sellers'), (mode) => sellersChart(root.querySelector('#viz-sellers'), pick(mode), sellersState, () => repaintSellers()));
  const rounds = root.querySelector('#viz-rounds');
  const repaintRounds = withFilter(rounds, (mode) => roundsChart(rounds, pick(mode)));
  let lastW = rounds.clientWidth;
  const onResize = () => {
    if (Math.abs(rounds.clientWidth - lastW) < 40) return;
    lastW = rounds.clientWidth;
    repaintRounds();
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(onResize).observe(rounds);
  else window.addEventListener('resize', onResize);
  const usersState = { all: false };
  let repaintUsers = () => {};
  repaintUsers = withFilter(root.querySelector('#viz-users'), (mode) => usersChart(root.querySelector('#viz-users'), { ...data, apps: pick(mode) }, usersState, () => repaintUsers()));
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
