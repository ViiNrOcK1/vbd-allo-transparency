// A small VeChainThor REST client. Read-only: no keys, no wallet.
//
// Limits from vechain/thor (cmd/thor/flags.go): /logs returns at most 1,000
// per page and refuses offsets past 100,000. So pages advance the BLOCK range
// instead of the offset, and drop the logs of the boundary block already seen.

export const DEFAULT_NODE = 'https://mainnet.vechain.org';
const PAGE = 1000;

export function createThor({ node = DEFAULT_NODE, fetchImpl = fetch, retries = 4, log = () => {} } = {}) {
  const base = node.replace(/\/+$/, '');

  async function request(path, init) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchImpl(`${base}${path}`, init);
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} ${path}`);
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${path}`), { fatal: true });
        return await res.json();
      } catch (error) {
        lastError = error;
        if (error.fatal) break;
        const wait = 500 * 2 ** attempt;
        log(`retry ${attempt + 1} after ${wait}ms: ${error.message}`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastError;
  }

  const post = (path, body) =>
    request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  return {
    async bestBlock() {
      const b = await request('/blocks/best');
      return { number: b.number, timestamp: b.timestamp };
    },

    /**
     * Every log matching `criteriaSet` in [from, to], ascending.
     * Each log: { address, topics, data, meta: { blockNumber, blockTimestamp, txID, txOrigin, clauseIndex } }.
     */
    async logs(criteriaSet, from, to) {
      const out = [];
      const seen = new Set();
      let start = from;
      for (;;) {
        const page = await post('/logs/event', {
          range: { unit: 'block', from: start, to },
          options: { offset: 0, limit: PAGE, includeIndexes: true },
          criteriaSet,
          order: 'asc',
        });
        let added = 0;
        for (const l of page) {
          // logIndex (includeIndexes) makes two identical transfers in one
          // clause two logs, not one.
          const key = `${l.meta.txID}:${l.meta.logIndex ?? `${l.meta.clauseIndex}:${l.topics.join(',')}:${l.data}`}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(l);
          added++;
        }
        if (page.length < PAGE) break;
        const last = page[page.length - 1].meta.blockNumber;
        if (last === start && added === 0) {
          // One block holds ≥1,000 matching logs (a batched payout): page
          // through that single block by offset, then move past it.
          for (let offset = PAGE; ; offset += PAGE) {
            const more = await post('/logs/event', {
              range: { unit: 'block', from: start, to: start },
              options: { offset, limit: PAGE, includeIndexes: true },
              criteriaSet,
              order: 'asc',
            });
            for (const l of more) {
              const key = `${l.meta.txID}:${l.meta.logIndex ?? `${l.meta.clauseIndex}:${l.topics.join(',')}:${l.data}`}`;
              if (seen.has(key)) continue;
              seen.add(key);
              out.push(l);
            }
            if (more.length < PAGE) break;
          }
          if (start >= to) break;
          start += 1;
          continue;
        }
        start = last;
      }
      return out;
    },

    /** eth_call-style read. Returns the hex data, or null when it reverted. */
    async call(to, data) {
      const [r] = await post('/accounts/*', { clauses: [{ to, value: '0x0', data }] });
      return !r || r.reverted ? null : r.data;
    },

    /**
     * The first VET transfer INTO `address` up to block `to` (its first VET
     * funding), or null. { from, at, block }.
     */
    async firstVetIn(address, to) {
      const r = await post('/logs/transfer', {
        range: { unit: 'block', from: 0, to },
        options: { offset: 0, limit: 1 },
        criteriaSet: [{ recipient: address }],
        order: 'asc',
      });
      const l = r?.[0];
      return l ? { from: String(l.sender).toLowerCase(), at: l.meta.blockTimestamp, block: l.meta.blockNumber } : null;
    },

    /** The first log matching one criteria object up to block `to`, or null. */
    async firstLog(criteria, to) {
      const r = await post('/logs/event', {
        range: { unit: 'block', from: 0, to },
        options: { offset: 0, limit: 1 },
        criteriaSet: [criteria],
        order: 'asc',
      });
      return r?.[0] ?? null;
    },

    async hasCode(address) {
      const r = await request(`/accounts/${address}/code`);
      return typeof r.code === 'string' && r.code !== '0x' && r.code.length > 2;
    },

    async receipt(txId) {
      return request(`/transactions/${txId}/receipt`);
    },
  };
}

/** Run `fn` over `items`, `limit` at a time. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
