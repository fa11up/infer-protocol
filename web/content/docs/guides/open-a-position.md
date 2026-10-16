---
title: Open a position
section: guides
order: 2
audience: borrowers
sources:
  - src/CDPVault.sol:328-338
  - src/CDPVault.sol:360-390
  - src/CDPVault.sol:55-79
  - src/CDPVault.sol:759-801
  - src/CDPVault.sol:863-883
  - web/src/Panes.tsx:117-207
---

# Open a position

This guide takes you from holding IMD or sIMD to holding borrowed imdUSD, in two steps: Deposit (`lock` for sIMD, `lockIMD` for IMD) and Borrow (`draw`). For why the numbers work the way they do, see [How imdUSD holds a dollar](../overview/how-it-holds-a-dollar.md).

## Before you start

- A wallet holding IMD or sIMD on the same chain as the vault, and a little ETH for gas. Your collateral is held as sIMD either way: deposit IMD and the vault stakes it for you.
- The terminal open at `/terminal/` with the wallet connected ([Use the terminal](./use-the-terminal.md)).
- Prices live: the price line on the Oracle tab (and above the Position tab's actions) must not say borrowing is paused. Borrowing is refused while a price is out of date or the main and spot prices disagree; the line then offers **Update price** to buy a fresh one with your own IMD. Depositing is not refused.
- The vault address, [`0x0b69F8DA8D8cE521d74Ea69a7A3475B77302EF82`](https://etherscan.io/address/0x0b69F8DA8D8cE521d74Ea69a7A3475B77302EF82). Check it against [Contracts and addresses](../reference/contracts-and-addresses.md) before approving anything.

## Steps

1. **Deposit.** In Position, choose Deposit, pick the token you hold (IMD or sIMD), enter the amount and press "Review deposit". Under the button, **After this** shows your collateral ratio, liquidation price and what you could still borrow once it lands. The first time, the review lists two steps: approve the vault to take exactly that amount, then the deposit. A wallet that supports batched calls (EIP-5792) signs both at once, all or nothing; any other wallet asks twice, one after the other. With sIMD the vault calls `lock(amount)` and pulls your sIMD. With IMD it calls `lockIMD(amount)`: it pulls your IMD, stakes it in the staking vault and credits the sIMD it receives. Either way your position grows by sIMD. You owe nothing yet, and while you have no debt you can withdraw at any time.
2. **Read the preview before you borrow.** Typing an amount in Borrow, Repay or Withdraw shows the same **After this** figures, at the vault's current prices, before anything is sent.
3. **Check what you can borrow.** **Can still borrow** is the most imdUSD you could take at the current price without going below the minimum ratio `mat`. Do not borrow all of it: both the IMD price and `mat` move, so a position at the limit can become unsafe without you doing anything. See [Manage and protect a position](./manage-and-protect-a-position.md).
4. **Borrow (`draw`).** Choose Borrow, enter an imdUSD amount below the maximum and confirm. The vault checks your new debt against `mat` and the total against the debt ceiling `line`, then mints the imdUSD to you.
5. **Read the result.** Collateral ratio, Liquidation price and Accrued debt update. Note your liquidation price.

Your debt is what you borrowed plus the stability fee (`duty`), which builds up every second even if you do nothing.

## What can block it

| Revert | Where | Cause | Recovery |
|---|---|---|---|
| `ZeroAmount` | Deposit, Borrow | Amount is zero | Enter a positive amount |
| `ERC20InsufficientAllowance` / `ERC20InsufficientBalance` | Deposit | Approval is smaller than the amount, or you hold too little of the token | Approve the exact amount again; lower the amount |
| `CollateralNotWrappable` | Deposit IMD | The vault's collateral is not a staking-vault share | Do not use this contract |
| `UnexpectedCollateralReceived` | Deposit | The token delivered a different amount than requested | The vault refuses such tokens; there is no recovery for that token |
| `StaleFeed` | Borrow | The IMD/ETH, network health, spot or ETH/USD price is older than its maximum age | Wait for a fresh price; check the Oracle tab |
| `PriceDivergence` | Borrow | The main and spot prices differ by more than `skew` | Wait for them to agree |
| `InvalidPrice` | Borrow | A price reads as zero | Wait for a valid price |
| `UnsafeCollateralRatio` | Borrow | Your debt after borrowing would be above what `mat` allows | Borrow less, or Deposit more |
| `DebtCeilingReached` | Borrow | Total principal would pass the ceiling `line` | Borrow less; wait for others to Repay |
| `NotInitialized` | Borrow | The stablecoin is not linked to this vault | Do not use this contract |

Nothing is sent when a check fails; the note under the button names the figure that blocked you.

## What you now hold

You hold imdUSD in your wallet and a position in the vault. To end it, [Manage and protect a position](./manage-and-protect-a-position.md) shows how to Repay and Withdraw.
