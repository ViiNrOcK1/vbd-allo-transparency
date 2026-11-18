# VeBetterDAO Allocation Tracker

Where each VeBetterDAO app's B3TR allocation goes: **paid to users, held, or sold**. Every figure is read directly from VeChain mainnet, with no API keys and no private data.

**Live:** https://allocations.b3trbeach.org

**How it works**
- `src/index.mjs` reads the public VeBetterDAO contracts:
  - `X2EarnApps.apps()`
  - `XAllocationPool` → `AllocationRewardsClaimed`
  - `X2EarnRewardsPool` → `NewDeposit`, `TeamWithdrawal`, `totalBalance`
  - B3TR `Transfer` events out of and into every team wallet
  - B3TR and VOT3 `Transfer` events from the Treasury, GrantsManager, Timelock and foundation multisig (grants / DAO payouts)
- **Paid to users** is exact. B3TR can only leave a rewards pool by `distributeReward` (to a user) or `withdraw` (to the team), so: paid = deposited − withdrawn − still in pool.
- **Sold** means the transfer's transaction contained a `Swap` in a pool whose pair includes B3TR. Adding liquidity (`Mint`) is counted separately. Anything unidentified is shown as "other wallet / contract", along with the address, and is never assumed to be a sale.
- **Paid to users excludes rewards an app paid to its own team wallets or to wallets that have endorsed it.** Both go out through the same `distributeReward` call as user rewards. Rewards to its own team count as taken by the team; rewards to its endorsers are shown separately. Endorsers are every wallet that ever endorsed the app (`AppEndorsed`, all contract versions). Users per app exclude both.
- **Sold is a floor.** B3TR moved to another wallet or an exchange and sold there is shown as "other wallet", not as sold.
- **Where the team wallet's B3TR came from** — allocation, pool withdrawals, grants / DAO, purchases, VOT3, other. A grant paid to another wallet and forwarded to the team wallet is traced one hop and shown as "via <address>". Sold % is measured against everything received, not just the allocation. Payments back to the Treasury / GrantsManager (e.g. grant repayments) are labelled "returned to the DAO".
- **Shared wallets:** apps that share a team wallet are flagged. Their sold % is measured against everything that wallet received.
- **Cross-checks:** every run re-reads the same facts from a second on-chain source — `roundEarnings()`, `Emissions.getXAllocationAmount()`, transfers vs. events, the pool's real balance — and shows the result on the page and in the run log.

A GitHub Action runs every 6 hours, rebuilds `site/data/summary.json`, and publishes `site/` to GitHub Pages.

**Run it yourself**
```
npm ci
npm test
node src/index.mjs --out site/data   # optional: --node https://<your thor node>
npx serve site
```

Contract addresses and event signatures come from [vechain/vebetterdao-contracts](https://github.com/vechain/vebetterdao-contracts) (`packages/config/mainnet.ts`).

Built by [B3TR Beach](https://www.b3trbeach.org), itself a VeBetterDAO app. Not financial advice, and not an accusation of anyone.
