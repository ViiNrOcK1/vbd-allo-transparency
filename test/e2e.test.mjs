// The whole indexer against a fake Thor node that answers with properly
// ABI-encoded data: apps(), claims, deposits, withdrawals, balances, a team
// wallet that sells into a B3TR pool, re-deposits, and pays a person.
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionResult, decodeFunctionData, pad, parseAbiParameters } from 'viem';
import { ABI, MAINNET, TOPIC } from '../src/abi.mjs';

const E = 10n ** 18n;
const APP = '0x' + 'a'.repeat(64);
const TEAM = '0x' + '1'.repeat(40);
const POOL = '0x' + '9'.repeat(40);
const ROUTER = '0x' + '8'.repeat(40);
const PERSON = '0x' + '6'.repeat(40);
const lc = (a) => a.toLowerCase();

function log(address, topics, data, block, tx, i = 0) {
  return { address, topics, data, meta: { blockNumber: block, blockTimestamp: 1, txID: tx, txOrigin: TEAM, clauseIndex: 0, logIndex: i } };
}

const claim = log(
  MAINNET.xAllocationPool,
  encodeEventTopics({ abi: ABI, eventName: 'AllocationRewardsClaimed', args: { appId: APP, recipient: TEAM } }),
  encodeAbiParameters(parseAbiParameters('uint256,uint256,address,uint256,uint256,uint256'), [5n, 1000n * E, TEAM, 0n, 300n * E, 700n * E]),
  10, '0xc1',
);
const deposit = log(
  MAINNET.x2EarnRewardsPool,
  encodeEventTopics({ abi: ABI, eventName: 'NewDeposit', args: { appId: APP, depositor: MAINNET.xAllocationPool } }),
  encodeAbiParameters(parseAbiParameters('uint256'), [700n * E]),
  10, '0xc1', 1,
);
const transfer = (to, value, tx, i) =>
  log(MAINNET.b3tr, encodeEventTopics({ abi: ABI, eventName: 'Transfer', args: { from: TEAM, to } }), encodeAbiParameters(parseAbiParameters('uint256'), [value]), 20 + i, tx, i);
const outflows = [
  transfer(ROUTER, 100n * E, '0xs1', 0), // sold via a router → swap in B3TR pool
  transfer(MAINNET.x2EarnRewardsPool, 50n * E, '0xd1', 1),
  transfer(PERSON, 20n * E, '0xp1', 2),
];

function rpc(body) {
  const { to, data } = body.clauses[0];
  const t = lc(to);
  const ret = (functionName, value) => ({ data: encodeFunctionResult({ abi: ABI, functionName, result: value }), reverted: false });
  const { functionName, args } = decodeFunctionData({ abi: ABI, data });
  if (t === lc(MAINNET.x2EarnApps) && functionName === 'apps')
    return ret('apps', [{ id: APP, teamWalletAddress: TEAM, name: 'Alpha', metadataURI: 'x', createdAtTimestamp: 1n, appAvailableForAllocationVoting: true }]);
  if (functionName === 'teamAllocationPercentage') return ret('teamAllocationPercentage', 30n);
  if (functionName === 'totalBalance') return ret('totalBalance', 100n * E);
  if (functionName === 'balanceOf') return ret('balanceOf', 130n * E);
  if (t === lc(POOL) && functionName === 'token0') return ret('token0', MAINNET.b3tr);
  if (t === lc(POOL) && functionName === 'token1') return ret('token1', '0x' + '4'.repeat(40));
  void args;
  return { data: '0x', reverted: true };
}

function startNode() {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    const send = (x) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(x)); };
    if (req.url === '/blocks/best') return send({ number: 100, timestamp: 1 });
    if (req.url === '/accounts/*') return send([rpc(body)]);
    if (req.url.startsWith('/accounts/') && req.url.endsWith('/code')) {
      const a = lc(req.url.split('/')[2]);
      return send({ code: a === lc(ROUTER) || a === lc(POOL) ? '0x6080' : '0x' });
    }
    if (req.url.startsWith('/transactions/')) {
      const tx = req.url.split('/')[2];
      return send({ outputs: tx === '0xs1' ? [{ events: [{ address: POOL, topics: [TOPIC.swapV2], data: '0x' }] }] : [] });
    }
    if (req.url === '/logs/event') {
      const c = body.criteriaSet[0];
      if (lc(c.address) === lc(MAINNET.xAllocationPool)) return send([claim]);
      if (lc(c.address) === lc(MAINNET.x2EarnRewardsPool) && c.topic0 === TOPIC.deposit) return send([deposit]);
      if (lc(c.address) === lc(MAINNET.x2EarnRewardsPool)) return send([]);
      if (lc(c.address) === lc(MAINNET.b3tr) && c.topic1 === pad(TEAM, { size: 32 })) return send(outflows);
      return send([]);
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

describe('indexer end to end (fake node)', () => {
  it('produces the right summary', async () => {
    const server = await startNode();
    const dir = await mkdtemp(join(tmpdir(), 'vbd-'));
    try {
      await new Promise((resolve, reject) =>
        execFile(
          process.execPath,
          [join(process.cwd(), 'src/index.mjs'), '--node', `http://127.0.0.1:${server.address().port}`, '--out', join(dir, 'data')],
          { cwd: dir },
          (err, stdout, stderr) => (err ? reject(new Error(stderr || stdout)) : resolve()),
        ),
      );
      const s = JSON.parse(await readFile(join(dir, 'data/summary.json'), 'utf8'));
      const a = s.apps[0];
      expect(a.name).toBe('Alpha');
      expect(a.teamAllocationPercentage).toBe(30);
      expect(a.allocation.total).toBe((1000n * E).toString());
      expect(a.rewardsPool.paidToUsers).toBe((600n * E).toString()); // 700 in, 0 out, 100 left
      expect(a.teamWallet.sent.sold).toBe((100n * E).toString());
      expect(a.teamWallet.sent.rewards_pool).toBe((50n * E).toString());
      expect(a.teamWallet.sent.other_wallet).toBe((20n * E).toString());
      expect(a.ratios.soldPctOfTeamReceipts).toBe(33.3);
      expect(s.totals.sold).toBe((100n * E).toString());
    } finally {
      server.close();
    }
  }, 30000);
});
