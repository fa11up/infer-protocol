---
title: Redeem imdUSD
section: guides
order: 4
audience: everyone
sources:
  - src/CDPVault.sol:182-189
  - src/CDPVault.sol:429-511
  - src/CDPVault.sol:549-610
  - src/ParameterizedVault.sol:85-113
  - src/Treasury.sol:287-293
  - web/src/Redemption.tsx:28-379
---

# Redeem imdUSD

Redeem (`cash`) burns imdUSD from your wallet and pays you sIMD, staked IMD. It is the floor under the price: whenever imdUSD trades below what redemption pays, buying and redeeming is profitable. Unstake the sIMD in the staking vault to get IMD; sIMD received in a block cannot be unstaked in that same block, so do it in the next one.

## What you are paid

For each imdUSD burned, the vault pays sIMD worth $ 1, or the backing per imdUSD if that is lower, less the fee:

> sIMD out = imdUSD burned × min($ 1, backing per imdUSD) × (1 − fee) ÷ payout price

The payout price is the higher of the attested sIMD price and a paced price that falls at most 1% an hour and rises at once (`payoutPrice()`). In normal markets the two are the same.

- **Backing per imdUSD** is the reserve plus the collateral standing behind debt, divided by imdUSD supply, never above $ 1. Read it with `backingPerUnit()`; the terminal shows it.
- **The fee** has a floor and a cap. It rises with the share of the fee base your burn represents (imdUSD supply as it was paced, following the real supply by at most 10% an hour, never counted as less than 100,000) and falls back as time passes, halving every twelve hours. Quote it before you send with `redemptionFeeBps(amount)`.
- If backing is below $ 1, you are paid less than $ 1 per imdUSD. Redemption stays open, but it still needs live prices (fresh, and the main and spot prices agreeing), a valid candidate when the reserve is short, and a payout above zero.

### Backing and the payout price move slowly upward and fast downward

Backing per imdUSD falls at once but rises by at most two points of par an hour, so someone cannot deposit and borrow, redeem at a better rate against that fresh capital and withdraw it again a few blocks later. The payout price works the other way round for the same reason: it rises at once but falls at most 1% an hour, so a price pushed down for an hour cannot pay you extra IMD. Both can read conservatively for some hours after a sharp move: right after a crash you are paid at the higher, paced price until it has followed the market down. Quote your payout before you send; `minGemOut` refuses a payout below the figure you set.

## Who funds the payout

1. **The reserve first.** The vault pays from the Treasury's sIMD.
2. **A candidate position for any shortfall.** If the reserve cannot cover the whole payout, you must name a candidate: a borrower's address. The vault cancels that borrower's debt by the matching amount and pays the rest of your sIMD from their collateral.

A candidate must have debt, and its collateral ratio must be below `mat` plus the redemption spread `gap`. The Loan book's redeemable band shows such positions. The candidate must not end up worse off in ratio: the sIMD taken from them may not exceed their collateral in proportion to the debt cancelled.

## Prerequisites

- imdUSD in your wallet. No approval is needed: the vault burns it directly.
- Prices live: the price line on the Oracle tab must not say redeeming is paused (it offers **Update price** when it is).
- **Reserve on hand** on the Redemption tab, to see whether the reserve covers your amount. If not, a candidate address.

## Steps in the terminal

1. Open the Redemption desk tab.
2. Enter the imdUSD amount. Leave slippage at its default or set your own tolerance in basis points (1 basis point is 0.01%).
3. If the reserve is short, paste a candidate address.
4. Press Quote redemption. Read **You receive**, **Your fee**, **Served by**, **Debt cancelled** and **Minimum received**.
5. Press Review redemption and confirm. This sends `cash(amount, minGemOut, candidate)`.

`minGemOut` protects you: the call fails if the payout falls below it, for example because someone redeemed first and raised the fee. With no candidate, pass the zero address.

## What can block it

| Revert | Cause | Recovery |
|---|---|---|
| `ZeroAmount` | Amount is zero, or it rounds to zero sIMD out | Increase the amount |
| `StaleFeed`, `PriceDivergence`, `InvalidPrice` | Prices not usable | Wait for fresh, agreeing prices |
| `ExcessRepayment` | Amount exceeds total imdUSD supply, or the shortfall exceeds the candidate's debt | Reduce the amount |
| `MinimumOutNotMet` | Payout fell below `minGemOut` | Get a new quote; widen slippage |
| `IneligibleRedemptionPosition` | The candidate has no debt, is at or above `mat` plus `gap`, or none was given when needed | Choose another candidate from the redeemable band |
| `RedemptionWorsensRatio` | The sIMD taken would exceed the candidate's collateral share of the debt cancelled; common for a position that is already deeply short | Choose another candidate or a smaller amount |
| Token balance error | You hold less imdUSD than the amount | Reduce the amount |

A failed call changes nothing; your imdUSD is not burned.

## What your redemption changes

Your fee stays in the protocol as extra backing for the imdUSD that is left. A larger burn raises the fee for the next redeemer until it decays. Debt that was borrowed only recently and then cancelled by a redemption does not raise that fee, so a borrower cannot push it up cheaply. Backing per imdUSD can still dip after a redemption that cancels a candidate's debt, because that collateral stops counting as standing behind debt.
