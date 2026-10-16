---
title: Reading state
section: reference
order: 5
audience: integrators
sources:
  - src/CDPVault.sol:239-262
  - src/CDPVault.sol:280-300
  - src/CDPVault.sol:494-537
  - src/CDPVault.sol:636-700
  - src/CDPVault.sol:760-1110
  - src/ParameterizedVault.sol:86-260
  - src/Treasury.sol:92-230
  - src/SwarmFeed.sol:152-185
  - src/UsdPriceFeed.sol:38-95
  - src/SwarmWorkOracle.sol:66-191
  - web/src/history.ts:76-211
---

# Reading state

`positions(owner)` returns a position's sIMD collateral (24-decimal raw units) and its imdUSD debt including accrued fees. It looks up one account; the vault cannot list them. [Vault functions](./vault-functions.md) has exact signatures and units.

## Read a consistent snapshot

1. Read `stablecoin`, `parameters`, `treasury`, `oracle`, `priceFeed`, `nhiFeed`, `spotFeed` and `usdPriceFeed` from the vault, and check each one names the vault back ([Contracts and addresses](./contracts-and-addresses.md)).
2. Pick one block and read everything at that block. Keep its hash and timestamp, and work out grace and feed ages from that timestamp, not the local clock.
3. Read `positions(owner)`, `debtOf(owner)`, `stabilityFeeOf(owner)`, `collateralRatio(owner)` and `liquidationMarks(owner)`. Debt minus fees is principal. A debt-free position's ratio is the maximum integer; show it as "No debt".
4. For each feed read `(value, updatedAt)`, `isStale()` and `maxAge()`. Check that primary and spot agree within `skew()`, and read the dollar price with its staleness flag. A nonzero number is not enough to act on.
5. Read `mat()`, `lull()`, `tail()` and any pending parameter change at the same block. A mark's grace is stored when it is made, so later network-health changes do not alter it. Liquidation is allowed from `markedAt + grace` to `markedAt + grace + tail()`, both ends included, if the other checks pass.
6. Simulate a write with the real sender and inputs just before sending it. A snapshot or quote reserves nothing; another transaction or the passing of time can change the outcome.

## Find positions without reporting a false empty book

Index `Lock` events from the vault's creation block to find accounts that have deposited, remove duplicates, then read each position. Keep accounts that still have debt even if their collateral is gone. Events alone cannot give accrued fees. Index later events to refresh, and handle reorganisations with block hashes and log indices.

A public RPC can return an empty list for a log range it declines to serve, without an error. Splitting into smaller ranges helps but does not prove a range is empty.

1. Scan bounded ranges with `eth_getLogs`, recording which ranges completed and which failed.
2. Cross-check with an explorer's log API, especially where the RPC returned nothing. Follow every page of results across the whole range, and filter on the exact vault address and event topic. A page limit is not the end of history.
3. Keep a trusted creation block and checkpoints. Where the RPC and explorer disagree, treat the range as unread.
4. Show "unreadable" or "coverage unverified" separately from "none". Report no positions only when every range was read and every account found was read successfully. A failed account read is unknown, not zero.

An explorer is one more service that can be down or wrong, not a proof of completeness. Always let users look up an address directly, even when full discovery is incomplete.

## Backing and supply

`totalDebt()` is principal. `totalBadDebt()` is the debt left on drained positions, recorded when it happens; it is not the sum of `badDebtOf(owner)` across positions. `backedDebt()` subtracts recorded bad debt and leaves out principal added in the current transaction, and never counts more than the paced debt, which follows principal up by at most 10% an hour and falls at once.

To explain the reserve, read `reserveValue()`, `treasury.reserveAssets()`, and `reserveAsset(asset)` and `reserveValueOf(asset)` for each. `haircutBps` is the share of value kept, not the share removed. Unlisted or unreadable assets count for nothing. `totalReceived` is a running total of receipts, not a balance; use the token's `balanceOf(treasury)` for holdings.

`redemptionReserve()` is the Treasury's sIMD balance, listed or not. `backingPerUnit()` adds that sIMD at the vault's price, the other listed assets at their discounted value, and collateral that secures debt, divides by imdUSD supply, and caps the result at $ 1. It is the lower of two figures: the live one, and the paced backing, which falls at once and rises at most two points of par an hour. Within a transaction, imdUSD repaid earlier in the same transaction is added back to the supply. `paced()` returns the paced backing, supply, debt, their clocks and the paced payout price; `payoutPrice()` is the price a redemption pays IMD at now. Each position's collateral counts at the price it was last touched at, until anyone calls `resecure(owner)`. So it is not simply `reserveValue() + backedDebt()` over supply, and it cannot be recomputed exactly from public getters alone: read `backingPerUnit()`. See [Monetary policy](../economics/monetary-policy.md).

Supply always equals `totalDebt() + totalEarned() - totalNonPrincipalRedeemed()`. Do not add `totalFeesMinted()`: fees reminted to the Treasury were first burned from the payer. Work minting is cumulative; redemption does not give its allowance back.

## Work and governance

The `SwarmWorkOracle` figure is a 32-byte root stored as a `uint256`; never show it as a price or a task count. For claims, read `acceptedRoots(root)`, `creditedTasks(agentId)`, `creditedRights(account)`, `consumedRights(account)` and `mintingRights(account)`. Freshness applies only when a new root is accepted: accepted roots and credited rights do not expire.

Read `Parameters.current()` for the five economic settings, then `earnMat()`, `wage()` and `gap()` separately. `pendingChange()` tells you which kind of change is pending; a zero ETA from a kind-specific getter can mean a different kind is pending. There is no `pendingWage()`: decode `pending()` instead. See [Timelock and proposals](../governance/timelock-and-proposals.md).
