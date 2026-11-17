// Contracts and events, from vechain/vebetterdao-contracts (packages/config/mainnet.ts
// and the contract interfaces). The event signatures are identical in every
// deprecated version (V1–V8), so one ABI decodes the whole history.

import { parseAbi, toEventSelector } from 'viem';

export const MAINNET = {
  b3tr: '0x5ef79995FE8a89e0812330E4378eB2660ceDe699',
  vot3: '0x76Ca782B59C74d088C7D2Cce2f211BC00836c602',
  xAllocationPool: '0x4191776F05f4bE4848d3f4d587345078B439C7d3',
  x2EarnApps: '0x8392B7CCc763dB03b47afcD8E8f5e24F9cf0554D',
  x2EarnRewardsPool: '0x6Bee7DDab6c99d5B2Af0554EaEA484CE18F52631',
  treasury: '0xD5903BCc66e439c753e525F8AF2FeC7be2429593',
  dbaPool: '0x98c1d097c39969bb5de754266f60d22bd105b368',
  voterRewards: '0x838A33AF756a6366f93e201423E1425f67eC0Fa7',
  emissions: '0xDf94739bd169C84fe6478D8420Bb807F1f47b135',
  b3trGovernor: '0x1c65C25fABe2fc1bCb82f253fA0C916a322f777C',
  grantsManager: '0x055d20914657834c914d7c44bf65b566ab4b45a2',
  timelock: '0x7B7EaF620d88E38782c6491D7Ce0B8D8cF3227e4',
  b3trMultiSig: '0x4Dd13fcb7b4f7DC19048ce0d23aAEbbDB3f3a1d9',
};

/**
 * Where grants and other DAO / foundation money comes FROM (lower-case).
 * GrantsManager pays milestone grants; the Treasury and Timelock pay what
 * governance proposals approve; the B3TR multisig is the foundation's.
 * B3TR arriving from any of these is "grants / DAO", not allocation.
 */
export const GRANT_SOURCES = new Set(
  [MAINNET.grantsManager, MAINNET.treasury, MAINNET.timelock, MAINNET.b3trMultiSig].map((a) => a.toLowerCase()),
);

/** VeBetterDAO's own contracts, by lower-case address → label. */
export const VBD_CONTRACTS = Object.fromEntries(
  Object.entries({
    [MAINNET.x2EarnRewardsPool]: 'rewards_pool',
    [MAINNET.vot3]: 'vot3',
    [MAINNET.treasury]: 'vbd_contract',
    [MAINNET.dbaPool]: 'vbd_contract',
    [MAINNET.voterRewards]: 'vbd_contract',
    [MAINNET.emissions]: 'vbd_contract',
    [MAINNET.b3trGovernor]: 'vbd_contract',
    [MAINNET.grantsManager]: 'vbd_contract',
    [MAINNET.xAllocationPool]: 'vbd_contract',
  }).map(([a, l]) => [a.toLowerCase(), l]),
);

export const ABI = parseAbi([
  // X2EarnApps
  'function apps() view returns ((bytes32 id, address teamWalletAddress, string name, string metadataURI, uint256 createdAtTimestamp, bool appAvailableForAllocationVoting)[])',
  'function teamAllocationPercentage(bytes32 appId) view returns (uint256)',
  // XAllocationPool
  'event AllocationRewardsClaimed(bytes32 indexed appId, uint256 roundId, uint256 totalAmount, address indexed recipient, address caller, uint256 unallocatedAmount, uint256 teamAllocationAmount, uint256 rewardsAllocationAmount)',
  // X2EarnRewardsPool
  'event NewDeposit(uint256 amount, bytes32 indexed appId, address indexed depositor)',
  'event TeamWithdrawal(uint256 amount, bytes32 indexed appId, address indexed teamWallet, address withdrawer, string reason)',
  'function totalBalance(bytes32 appId) view returns (uint256)',
  // Cross-checks (independent views of what the events say)
  'function roundEarnings(uint256 roundId, bytes32 appId) view returns (uint256 totalAmount, uint256 unallocatedAmount, uint256 teamAllocationAmount, uint256 x2EarnRewardsPoolAmount)',
  'function getXAllocationAmount(uint256 cycle) view returns (uint256)',
  // ERC-20
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address) view returns (uint256)',
  // Uniswap-V2-style pools (Vexchange V2, VeRocket, BetterSwap … are V2 forks)
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function symbol() view returns (string)',
  'event Sync(uint112 reserve0, uint112 reserve1)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
]);

export const TOPIC = {
  claimed: toEventSelector(
    'AllocationRewardsClaimed(bytes32,uint256,uint256,address,address,uint256,uint256,uint256)',
  ),
  deposit: toEventSelector('NewDeposit(uint256,bytes32,address)'),
  withdrawal: toEventSelector('TeamWithdrawal(uint256,bytes32,address,address,string)'),
  transfer: toEventSelector('Transfer(address,address,uint256)'),
  swapV2: toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)'),
  mintV2: toEventSelector('Mint(address,uint256,uint256)'),
  sync: toEventSelector('Sync(uint112,uint112)'),
  // Uniswap V3 pools, in case one exists for B3TR.
  swapV3: toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)'),
};
