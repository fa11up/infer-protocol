---
title: Use the terminal
section: guides
order: 1
audience: borrowers
sources:
  - web/src/App.tsx:350-362
  - web/src/App.tsx:425-512
  - web/src/Panes.tsx:43-232
  - web/src/Panes.tsx:233-369
  - web/src/Panes.tsx:388-510
  - web/src/Panes.tsx:511-774
  - web/src/Panes.tsx:776-865
  - web/src/Redemption.tsx:28-379
  - web/src/state.ts:295-308
  - web/src/math.ts:128-212
  - web/src/PriceStatus.tsx:1
  - web/src/BuyUpdate.tsx:1
  - web/src/Charts.tsx:150-510
  - web/src/actions.tsx:120-155
  - web/src/disconnect.tsx:1
  - web/README.md:15-30
---

# Use the terminal

The terminal is a static web page at `/terminal/`. It reads the contracts directly and has no backend. You connect a browser wallet to act; you can read everything without one.

To connect, press **Disconnected** beside an amount box; it is the only connect control. Once connected, the box shows your balance of that token (press it to fill in the whole amount), and a small box with an × appears at the top right of the header: press it to disconnect. The terminal then ignores the wallet's silent reconnect until you connect again.

The terminal has two tab rows. **Monitor** tabs only show figures. **Desk** tabs are where you act. This page explains each tab, what each figure means and what a disabled button is telling you. Contract addresses are listed in [Contracts and addresses](../reference/contracts-and-addresses.md).

## How an action runs

1. Fill in the form and press its button. The button label starts with "Review".
2. The terminal simulates the call. If the contract would refuse, the note under the button says why, with the figure that blocked you.
3. A review dialog shows the target contract, function and inputs. Confirm it and the terminal simulates again, then asks your wallet to sign.
4. The terminal waits for one successful receipt and refreshes.

State is read at one block and refreshed every 15 seconds while the page is visible. A snapshot older than 45 seconds cannot authorise a transaction. Use the refresh control in the status bar if you doubt it.

## Monitor tabs

### Loan book

A chart that places every open position on a collateral-ratio axis, from 100%, with a list of the same positions below it. Circle area is the position's accrued debt; circles stack up and down only to stay apart, so height carries no value. Three bands, which move with the live `mat` and redemption ceiling:

- **Below the required ratio (`mat`): liquidatable.** A keeper may Mark these.
- **From `mat` up to the ceiling: redeemable.** The ceiling is `mat` plus `gap`; a redeemer can name these positions as candidates.
- **Above the ceiling: safe.**

The list can be searched by name or address, filtered by band and sorted, and shows each position's ratio, debt and liquidation price. Clicking a circle finds and highlights its row; selecting a row opens the position in the Keeper tab. Names are labels derived from public addresses and can repeat. The line under the list gives the block range the terminal read owners from. "Coverage unverified" means the terminal could not read the full history, so the count is unknown; it does not mean the book is empty.

### Oracle

The top of the tab shows three IMD prices in dollars:

- **Primary:** the price the vault uses, the attested median of IMD's pool over a block window, through Chainlink ETH/USD.
- **Spot:** the attested reading at a single block, checked against the primary. If the two differ by more than `skew`, borrowing, marking, liquidation and redemption pause.
- **Market:** read live from IMD's pool and Chainlink every 30 seconds. It is not attested and the vault does not use it; it shows where the next update would move the price.

Beneath them a line says whether price actions are open or paused, and why. When an update is needed, a button buys one with your own IMD through `OracleAsker`: **Update price** buys the primary, plus the spot in the same transaction (`askPaidMany`) only when the spot is stale, would disagree with the new primary or would run out well before it; **Update spot check** buys the spot alone; **Update network health** buys the health feed. Each answer arrives on its own, usually minutes later. The same line and buttons appear above the Position tab's actions.

Each feed row expands to show its latest value, when it was updated, its maximum age and its question. **Question: Pinned** means the feed refuses answers to any question other than its own. **None pinned** would mean it accepts any question; **Not reported** means the feed cannot say. **Last window** is the last block of the most recent accepted price window. The IMD/USD row is calculated on chain from the main price and Chainlink ETH/USD, so it is marked Derived and has no question of its own.

### Backing

- **Backing per imdUSD:** the figure redemption pays against, never above $1. "At par" means backing is at the cap; "Cap binds" means it is below $1 and redemptions pay less.
- **Reserve value:** the Treasury's assets in dollars.
- **Collateral-backed debt:** principal still standing behind collateral, net of bad debt.
- **Secured collateral:** collateral counted as backing, bounded by each position's own debt. Surplus and debt-free deposits are excluded.
- **Total principal debt**, **Recorded bad debt**, **Work minted**, **Non-principal burns:** the pieces of supply accounting. Supply equals principal debt plus work minted minus non-principal burns.
- **Work ratio** and **Work ceiling:** the limit on work-backed issuance (`earnMat`, `earnLine`).

## Desk tabs

### Position

Left column, **Your position**:

- **Collateral ratio** and the required ratio beside it.
- **Collateral** (sIMD), **Accrued debt** (imdUSD, including fees) and **Unpaid stability fee**.
- **Liquidation price:** the dollar price per IMD at which your ratio reaches `mat`, counting your sIMD at the IMD it is worth. "No debt" if you owe nothing. The line below says how far above it the price is.
- **Can still borrow** and **Can withdraw:** the most you could add or remove at the current price without going under `mat`.
- **Wallet:** your IMD, sIMD and imdUSD balances.

Right column, **Act**: choose Deposit (`lock`), Borrow (`draw`), Repay (`wipe`) or Withdraw (`free`). Deposit takes IMD (staked for you) or sIMD, and first asks for an approval of that token for exactly the amount, as its own transaction. Repay needs no approval.

### Redemption

Left: **Current fee** (before your amount is added), **Floor / cap**, **Paid at** ($1, or the backing figure if lower), **Reserve on hand** (Treasury sIMD), **Eligibility ceiling**, and a table of the fee for 1%, 5% and 10% of supply.

Right: enter an amount, a slippage tolerance in basis points and, if the reserve is short, a **Candidate position**. Press Quote redemption. The quote shows what you receive, your fee, whether it is served by the reserve, a position or both, the debt cancelled and your minimum. Any edit clears the quote. Then press Review redemption to run Redeem (`cash`).

### Work

Shows the work rights you can use, then **Mint from work** (`earn`). Rights come from the swarm's daily work tally: the work oracle holds a signed summary of that tally, and whoever controls an agent claims its accepted tasks with `claim` on the work oracle. Minting from work is off at launch.

### Keeper

Choose **Inspect** and paste a borrower address (or click one in the loan book). You see their ratio, collateral, debt, a bad-debt estimate, liquidation price and mark status: None, Grace with a countdown, Active and liquidatable, or Recovered and clearable. Choose **Act** for Mark (`bark`), Mark for a beneficiary (`barkFor`), Clear mark (`heel`) and Liquidate (`bite`). See [Mark and liquidate](../keepers/mark-and-liquidate.md). The terminal calls the vault directly; it does not bundle a price update with the action.

### Governance

Shows the governed parameters, any pending change with its countdown and a button anyone may press to apply it once the delay has passed. See [Timelock and proposals](../governance/timelock-and-proposals.md).

## What a disabled button tells you

| Where | Message under the button | Meaning |
|---|---|---|
| Borrow | "Fresh, agreeing price feeds are required." | A price is out of date or the main and spot prices disagree. Check Oracle. |
| Withdraw | "An indebted position needs fresh feeds to withdraw." | You owe debt, so the vault must price you. A debt-free position can always withdraw. |
| Redeem | "Fresh, agreeing primary, spot, NHI and USD feeds are required." | Same cause. NHI is the network health feed. |
| Mint from work | "Fresh feeds, available rights and backing headroom are required." | Feeds stale, you have no minting rights, or the work ceiling is reached. |
| Mark | "Inspect an unhealthy borrower with fresh feeds." | The borrower is at or above `mat`, or no one is inspected. |
| Mark for a beneficiary | "Inspect a borrower and wait for fresh feeds." | Same. |
| Clear mark | "Inspect a marked position." | There is no mark to clear. |
| Liquidate | "An active mark, elapsed grace, open execution window and fresh feeds are required." | The position is unmarked, still in grace, or its mark has expired. |

When the wallet is not connected or is on the wrong chain, the note under every action says so instead.

## When a simulation fails

The note names the figure that blocked you. Typical ones:

- **Needs more collateral:** it gives the collateral required and the most you can borrow now.
- **Primary and spot disagree by X; the vault allows Y:** wait for them to converge.
- **A required feed is stale:** it lists which feed and how old it is. Actions reopen when a fresh price arrives.
- **Total debt would reach X against a ceiling of Y:** the debt ceiling `line` has no room.
- **The payout is below your minimum:** refresh the quote or widen slippage.
