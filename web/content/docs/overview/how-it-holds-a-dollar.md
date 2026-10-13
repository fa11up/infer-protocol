---
title: How imdUSD holds a dollar
section: overview
order: 2
audience: everyone
sources:
  - src/CDPVault.sol:360-390
  - src/CDPVault.sol:432-511
  - src/CDPVault.sol:653-755
  - src/CDPVault.sol:830-848
  - src/CDPVault.sol:871-883
  - src/ParameterizedVault.sol:142-164
  - src/UsdPriceFeed.sol:9-95
  - src/SwarmFeed.sol:160-185
---

# How imdUSD holds a dollar

Four things keep one imdUSD close to one dollar: borrowing, redemption, liquidation and the price they all read. This page explains why they work. For step-by-step instructions, see the [guides](../guides/open-a-position.md).

## Borrowing creates imdUSD against more collateral than debt

When you borrow (`draw`), the vault checks that your collateral, valued in dollars, is worth at least the minimum collateral ratio `mat` times your debt. Only then does it mint imdUSD to you. Total borrowing across all positions is also capped by a debt ceiling, `line`.

`mat` is not fixed. It follows the IdentityMD network health index: the healthier the network, the lower the requirement, and the reverse.

Debt grows with a yearly stability fee, `duty`. Fees build up on the position and are paid first when you repay (`wipe`).

## Redemption puts a floor under the price

Anyone can burn imdUSD and receive sIMD (`cash`). Each imdUSD pays $ 1 of sIMD, less a fee, or less than $ 1 if the system holds less than $ 1 of backing per imdUSD. Backing per imdUSD is the reserve plus the collateral standing behind debt, divided by imdUSD supply, and it never counts above $ 1, so a surplus is not paid out as a windfall. If backing falls short, every redeemer is paid a little less rather than redemption closing.

Redemption is paid from the Treasury's sIMD first. If the Treasury is short, the rest comes from a borrower's position the redeemer names: that borrower's debt is cancelled and their collateral pays the redeemer. Only positions close to the minimum ratio can be named, so redemption lands on the thinnest positions first.

What a redemption is paid against can rise by at most two points of par an hour, however much new collateral or debt arrives, and falls at once. This stops someone from adding capital, redeeming against it and pulling it straight back out. The full rules, fee and steps are in [Redeem](../guides/redeem.md).

If imdUSD trades below the redemption price, buying it and redeeming earns a profit, which pushes the price back up. That is the floor. Nothing in the contracts pulls the price down from above $ 1; new borrowing may do so in practice, but that is not guaranteed.

## Liquidation removes positions that fall short

If a position's ratio falls below `mat`, any keeper can mark it (`bark`). That starts a grace period (`lull`), set by network health at the moment of marking, during which the borrower can still recover. After grace ends, the mark stays usable for a limited window (`tail`). In that window any keeper can liquidate (`bite`): they burn imdUSD to cancel part of the borrower's debt and receive sIMD worth that debt plus a bonus.

The bonus is shared between the keeper who marked, the protocol and the keeper who liquidated; [Keeper economics](../keepers/keeper-economics.md) has the split. If the borrower restores the ratio, or the price recovers and anyone clears the mark (`heel`), the mark is removed. Full rules: [How liquidation works](../keepers/how-liquidation-works.md).

## The price: swarm-attested, in dollars

Every figure above needs the dollar value of the collateral, sIMD. It is built from three parts:

1. **IMD/ETH**, a price over a block window that IdentityMD agent panels work out by answering a fixed question. The answer is signed by the IdentityMD oracle service, and `PriceFeed` accepts it only if the signature, panel size, freshness and the question itself all check out.
2. **ETH/USD**, read from Chainlink by `UsdPriceFeed`.
3. **The sIMD exchange rate**, the IMD each sIMD is worth, read from the staking vault by `SharePriceFeed`.

Multiplied together, these give the dollar price of sIMD the vault uses. If either the IMD/ETH or ETH/USD reading is out of date, the whole price counts as out of date.

No key can set a price. A price changes only when a valid signed answer is submitted, and anyone may submit one through `SwarmRelay` ([Relay oracle updates](../keepers/relay-oracle-updates.md)). When a price is older than its maximum age, actions that need it are refused with `StaleFeed` until a fresh one arrives.

### The primary and spot divergence guard

The vault also holds a second IMD/ETH price, the spot price: the price at the last block of a window, rather than the middle of samples across it. It never prices anything; it is only compared with the main price. If the two differ by more than `skew`, the vault refuses with `PriceDivergence`. An attacker would need to move both readings to fool it.

While the guard is tripped, borrowing, withdrawing while in debt, minting from work, marking, liquidating, clearing marks and redeeming all pause. Depositing and repaying stay open.

## What can still go wrong

An out-of-date or disagreeing price halts every action that needs one. A fast price fall can outrun liquidation and leave bad debt. Backing per imdUSD can sit below $ 1, and then redemption pays less than $ 1. See [Risks and open questions](../economics/risks-and-open-questions.md).
