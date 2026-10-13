---
title: Monetary policy
section: economics
order: 1
audience: everyone
sources:
  - src/CDPVault.sol:280-300
  - src/CDPVault.sol:362-428
  - src/CDPVault.sol:434-640
  - src/CDPVault.sol:639-700
  - src/CDPVault.sol:778-803
  - src/CDPVault.sol:887-1110
  - src/ParameterizedVault.sol:86-199
  - src/ParameterizedVault.sol:235-250
  - src/Treasury.sol:115-185
  - src/Treasury.sol:257-323
  - src/Treasury.sol:330-480
  - src/SwarmWorkOracle.sol:135-191
---

# Monetary policy

imdUSD is created two ways, by borrowing (`draw`) and by minting against attested work (`earn`), and destroyed by repayment, liquidation and redemption. [How imdUSD holds a dollar](../overview/how-it-holds-a-dollar.md) explains the peg; this page covers the accounting underneath it.

## Issuance

**Borrowing** mints imdUSD against a position's sIMD, priced in dollars through ETH/USD, as long as the position stays above `mat` and total principal stays under the debt ceiling `line`.

**Work issuance** (`earn`) mints imdUSD to an agent's controller against work rights, with no collateral and no debt. Rights are credited at the `wage` in force when they are claimed. While `wage` is zero, claims are refused outright (`WorkMintingOff`), so no agent's tasks are marked used for nothing, and so is `earn` itself, so rights claimed under an earlier wage wait until a wage is set again; turning minting from work on is a governance proposal, not a redeployment. Minting is also capped by a running total, the work ceiling:

> `earnLine` = discounted reserve value + backed debt × `earnMat`

Backed debt is principal less recorded bad debt; principal borrowed in the same transaction does not count, and new debt counts only as the paced debt follows it up, by at most 10% an hour (see below). The ceiling limits new minting only: if it later falls below what has been minted, nothing is burned. Work issuance is off at launch: the wage is zero until governance proposes one.

## The stability fee

Debt grows at the annual rate `duty`, through an index `chi` that rises linearly over a 365-day year. A position's fee is its principal times the rise in `chi` since its own checkpoint; fees do not earn fees. When a governance change alters `duty`, the index is checkpointed first, so the new rate applies only from then on.

Repayment and liquidation pay fees before principal: the full amount is burned, and the fee part is minted back to the Treasury. Redemption cancels a candidate's fees without minting them back. So supply always equals:

> supply = `totalDebt` + `totalEarned` − `totalNonPrincipalRedeemed`

`totalFeesMinted` counts revenue and is not part of that equation.

## The redemption fee

The fee has a fixed floor and cap. Between them it is a base rate that rises with each redemption (by the amount redeemed ÷ the fee base ÷ `redemptionDivisor`) and decays every second, halving every twelve hours. The fee base is the paced supply: it follows imdUSD supply up or down by at most 10% an hour (`FOLLOW_BPS_PER_HOUR`, about 10.5% an hour when paced every block), so a large borrower can neither dilute the fee by borrowing for a block before a redemption nor pin it at the cap by repaying, redeeming a little and redrawing. Right after launch, or after a very large new loan, the base is small and redemptions pay more, up to the cap; it never counts as less than Ɨ 100,000, so a small redemption cannot set everyone's fee at the cap: doing so from the floor takes a Ɨ 9,000 redemption that pays the cap itself. The fee applies to the redemption that raises it, not just the next one, and is rounded against the redeemer. Debt minted recently and then redeemed against still pays the full fee, but does not raise the base for later redeemers, so a borrower cannot cheaply pump it. Right after launch the base starts at that floor whatever the supply, and follows it up at the same rate, so fees err high while the book is new. The payout itself is described in [Redeem](../guides/redeem.md).

## Backing per imdUSD

`backingPerUnit()` is the figure redemption pays against, capped at $1. It adds:

- the Treasury's sIMD at the vault's own price, plus other listed reserve assets at their discounted value; and
- collateral that stands behind debt, counted position by position and never more than each position's debt requires. Surplus collateral and debt-free deposits count for nothing.

It divides the total by imdUSD supply.

**Backing rises slowly and falls at once.** Redemption pays against the lower of the live figure and a paced one. The paced figure follows a fall immediately, but rises by at most two points of par an hour (`BACKING_RISE_PER_HOUR`), however much capital arrives. So nobody can deposit and borrow just before a redemption to lift backing to $1, take the reserve at par and unwind afterwards; a real recovery reaches redeemers at the same two points an hour. The paced figure moves only when the vault is paced, which every call that moves capital does and anyone may do with `pace()`; elapsed time counts at most one hour (`PACE_INTERVAL`) between pacings, so a quiet day cannot bank a day's rise. The keeper paces hourly. A pacing while the prices are stale or disagree holds the figure where it was.

**Each position's collateral counts at the price it was last touched at.** Anyone may re-price any position with `resecure(owner)`, and the keeper does after every price update, so no position's term stays at a stale price for long.

**What it errs on.** This never overpays a redeemer; where it errs, it underpays. A position that leaves the book in one transaction and returns in the next leaves backing where the book stood without it, which is below par only when the rest of the book carries an underwater position, uncovered bad debt or work-minted supply, and it climbs back at two points an hour. See [Risks and open questions](./risks-and-open-questions.md).

**The price a redemption is paid at is paced too.** A redeemer is paid IMD at the higher of the attested price and a paced payout price (`payoutPrice()`) that falls at most 1% an hour (`PAYOUT_PRICE_FALL_BPS_PER_HOUR`) and rises at once. A sudden fall of the attested price, real or a pool held down through the feed's window, therefore reaches payouts over most of a day (about 22 paced hours for a 20% fall) rather than in one step. After a real crash redeemers are paid at the higher figure until the paid price has followed it down.

This is deliberately conservative, not the market value of everything in custody, and it can fall after a redemption that cancels a borrower's debt. Below $1, holders share the shortfall through a smaller payout; above it, the surplus stays with borrowers rather than paying redeemers a premium.

## Revenue and what leaves the Treasury

The Treasury receives the protocol's share of each liquidation bonus (`cut`, in sIMD) and paid stability fees (in imdUSD). How the bonus is split is in [Keeper economics](../keepers/keeper-economics.md). The redemption fee is not transferred anywhere: it stays behind as collateral, in the reserve or in the candidate's position.

Five things can leave the Treasury:

- **Redemptions.** `cash` pays from the Treasury's sIMD before it touches any position. This is the reserve doing its job, at the same backing-scaled price as any other payout.
- **Price updates.** `fundOracle()` sends `OracleAsker` up to the governed daily IMD budget to buy updates ([how updates are paid for](../reference/oracle-and-question-binding.md#how-updates-are-paid-for)). This is an expense: it lowers the reserve, and backing, by at most the budget.
- **Covering bad debt.** `cover()` spends Treasury imdUSD to cancel a drained position's bad debt, which raises backing for every holder.
- **The stream.** `payStream()` pays a governed payee up to a governed daily amount of imdUSD. It is off until proposed and never spends imdUSD that bad debt still needs.
- **Operator withdrawals.** The operator may withdraw other tokens, but never sIMD, never a listed reserve asset, and imdUSD only above what bad debt needs.

There is no automatic revenue distribution or buyback.
