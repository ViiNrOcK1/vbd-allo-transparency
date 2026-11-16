# VeBetterDAO Allocation Tracker

Where each VeBetterDAO app's B3TR allocation goes: **paid to users, held, or sold**. Every figure is read directly from VeChain mainnet, with no API keys and no private data.

**How it works**
- `src/index.mjs` reads the public VeBetterDAO contracts:
  - `X2EarnApps.apps()`
  - `XAllocationPool` → `AllocationRewardsClaimed`
  - `X2EarnRewardsPool` → `NewDeposit`, `TeamWithdrawal`, `totalBalance`
  - B3TR `Transfer` events out of every team wallet
- **Paid to users** is exact. B3TR can only leave a rewards pool by `distributeReward` (to a user) or `withdraw` (to the team), so: paid = deposited − withdrawn − still in pool.
- **Sold** means the transfer's transaction contained a `Swap` in a pool whose pair includes B3TR. Adding liquidity (`Mint`) is counted separately. Anything unidentified is shown as "other wallet / contract", along with the address, and is never assumed to be a sale.
- **Shared wallets:** apps that share a team wallet are flagged. Their sold % is measured against everything that wallet received.

A GitHub Action runs daily, rebuilds `site/data/summary.json`, and publishes `site/` to GitHub Pages.

**Run it yourself**
```
npm ci
npm test
node src/index.mjs --out site/data   # optional: --node https://<your thor node>
npx serve site
```

Contract addresses and event signatures come from [vechain/vebetterdao-contracts](https://github.com/vechain/vebetterdao-contracts) (`packages/config/mainnet.ts`).

Built by [B3TR Beach](https://www.b3trbeach.org), itself a VeBetterDAO app. Not financial advice, and not an accusation of anyone.
