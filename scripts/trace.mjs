// Every B3TR movement in and out of the given wallets, with what each sale
// actually returned. For reconciling a team's own books with the chain.
//
//   node scripts/trace.mjs site/data/summary.json 0xWALLET [0xWALLET …]
//
// Run it locally, not in this repo's Actions: Actions logs on a public repo
// are public, and a trace can name people's personal wallets.
//
// Sale proceeds are read from the transaction itself: VET (native transfers)
// and tokens that came back to the wallet in the same transaction, valued at
// that day's VET/USD. Everything else is valued at that day's B3TR price.
import { readFile, appendFile } from 'node:fs/promises';
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, pad } from 'viem';
import { ABI, MAINNET, TOPIC } from '../src/abi.mjs';
import { createThor } from '../src/thor.mjs';
import { dayOf, seriesLookup } from '../src/prices.mjs';

const [summaryPath, ...rawArgs] = process.argv.slice(2);
const wallets = rawArgs.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
const d = JSON.parse(await readFile(summaryPath, 'utf8'));
const b3trUsd = seriesLookup(d.prices?.b3trUsd ?? {});
const vetUsd = seriesLookup(d.prices?.vetUsd ?? {});
const thor = createThor({ log: () => {} });
const B3TR = MAINNET.b3tr.toLowerCase();
const num = (wei) => Number(BigInt(wei) / 10n ** 12n) / 1e6;
const money = (n) => (n == null ? '   n/a' : '$' + n.toFixed(2));
const symbols = {};
async function symbol(token) {
  if (!(token in symbols)) {
    const data = await thor.call(token, encodeFunctionData({ abi: ABI, functionName: 'symbol' })).catch(() => null);
    symbols[token] = data ? decodeFunctionResult({ abi: ABI, functionName: 'symbol', data }) : token.slice(0, 8);
  }
  return symbols[token];
}
const known = Object.fromEntries(Object.entries(MAINNET).map(([k, v]) => [v.toLowerCase(), k]));
const label = (a) => known[a] ?? (wallets.map((w) => w.toLowerCase()).includes(a) ? `(traced ${a.slice(0, 6)})` : a);

const lines = [];
for (const raw of wallets) {
  const w = raw.toLowerCase();
  const [outs, ins] = await Promise.all([
    thor.logs([{ address: MAINNET.b3tr, topic0: TOPIC.transfer, topic1: pad(w, { size: 32 }) }], 0, d.bestBlock),
    thor.logs([{ address: MAINNET.b3tr, topic0: TOPIC.transfer, topic2: pad(w, { size: 32 }) }], 0, d.bestBlock),
  ]);
  const rows = [
    ...ins.map((l) => ({ l, dir: 'IN ' })),
    ...outs.map((l) => ({ l, dir: 'OUT' })),
  ].sort((a, b) => a.l.meta.blockNumber - b.l.meta.blockNumber);
  lines.push('', `═══ ${w} — ${ins.length} in, ${outs.length} out`);
  let soldB3tr = 0;
  let proceedsUsd = 0;
  let inUsd = 0;
  const seenTx = new Set();
  for (const { l, dir } of rows) {
    const e = decodeEventLog({ abi: ABI, topics: l.topics, data: l.data }).args;
    const at = l.meta.blockTimestamp;
    const day = dayOf(at);
    const amt = num(e.value);
    const px = b3trUsd(day);
    const other = label((dir === 'IN ' ? e.from : e.to).toLowerCase());
    let extra = '';
    if (dir === 'OUT' && !seenTx.has(l.meta.txID)) {
      // What came back to this wallet in the same transaction?
      const r = await thor.receipt(l.meta.txID);
      let vet = 0;
      const tokens = {};
      for (const o of r?.outputs ?? []) {
        for (const t of o.transfers ?? []) if (t.recipient.toLowerCase() === w) vet += num(BigInt(t.amount));
        for (const ev of o.events ?? []) {
          if (ev.topics?.[0] !== TOPIC.transfer || ev.topics.length < 3) continue;
          if ('0x' + ev.topics[2].slice(26).toLowerCase() !== w) continue;
          const token = ev.address.toLowerCase();
          if (token === B3TR || token === MAINNET.vot3.toLowerCase()) continue;
          tokens[token] = (tokens[token] ?? 0) + num(BigInt(ev.data));
        }
      }
      const parts = [];
      let usd = 0;
      let priced = true;
      if (vet) (parts.push(`${vet.toFixed(2)} VET`), (usd += vet * (vetUsd(day) ?? NaN)));
      for (const [t, v] of Object.entries(tokens)) {
        const s = await symbol(t);
        parts.push(`${v.toFixed(2)} ${s}`);
        if (/^(v?vet|wvet)$/i.test(s)) usd += v * (vetUsd(day) ?? NaN);
        else if (/usd|glo|dai/i.test(s)) usd += v;
        else priced = false;
      }
      if (parts.length) {
        seenTx.add(l.meta.txID);
        // All B3TR this wallet sent in the tx counts as sold in it.
        const sentInTx = outs.filter((x) => x.meta.txID === l.meta.txID).reduce((a, x) => a + num(decodeEventLog({ abi: ABI, topics: x.topics, data: x.data }).args.value), 0);
        soldB3tr += sentInTx;
        if (Number.isFinite(usd)) proceedsUsd += usd;
        extra = ` ⇒ SALE of ${sentInTx.toFixed(0)} B3TR got back ${parts.join(' + ')} = ${Number.isFinite(usd) ? money(usd) : 'n/a'}${priced ? '' : ' (+ unpriced tokens)'} → ${(usd / sentInTx).toFixed(5)} $/B3TR vs day price ${px?.toFixed(5) ?? 'n/a'}`;
      }
    }
    if (dir === 'IN ' && px) inUsd += amt * px;
    lines.push(`${day} ${dir} ${amt.toFixed(2).padStart(13)} B3TR ${dir === 'IN ' ? 'from' : 'to  '} ${other}  @${px?.toFixed(5) ?? 'n/a'} = ${money(px ? amt * px : null)}  tx ${l.meta.txID}${extra}`);
  }
  lines.push(`  totals: received ≈ ${money(inUsd)} at day prices · sold on-chain ${soldB3tr.toFixed(0)} B3TR for ${money(proceedsUsd)} actually received`);
}
const text = lines.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');
