import { describe, expect, it } from 'vitest';
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, parseAbiParameters } from 'viem';
import { ABI, MAINNET, TOPIC, VBD_CONTRACTS } from '../src/abi.mjs';
import { classifyInflow, classifyOutflow, poolHoldsB3tr, receiptPoolEvents } from '../src/classify.mjs';
import { pct, pickCurrentRound, summarize } from '../src/aggregate.mjs';
import { createThor } from '../src/thor.mjs';

const E18 = 10n ** 18n;
const A = '0x' + 'a'.repeat(64);
const B = '0x' + 'b'.repeat(64);
const W1 = '0x' + '1'.repeat(40);
const W2 = '0x' + '2'.repeat(40);
const POOL = '0x' + '9'.repeat(40);
const XAP = MAINNET.xAllocationPool.toLowerCase();

describe('event signatures', () => {
  it('AllocationRewardsClaimed topic matches the ABI and decodes a real-shaped log', () => {
    const topics = encodeEventTopics({
      abi: ABI,
      eventName: 'AllocationRewardsClaimed',
      args: { appId: A, recipient: W1 },
    });
    expect(topics[0]).toBe(TOPIC.claimed);
    const data = encodeAbiParameters(parseAbiParameters('uint256,uint256,address,uint256,uint256,uint256'), [
      42n,
      1000n * E18,
      W2,
      0n,
      300n * E18,
      700n * E18,
    ]);
    const { args } = decodeEventLog({ abi: ABI, topics, data });
    expect(args.roundId).toBe(42n);
    expect(args.teamAllocationAmount).toBe(300n * E18);
    expect(args.rewardsAllocationAmount).toBe(700n * E18);
    expect(args.recipient.toLowerCase()).toBe(W1);
  });

  it('pool and transfer topics are the standard ones', () => {
    expect(TOPIC.transfer).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
    expect(TOPIC.swapV2).toBe('0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822');
    expect(TOPIC.deposit).toBe(encodeEventTopics({ abi: ABI, eventName: 'NewDeposit' })[0]);
    expect(TOPIC.withdrawal).toBe(encodeEventTopics({ abi: ABI, eventName: 'TeamWithdrawal' })[0]);
  });
});

describe('thor.logs pagination', () => {
  const mk = (block, i) => ({
    address: MAINNET.b3tr,
    topics: [TOPIC.transfer],
    data: '0x',
    meta: { blockNumber: block, txID: `0x${block}-${i}`, clauseIndex: 0, logIndex: i },
  });

  it('advances the block range past 1,000 and drops the boundary block it already has', async () => {
    const all = [];
    for (let i = 0; i < 1500; i++) all.push(mk(100 + Math.floor(i / 10), i));
    const calls = [];
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.range.from);
      const page = all.filter((l) => l.meta.blockNumber >= body.range.from).slice(0, 1000);
      return new Response(JSON.stringify(page));
    };
    const thor = createThor({ fetchImpl, node: 'https://x' });
    const out = await thor.logs([{}], 0, 999);
    expect(out).toHaveLength(1500);
    expect(new Set(out.map((l) => l.meta.txID)).size).toBe(1500);
    expect(calls.length).toBeGreaterThan(1);
  });

  it('keeps two identical transfers in one clause (distinct logIndex)', async () => {
    const twin = (i) => ({ address: 'x', topics: ['t'], data: '0x1', meta: { blockNumber: 1, txID: '0xt', clauseIndex: 0, logIndex: i } });
    const fetchImpl = async () => new Response(JSON.stringify([twin(0), twin(1)]));
    const out = await createThor({ fetchImpl, node: 'https://x' }).logs([{}], 0, 10);
    expect(out).toHaveLength(2);
  });

  it('retries a 5xx and gives up on a 4xx', async () => {
    let n = 0;
    const flaky = async () => (++n < 2 ? new Response('busy', { status: 503 }) : new Response('[]'));
    expect(await createThor({ fetchImpl: flaky, node: 'https://x', retries: 2 }).logs([{}], 0, 1)).toEqual([]);
    let m = 0;
    const bad = async () => {
      m++;
      return new Response('no', { status: 400 });
    };
    await expect(createThor({ fetchImpl: bad, node: 'https://x', retries: 3 }).logs([{}], 0, 1)).rejects.toThrow(/400/);
    expect(m).toBe(1);
  });
});

describe('classifyOutflow — nobody is labelled a seller without a swap', () => {
  const base = { ownWallets: new Set([W1, W2]), vbdContracts: VBD_CONTRACTS, b3trPools: new Set([POOL]) };

  it('a swap in a B3TR pool in the same tx is a sale', () => {
    const poolEvents = { swaps: new Set([POOL]), mints: new Set() };
    expect(classifyOutflow({ ...base, to: '0x' + '7'.repeat(40), isContract: true, poolEvents })).toBe('sold');
  });

  it('adding liquidity is not a sale', () => {
    const poolEvents = { swaps: new Set(), mints: new Set([POOL]) };
    expect(classifyOutflow({ ...base, to: POOL, isContract: true, poolEvents })).toBe('liquidity');
  });

  it('a swap in a pool WITHOUT B3TR is not a B3TR sale', () => {
    const poolEvents = { swaps: new Set(['0x' + '8'.repeat(40)]), mints: new Set() };
    expect(classifyOutflow({ ...base, to: '0x' + '7'.repeat(40), isContract: true, poolEvents })).toBe('other_contract');
  });

  it('VeBetterDAO destinations and own wallets are named', () => {
    expect(classifyOutflow({ ...base, to: MAINNET.x2EarnRewardsPool, isContract: true, poolEvents: null })).toBe('rewards_pool');
    expect(classifyOutflow({ ...base, to: MAINNET.vot3, isContract: true, poolEvents: null })).toBe('vot3');
    expect(classifyOutflow({ ...base, to: W2.toUpperCase().replace('0X', '0x'), isContract: false, poolEvents: null })).toBe('internal');
  });

  it('an unknown plain wallet is just "other wallet"', () => {
    expect(classifyOutflow({ ...base, to: '0x' + '6'.repeat(40), isContract: false, poolEvents: null })).toBe('other_wallet');
  });
});

describe('receipts and pools', () => {
  it('collects Swap and Mint emitters', () => {
    const r = { outputs: [{ events: [
      { address: POOL.toUpperCase().replace('0X', '0x'), topics: [TOPIC.swapV2] },
      { address: '0x' + '5'.repeat(40), topics: [TOPIC.mintV2] },
      { address: MAINNET.b3tr, topics: [TOPIC.transfer] },
    ] }] };
    const { swaps, mints } = receiptPoolEvents(r);
    expect([...swaps]).toEqual([POOL]);
    expect([...mints]).toEqual(['0x' + '5'.repeat(40)]);
  });

  it('poolHoldsB3tr', () => {
    expect(poolHoldsB3tr(MAINNET.b3tr.toLowerCase(), '0x1', MAINNET.b3tr)).toBe(true);
    expect(poolHoldsB3tr('0x1', '0x2', MAINNET.b3tr)).toBe(false);
    expect(poolHoldsB3tr(null, null, MAINNET.b3tr)).toBe(false);
  });
});

describe('summarize', () => {
  const apps = [
    { id: A, name: 'Alpha', active: true, teamWallet: W1, teamAllocationPercentage: 30 },
    { id: B, name: 'Beta', active: true, teamWallet: W2, teamAllocationPercentage: 0 },
  ];
  const claims = [
    { appId: A, round: 1, total: 1000n * E18, toTeam: 300n * E18, toPool: 700n * E18, unallocated: 0n, recipient: W1 },
    { appId: A, round: 2, total: 500n * E18, toTeam: 150n * E18, toPool: 350n * E18, unallocated: 0n, recipient: W1 },
    { appId: B, round: 2, total: 200n * E18, toTeam: 0n, toPool: 200n * E18, unallocated: 0n, recipient: W2 },
  ];
  const deposits = [
    { appId: A, amount: 700n * E18, depositor: XAP },
    { appId: A, amount: 350n * E18, depositor: XAP },
    { appId: A, amount: 50n * E18, depositor: W1 },
    { appId: B, amount: 200n * E18, depositor: XAP },
  ];
  const withdrawals = [{ appId: A, amount: 100n * E18, teamWallet: W1, reason: 'ops' }];
  const poolBalances = { [A]: 200n * E18, [B]: 200n * E18 };
  const wallets = {
    [W1]: {
      balance: 10n * E18,
      outflows: [
        { to: POOL, value: 400n * E18, kind: 'sold' },
        { to: MAINNET.x2EarnRewardsPool.toLowerCase(), value: 50n * E18, kind: 'rewards_pool' },
      ],
    },
    [W2]: { balance: 0n, outflows: [] },
  };
  const s = summarize({ apps, claims, deposits, withdrawals, poolBalances, wallets, xAllocationPool: MAINNET.xAllocationPool });
  const alpha = s.apps.find((a) => a.id === A);
  const beta = s.apps.find((a) => a.id === B);

  it('paid to users = deposits − team withdrawals − pool balance', () => {
    // 1100 in, 100 withdrawn, 200 left → 800 paid out.
    expect(alpha.rewardsPool.paidToUsers).toBe((800n * E18).toString());
    expect(alpha.rewardsPool.depositsByTeam).toBe((50n * E18).toString());
    expect(beta.rewardsPool.paidToUsers).toBe('0');
  });

  it('allocation and ratios', () => {
    expect(alpha.allocation.total).toBe((1500n * E18).toString());
    expect(alpha.rounds).toBe(2);
    expect(alpha.ratios.teamSharePct).toBe(30);
    // sold 400 of (450 team share + 100 withdrawn) = 72.7%
    expect(alpha.ratios.soldPctOfTeamReceipts).toBe(72.7);
    expect(beta.ratios.soldPctOfTeamReceipts).toBe(null);
    // 450 official share + 100 withdrawn, of 1500 allocated.
    expect(alpha.ratios.takenByTeamPct).toBe(36.6);
    expect(s.totals.withdrawnByTeams).toBe((100n * E18).toString());
  });

  it('flags apps that share a team wallet', () => {
    const shared = summarize({
      apps: [apps[0], { ...apps[1], teamWallet: W1 }],
      claims: [],
      deposits: [],
      withdrawals: [],
      poolBalances: {},
      wallets: { [W1]: wallets[W1] },
      xAllocationPool: MAINNET.xAllocationPool,
    });
    expect(shared.apps[0].sharedWalletWith).toEqual([B]);
    // Sold % is against the GROUP's receipts, so it can't exceed what the wallet got.
    const withClaims = summarize({
      apps: [apps[0], { ...apps[1], teamWallet: W1 }],
      claims: [
        { appId: A, round: 1, total: 1000n * E18, toTeam: 400n * E18, toPool: 600n * E18, unallocated: 0n, recipient: W1 },
        { appId: B, round: 1, total: 1000n * E18, toTeam: 400n * E18, toPool: 600n * E18, unallocated: 0n, recipient: W1 },
      ],
      deposits: [],
      withdrawals: [],
      poolBalances: {},
      wallets: { [W1]: wallets[W1] },
      xAllocationPool: MAINNET.xAllocationPool,
    });
    expect(withClaims.apps[0].ratios.soldPctOfTeamReceipts).toBe(50);
    expect(withClaims.apps[0].teamWallet.receivedByWalletGroup).toBe((800n * E18).toString());
    // Totals count the wallet once, not once per app.
    expect(shared.totals.sold).toBe((400n * E18).toString());
  });

  it('latest round total is apps-only and from the newest round', () => {
    expect(s.totals.latestRound).toBe('2');
    expect(s.totals.latestRoundToApps).toBe((700n * E18).toString()); // 500 + 200 in round 2
  });

  it('current round: newest when nearly fully claimed, else the one before', () => {
    const mk = (round, n) => Array.from({ length: n }, () => ({ round }));
    expect(pickCurrentRound([...mk(123, 70), ...mk(124, 66)])).toBe(124); // 94%
    expect(pickCurrentRound([...mk(123, 70), ...mk(124, 10)])).toBe(123); // just ended, half-claimed
    expect(pickCurrentRound(mk(5, 3))).toBe(5);
    expect(pickCurrentRound([])).toBe(0);
    // In the fixture both apps claimed round 2 (2 of 2 vs 1 in round 1).
    expect(s.totals.currentRound).toBe('2');
    expect(alpha.current).toMatchObject({ round: 2, total: (500n * E18).toString() });
  });

  it('pct', () => {
    expect(pct(1n, 3n)).toBe(33.3);
    expect(pct(1n, 0n)).toBe(null);
  });
});

describe('outflows back to the DAO', () => {
  it('a payment to the Treasury or GrantsManager is a return to the DAO, not "other"', () => {
    const c = (to) => classifyOutflow({ to, ownWallets: new Set([W1]), vbdContracts: VBD_CONTRACTS, isContract: true, poolEvents: null, b3trPools: new Set() });
    expect(c(MAINNET.treasury)).toBe('to_dao');
    expect(c(MAINNET.grantsManager)).toBe('to_dao');
    expect(c(MAINNET.timelock)).toBe('to_dao');
    expect(c(MAINNET.b3trMultiSig)).toBe('to_dao');
    expect(c(MAINNET.voterRewards)).toBe('vbd_contract');
  });
});

describe('inflows (grants are not allocation)', () => {
  const own = new Set([W1]);
  it('labels each source literally', () => {
    const c = (from, extra = {}) => classifyInflow({ from, ownWallets: own, vbdContracts: VBD_CONTRACTS, isContract: false, isB3trPool: false, ...extra });
    expect(c(XAP)).toBe('allocation');
    expect(c(MAINNET.x2EarnRewardsPool)).toBe('pool_withdrawal');
    expect(c(MAINNET.grantsManager)).toBe('grants_dao');
    expect(c(MAINNET.treasury)).toBe('grants_dao');
    expect(c(MAINNET.timelock)).toBe('grants_dao');
    expect(c(MAINNET.b3trMultiSig.toUpperCase().replace('0X', '0x'))).toBe('grants_dao');
    expect(c(MAINNET.vot3)).toBe('from_vot3');
    expect(c(MAINNET.voterRewards)).toBe('vbd_other');
    expect(c(W1)).toBe('internal');
    expect(c(POOL, { isContract: true, isB3trPool: true })).toBe('bought');
    expect(c(POOL, { isContract: true })).toBe('other_contract');
    expect(c(W2)).toBe('other_wallet');
  });

  it('a sold grant is measured against everything received, and the grant is shown', () => {
    const s = summarize({
      apps: [{ id: A, name: 'Beach', active: true, teamWallet: W1, teamAllocationPercentage: 0 }],
      claims: [{ appId: A, round: 1, total: 100n * E18, toTeam: 0n, toPool: 100n * E18, unallocated: 0n, recipient: W1, at: 100 }],
      deposits: [{ appId: A, amount: 100n * E18, depositor: XAP }],
      withdrawals: [{ appId: A, amount: 10n * E18, teamWallet: W1, reason: '', at: 50 }],
      poolBalances: { [A]: 0n },
      wallets: {
        [W1]: {
          balance: 0n,
          inflows: [
            { from: MAINNET.x2EarnRewardsPool.toLowerCase(), value: 10n * E18, kind: 'pool_withdrawal' },
            { from: MAINNET.grantsManager, value: 600n * E18, kind: 'grants_dao' },
          ],
          outflows: [{ to: POOL, value: 605n * E18, kind: 'sold', txId: '0xabc', at: 200 }],
        },
      },
      xAllocationPool: MAINNET.xAllocationPool,
    });
    const tw = s.apps[0].teamWallet;
    expect(tw.received.grants_dao).toBe((600n * E18).toString());
    expect(tw.receivedExternal).toBe((610n * E18).toString());
    // Before: 605 sold / 10 received = 6050%. Now against all 610 received.
    expect(s.apps[0].ratios.soldPctOfTeamReceipts).toBe(99.1);
    expect(s.apps[0].ratios.grantsShareOfReceiptsPct).toBe(98.3);
    expect(tw.largestSales).toEqual([{ txId: '0xabc', at: 200, amount: (605n * E18).toString() }]);
    expect(tw.topSenders[0]).toMatchObject({ kind: 'grants_dao', count: 1 });
    // Withdrawal at t=50 lands in round 1 (its first claim is at t=100).
    expect(s.apps[0].perRound).toEqual([{ round: 1, total: (100n * E18).toString(), withdrawn: (10n * E18).toString() }]);
  });

  it('a grant paid to another wallet and forwarded is traced one hop', () => {
    const FOUNDER = '0x' + '3'.repeat(40);
    const s = summarize({
      apps: [{ id: A, name: 'Beach', active: true, teamWallet: W1, teamAllocationPercentage: 0 }],
      claims: [],
      deposits: [],
      withdrawals: [],
      poolBalances: {},
      wallets: {
        [W1]: {
          balance: 0n,
          inflows: [
            { from: FOUNDER, value: 800n * E18, kind: 'other_wallet' },
            { from: MAINNET.vot3.toLowerCase(), value: 400n * E18, kind: 'from_vot3' },
          ],
          outflows: [],
        },
      },
      xAllocationPool: MAINNET.xAllocationPool,
      // The founder got 600 as a grant (forwarded 800: 200 of it from elsewhere);
      // the team wallet got a 500 VOT3 grant and converted 400 of it.
      grantsTo: { [FOUNDER]: { b3tr: 600n * E18, vot3: 0n }, [W1]: { b3tr: 0n, vot3: 500n * E18 } },
    });
    const g = s.apps[0].teamWallet.grants;
    expect(g.direct).toBe((400n * E18).toString());
    expect(g.via[0]).toMatchObject({ address: FOUNDER, counted: (600n * E18).toString() });
    expect(g.total).toBe((1000n * E18).toString());
    expect(s.apps[0].ratios.grantsShareOfReceiptsPct).toBe(83.3);
  });

  it('a withdrawal to a wallet that never got a claim is still that app’s wallet', () => {
    const s = summarize({
      apps: [{ id: A, name: 'X', active: true, teamWallet: W1, teamAllocationPercentage: 0 }],
      claims: [],
      deposits: [],
      withdrawals: [{ appId: A, amount: 5n * E18, teamWallet: W2, reason: '', at: 1 }],
      poolBalances: {},
      wallets: { [W2]: { balance: 0n, inflows: [], outflows: [{ to: POOL, value: 5n * E18, kind: 'sold', txId: '0x1' }] } },
      xAllocationPool: MAINNET.xAllocationPool,
    });
    expect(s.apps[0].teamWallets).toContain(W2);
    expect(s.apps[0].teamWallet.sent.sold).toBe((5n * E18).toString());
  });
});
