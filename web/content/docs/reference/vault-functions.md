---
title: Vault functions
section: reference
order: 2
audience: integrators
sources:
  - src/CDPVault.sol:32-1602
  - src/ParameterizedVault.sol:25-309
  - docs/abi/ParameterizedVault.json:1
  - docs/abi/CDPVault.json:1
---

# Vault functions

Every function in the `ParameterizedVault` ABI (`docs/abi/ParameterizedVault.json`), including those it inherits from `CDPVault` and the getters Solidity generates. How the contracts are wired together is in [Contracts and addresses](./contracts-and-addresses.md).

**Units.** Amounts are raw token units: sIMD has 24 decimals, IMD and imdUSD 18. The vault never reads `decimals()`; it prices collateral per 1e18 raw units, so the price carries the scale. Dollar prices and indices are scaled by 1e18. A basis point is a hundredth of a percent; ratios such as `mat` are whole percentages. Times are Unix seconds and durations are seconds.

**Who can call.** Every write is open to anyone, subject to its checks, and acts on `msg.sender`'s own position unless it names an `owner`. None accepts ETH. Every read is free and changes nothing, but a successful read does not mean a write will succeed. A failed write rolls back completely; see [Events and errors](./events-and-errors.md).

**Live prices.** Many functions need *live prices*: the primary, network health and dollar prices are not stale, the spot price is not stale or zero, and primary and spot agree within `skew`. `lock`, `lockIMD`, `wipe` and `free` with no debt do not need them. `mat` is the minimum collateral ratio and `line` the borrowing ceiling.

## Functions that change state

### `bark(address owner)`

Mark an unsafe position. Needs live prices and the owner below `mat()`. The caller is recorded as the marker. Same as `barkFor(owner, msg.sender)`.

### `barkFor(address owner, address beneficiary)`

Mark an unsafe position and record `beneficiary` as the marker. Needs a nonzero `beneficiary`, live prices and the owner below `mat()`. No permission from the owner is needed.

If the position already has a mark that has not expired, nothing changes and no event is emitted. Otherwise stores the time, the grace from `lull()` and the marker, and emits `Bark`. Nothing is paid.

### `bite(address owner, uint256 debtToRepay)`

Liquidate. Needs a positive `debtToRepay`, live prices, an unsafe owner with a mark whose grace has passed and whose window has not closed (every position, a drained one too, must be marked first), enough debt to repay and enough collateral for the full payout, valid bonus shares, and enough imdUSD in the caller's wallet. No approval is needed.

Charges the owner's accrued fees, cancels fees then principal, burns the caller's imdUSD and remints the fee part to the Treasury. Takes the collateral and pays the marker, the Treasury and the caller (see [Keeper economics](../keepers/keeper-economics.md) for the split). Collateral too small for any further liquidation goes to the caller. If the collateral runs out with debt left, records the rest as bad debt. Clears the mark if the position is now safe. Emits `Bite`, and `Heel` if a mark was cleared. The seizure is priced at the attested price, not paced: a pool held below the market through the grace makes the liquidator's take larger at the real price ([Risks and open questions](../economics/risks-and-open-questions.md)).

### `cash(uint256 amount, uint256 minGemOut, address candidate)`

Redeem imdUSD for sIMD. Needs a positive `amount` no larger than total supply, enough imdUSD in the caller's wallet, live prices, and a payout above zero and at least `minGemOut`. The payout is `amount` at the payout price (`payoutPrice()`: the higher of the dollar price and a paced price that falls at most 1% an hour), times `backingPerUnit()` (so less than $ 1 a unit while backing is below $ 1), less the fee. If the Treasury cannot cover the payout, `candidate` must have debt, a ratio strictly below `mat() + gap()`, enough debt for the shortfall, and must not end up with a worse collateral-to-debt ratio.

Burns all of `amount`, pays from the Treasury's sIMD first and from the candidate's collateral for the rest, cancelling the candidate's fees before principal (fees are not reminted). Stores the new redemption base rate and the redemption time; the part of the burn that cancelled the candidate's principal from the last twelve hours is charged in full but does not raise the stored rate. Emits `Cash`, and `Heel` if a mark was cleared. Returns `gemOut`, the sIMD paid. No partial fills and no approval.

### `cover(address owner, uint256 amount)`

Cancel a drained position's bad debt with the Treasury's imdUSD. Anyone may call it. Needs a positive `amount` no larger than the position's debt, a Treasury holding at least `amount` imdUSD, and a position with recorded bad debt. The position may hold no collateral; or dust (worth under about Ɨ 1.2, or a millionth of a debt above a million), which is moved to the Treasury first; or collateral worth less than the position's recorded bad debt, which the Treasury takes at its value, so `amount` must then be at least that value. Anything but no collateral needs live prices unless the dust is below what a liquidation of one wei of debt would seize.

Burns `amount` of the Treasury's imdUSD and applies it like a repayment: fees first (reminted to the Treasury), then principal. `totalDebt`, the position's bad debt and `totalBadDebt` fall together, which raises backing for every holder. Emits `Cover`. Reverts with `NoRealizedBadDebt` if the position holds collateral worth at least its recorded bad debt, or has no recorded bad debt, and with `CoverBelowCollateralValue` if it takes collateral for less than its value.

### `draw(uint256 amount)`

Borrow imdUSD. Needs a positive `amount`, live prices, the stablecoin linked to this vault, a resulting ratio of at least `mat()`, and total principal still within `line()`.

Charges the caller's accrued fees, adds the principal, mints imdUSD to the caller and clears any mark. Emits `Draw`, and `Heel` if a mark was cleared.

### `drip()`

Save the current stability-fee index. Anyone may call it; no balances, prices or positions involved.

Stores `chi()` and the time, and emits `IndexCheckpointed`. Collects no fees and touches no position.

### `earn(uint256 amount)`

Mint imdUSD against work rights. Needs a positive `amount`, live prices, the stablecoin linked to this vault, enough `oracle.mintingRights(msg.sender)`, and `totalEarned + amount` within `earnLine()`.

Uses up the caller's rights and mints imdUSD to them. Adds no debt or collateral. Emits `Earn`. Refused with `WorkMintingOff` while the governed wage is zero. Minting from work is off at launch: the wage is zero until governance proposes one.

### `free(uint256 amount)`

Withdraw sIMD. Needs a positive `amount` no larger than the caller's collateral. With debt open, also needs live prices and a resulting ratio of at least `mat()`.

Reduces the collateral, clears any mark and sends the sIMD. Emits `Free`, and `Heel` if a mark was cleared.

### `heel(address owner)`

Clear a mark from a position that has recovered. Anyone may call it. Needs live prices and the owner at or above `mat()`, or with no debt.

Removes the mark and emits `Heel`. On a safe position with no mark it does nothing.

### `lock(uint256 amount)`

Deposit sIMD. Needs a positive `amount`, enough sIMD and approval to the vault, and exactly `amount` arriving. No price checks.

Adds to the caller's collateral. Clears a mark if the position can be seen to have recovered, or has no debt. Emits `Lock`, and `Heel` if a mark was cleared.

### `lockIMD(uint256 assets)`

Deposit IMD, which the vault stakes for you. Needs a positive `assets`, enough IMD and approval to the vault, and a collateral that is a staking-vault share (otherwise `CollateralNotWrappable`). No price checks.

Pulls the IMD, stakes it on the caller's behalf, and credits the sIMD that actually arrives (measured by balance). Otherwise the same as `lock`. Emits `Lock` with the sIMD credited, and `Heel` if a mark was cleared. The vault never unstakes; all payouts are in sIMD.

### `pace()`

Pace the vault's slow-moving figures (`paced()`) from the state as it stands. Anyone may call it; every call that moves capital does so first, so this matters only to let a recovery reach redeemers through a quiet spell. Moves nothing else and needs no price: through a stale or disagreeing window it holds the backing and the payout price where they were.

### `resecure(address owner)`

Re-price `owner`'s collateral term (how much of its collateral counts as backing) at the current price. Anyone may call it for any position. Needs live, agreeing prices. The keeper calls it after every price update, so no position's term stays at a stale price.

### `wipe(uint256 amount)`

Repay debt. Needs a positive `amount` no larger than the caller's debt and enough imdUSD in the wallet. No approval or price checks.

Charges accrued fees, burns the imdUSD, cancels fees before principal and remints the fee part to the Treasury. Clears a mark if the position can be seen to have recovered. Emits `Wipe`, and `Heel` if a mark was cleared.

## Read-only functions

None of these change anything. Reads that depend on a feed can still revert if the feed or arithmetic fails.

### `BACKING_RISE_PER_HOUR()`

Returns `uint256`. How far the paced backing may rise per hour of elapsed time: 0.02e18, two points of par. It falls at once. Fixed.

### `CHOP_PERCENT()`

Returns `uint256`. The liquidation bonus, as a percent of debt repaid: 20. Fixed.

### `FOLLOW_BPS_PER_HOUR()`

Returns `uint256`. How far the paced supply (the fee base) and the paced debt (what the work ceiling counts) may move toward the live figures per hour of elapsed time, in basis points of themselves or of the Ɨ 100,000 floor when larger: 1,000. The paced debt falls at once. Fixed.

### `PACE_INTERVAL()`

Returns `uint256`. One hour, in seconds: the most elapsed time one pacing counts, so a quiet day cannot bank a day's movement. Fixed.

### `PAYOUT_PRICE_FALL_BPS_PER_HOUR()`

Returns `uint256`. How fast the price a redemption is paid at may fall, per hour of elapsed time: 100 (1%). It rises at once. Fixed.

### `REDEMPTION_FEE_CAP_BPS()`

Returns `uint256`. The highest redemption fee, in basis points: 500 (5%). Fixed.

### `REDEMPTION_FEE_FLOOR_BPS()`

Returns `uint256`. The lowest redemption fee, in basis points: 50 (0.5%). Fixed.

### `backedDebt()`

Returns `uint256`. The principal that counts toward the work-minting ceiling: total principal, capped at the principal this transaction began with and at the paced debt (which follows principal up by at most 10% an hour and falls at once), minus recorded bad debt, never below zero. In imdUSD raw units.

### `backingPerUnit()`

Returns `uint256`. Dollar backing per imdUSD, scaled by 1e18 and capped at $ 1: the Treasury's sIMD, other listed reserve assets and collateral that secures debt, divided by supply (plus any imdUSD repaid earlier in the same transaction). It is the lower of the live figure and the paced backing, which falls at once and rises at most two points of par an hour (`BACKING_RISE_PER_HOUR`). Redemption pays against this. Needs a nonzero dollar price but does not check freshness. See [Monetary policy](../economics/monetary-policy.md).

### `badDebtOf(address owner)`

Returns `uint256`. How much of the position's debt its collateral cannot cover, counting the full liquidation bonus. Zero with no debt; all of the debt if collateral is gone. Otherwise needs a nonzero dollar price. No freshness check.

### `chi()`

Returns `uint256`. The stability-fee index, scaled by 1e18: the last saved value plus simple interest at `duty()` since. No compounding.

### `chiOf(address account)`

Returns `uint256 index`. The index value when this account's fees were last charged. Zero for an account that never borrowed.

### `chip()`

Returns `uint256`. The marker's share of the liquidation bonus, in basis points: 1,000 at launch. Governed.

### `collateralPriceFeed()`

Returns `address`. The vault's `SharePriceFeed` ([`0xF065C8b65AA9Ac6fd9cBAd15301738e91389d9e1`](https://etherscan.io/address/0xF065C8b65AA9Ac6fd9cBAd15301738e91389d9e1)): USD per 1e18 raw sIMD units, the staking vault's `convertToAssets(1e18)` times `usdPriceFeed()`. Stale whenever `usdPriceFeed()` is. Every collateral figure uses this price.

### `collateralRatio(address owner)`

Returns `uint256`. Collateral value divided by debt, as a whole percentage. Debt-free or too large to represent returns the maximum integer. Needs a nonzero dollar price if there is debt; no freshness check.

### `cut()`

Returns `uint256`. The protocol's share of the liquidation bonus, in basis points: 1,000 at launch. Governed.

### `debtOf(address owner)`

Returns `uint256`. Principal plus unpaid fees, in imdUSD raw units.

### `decayedRedemptionBaseRate()`

Returns `uint256`. The redemption fee base after decaying since `lastRedemptionAt`, as a fraction scaled by 1e18.

### `deployedAt()`

Returns `uint256`. When the vault was deployed. Fees are not measured from it.

### `duty()`

Returns `uint256`. The yearly stability fee, in basis points: 444 at launch. Governed.

### `earnLine()`

Returns `uint256`. The ceiling on total work minting, in imdUSD raw units: `reserveValue()` plus `backedDebt()` times `earnMat()` basis points. Unreadable reserve entries count for nothing; no freshness check.

### `earnMat()`

Returns `uint256`. How much of `backedDebt()` counts toward the work ceiling, in basis points: 2,500 at launch, which is also its upper limit. Governed.

### `feeRecipient()`

Returns `address`. The vault's Treasury ([`0x6Ac8fF96Fb8DCF5d79A8eF1E59D9AC23f2BD27Bc`](https://etherscan.io/address/0x6Ac8fF96Fb8DCF5d79A8eF1E59D9AC23f2BD27Bc)). Receives the protocol's bonus share and paid fees.

### `gap()`

Returns `uint256`. How far above `mat()` a position can be redeemed against, in whole percentage points: 50 at launch. Governed.

### `gem()`

Returns `address`. The collateral token, sIMD ([`0x9Efa934D9fAd4AE28c998a40195646b965a97247`](https://etherscan.io/address/0x9Efa934D9fAd4AE28c998a40195646b965a97247)).

### `indexCheckpoint()`

Returns `uint256`. The last saved stability-fee index, scaled by 1e18. Changed by `drip()`.

### `indexCheckpointAt()`

Returns `uint256`. When `drip()` last saved the index; starts at deployment.

### `lastRedemptionAt()`

Returns `uint256`. When the last redemption happened; starts at deployment.

### `line()`

Returns `uint256`. The ceiling on outstanding borrowed principal, in imdUSD raw units: Ɨ 1,000,000 at launch. Governed. Fees and work minting do not count against it.

### `liquidationMarks(address account)`

Returns `uint256 markedAt, uint256 grace, bool marked, address marker`. The stored mark: when it was made, the grace in seconds, whether it exists and who marked. An expired mark can still read `marked = true`.

### `lull()`

Returns `uint256`. The grace a new mark would get, in seconds, from the last accepted network health value: none at 0.60 or below, six hours at 0.85 or above, linear between. No freshness check.

### `mat()`

Returns `uint256`. The minimum collateral ratio as a whole percentage, from the last accepted network health value: 200 at 0.60 or below, 170 at 0.85 or above, linear between and rounded up. No freshness check.

### `nhiFeed()`

Returns `address`. The network health feed ([`0x014DabF6F940c9C383D9ef48636F70D842F65D7A`](https://etherscan.io/address/0x014DabF6F940c9C383D9ef48636F70D842F65D7A)).

### `oracle()`

Returns `address`. The work oracle in use: a replacement applied through `Parameters.proposeWorkOracle` if there is one, otherwise the one this vault created ([`0xC7335a836ad85a6ac0830c6CEf602d735B9d8a8A`](https://etherscan.io/address/0xC7335a836ad85a6ac0830c6CEf602d735B9d8a8A)).

### `parameters()`

Returns `address`. The vault's `Parameters` ([`0x3D96A6Ffada9C2E5B8fF8eb3f8AFB360116dA881`](https://etherscan.io/address/0x3D96A6Ffada9C2E5B8fF8eb3f8AFB360116dA881)).

### `paced()`

Returns `uint256 backing, uint256 supply, uint256 debt, uint256 at, uint256 backingAt, uint256 price`. The paced figures as last written: backing per imdUSD (1e18-scaled), supply, debt, when supply and debt were paced, when the backing and payout price were last paced at a usable price, and the paced payout price. See [Monetary policy](../economics/monetary-policy.md).

### `payoutPrice()`

Returns `uint256`. The price a redemption pays IMD at now: the higher of the collateral's dollar price and the paced payout price, which falls at most `PAYOUT_PRICE_FALL_BPS_PER_HOUR` an hour and rises at once. Quote a redemption with this, not the feed's price.

### `positions(address owner)`

Returns `uint256 collateral, uint256 debt`. Collateral in raw sIMD units and debt including fees in imdUSD raw units.

### `priceFeed()`

Returns `address`. The primary IMD/ETH feed ([`0x070e0603737242B01aBC1D223f7C92D63E86EC97`](https://etherscan.io/address/0x070e0603737242B01aBC1D223f7C92D63E86EC97)). This is not the dollar price.

### `redemptionBaseRate()`

Returns `uint256`. The stored redemption fee base, scaled by 1e18, before decay. Updated by `cash`.

### `redemptionCeilingCR()`

Returns `uint256`. `mat() + gap()`, in whole percentage points. A candidate must be strictly below it.

### `redemptionDivisor()`

Returns `uint256`. How fast the redemption fee climbs: each redemption adds redeemed ÷ fee base ÷ this to the base rate, where the fee base is the paced supply (see [Monetary policy](../economics/monetary-policy.md)), never less than Ɨ 100,000. Governed: 2 at launch.

### `redemptionFeeBps(uint256 amount)`

Returns `uint256`. The fee a redemption of `amount` would pay, in basis points, including the rise from its own size measured against the fee base, rounded up. With zero it quotes the floor plus the decayed base. Reverts with `ExcessRepayment` above total supply. Does not check balances, candidates or prices.

### `redemptionReserve()`

Returns `uint256`. The Treasury's sIMD, in raw units, whether or not sIMD is listed as a reserve asset.

### `reserveValue()`

Returns `uint256`. The Treasury's listed assets at their discounted dollar value, scaled by 1e18. Same as `treasury.reserveValueUsd()`. Unreadable entries count for nothing.

### `securedCollateral()`

Returns `uint256`. Total collateral that counts as securing debt, in raw sIMD units: each position's collateral, capped at what twice its principal buys at the price when the position last changed. A position with no debt counts for nothing. Not the vault's token balance.

### `skew()`

Returns `uint256`. How far primary and spot may differ, as basis points of the primary: 500 at launch. Governed.

### `spotFeed()`

Returns `address`. The spot IMD/ETH feed, used only for comparison ([`0x77E1684402869Bf2B7c70B8bf21E1C7Ca7104951`](https://etherscan.io/address/0x77E1684402869Bf2B7c70B8bf21E1C7Ca7104951)).

### `stabilityFeeOf(address owner)`

Returns `uint256`. Unpaid fees, in imdUSD raw units. Fees do not earn fees.

### `stablecoin()`

Returns `address`. The `ImdUSD` token ([`0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25`](https://etherscan.io/address/0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25)).

### `tail()`

Returns `uint256`. How long a mark stays usable after its grace, in seconds: the shorter of `priceFeed.maxAge()` and `nhiFeed.maxAge()`: one hour.

### `totalBadDebt()`

Returns `uint256`. Recorded bad debt, in imdUSD raw units. Rises when a position is drained and falls when bad debt is repaid or covered.

### `totalDebt()`

Returns `uint256`. Outstanding borrowed principal, in imdUSD raw units, including principal on drained positions. Excludes unpaid fees and work minting.

### `totalEarned()`

Returns `uint256`. Total imdUSD ever minted by `earn`. Never goes down.

### `totalFeesMinted()`

Returns `uint256`. Total fees reminted to the Treasury by `wipe`, `bite` and `cover`. Not extra supply: the payer burned the same amount.

### `totalNonPrincipalRedeemed()`

Returns `uint256`. Total imdUSD burned by `cash` without cancelling principal: reserve-paid burns and cancelled unpaid fees.

### `treasury()`

Returns `address`. The vault's Treasury ([`0x6Ac8fF96Fb8DCF5d79A8eF1E59D9AC23f2BD27Bc`](https://etherscan.io/address/0x6Ac8fF96Fb8DCF5d79A8eF1E59D9AC23f2BD27Bc)).

### `usdPriceFeed()`

Returns `address`. The vault's IMD/USD feed ([`0x297b85afc6bbF9d9cCa636F7ED74c56DA79287A0`](https://etherscan.io/address/0x297b85afc6bbF9d9cCa636F7ED74c56DA79287A0)). Prices IMD, not sIMD; `collateralPriceFeed()` builds on it.

For a consistent snapshot, see [Reading state](./reading-state.md). For step-by-step use, see [Open a position](../guides/open-a-position.md), [Redeem](../guides/redeem.md) and [Mark and liquidate](../keepers/mark-and-liquidate.md).
