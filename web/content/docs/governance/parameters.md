---
title: Parameters
section: governance
order: 1
audience: governance
sources:
  - src/Parameters.sol:38-546
  - src/Governed.sol:23-94
  - src/Treasury.sol:115-185
  - src/Treasury.sol:277-323
  - src/Treasury.sol:330-350
  - src/CDPVault.sol:103-127
  - src/CDPVault.sol:578-617
  - src/CDPVault.sol:832-849
  - src/CDPVault.sol:1001-1011
  - src/ParameterizedVault.sol:61-199
  - src/SwarmWorkOracle.sol:135-191
---

# Parameters

`Parameters` holds the economic settings governance may change for its vault, each inside a hard limit written into the contract. It cannot replace the vault, the collateral, the price and health feeds, the dollar-price adapter or the Treasury.

Every change goes through the same [proposal and delay](./timelock-and-proposals.md). A basis point is one hundredth of a percent; imdUSD amounts use 18 decimals.

## Governed values

| Value | What it is | How it changes | Limit | At launch |
|---|---|---|---|---|
| `line` | Debt ceiling: the most principal that can be outstanding, in imdUSD. Fees and work issuance are not counted. | `propose(ParamSet)` | Above zero. Setting it below current debt only stops new borrowing. | Ɨ 1,000,000 |
| `cut` | Treasury's share of the liquidation bonus, in basis points. | `propose(ParamSet)` | `cut` plus `chip` cannot exceed the whole bonus (10,000). | 1,000 (10% of the bonus) |
| `duty` | Annual stability fee on principal, in basis points. | `propose(ParamSet)`; the old rate is checkpointed first. | Zero up to `MAX_DUTY_BPS`, 1,000 (10% a year). | 444 (4.44% a year) |
| `skew` | How far the primary and spot prices may differ, in basis points of the primary. | `propose(ParamSet)` | Between `MIN_DIVERGENCE_BPS` (100) and `MAX_SKEW_BPS` (2,000). | 500 (5%) |
| `chip` | Marker's share of the liquidation bonus, in basis points. | `propose(ParamSet)` | Shares the bound with `cut`. | 1,000 (10% of the bonus) |
| `earnMat` | How much of the backed debt counts toward the work ceiling, in basis points. | `proposeEarnMat(bps)` | Zero up to `MAX_EARN_MAT_BPS`, 2,500: it can be lowered, never raised past its launch value. | 2,500 (25%) |
| `wage` | imdUSD credited per newly claimed accepted task. At zero, minting from work is off: `earn` is refused (`WorkMintingOff`) and nothing mints against the work ceiling, which counts debt only up to the paced debt. | `proposeWage(wad)` | Zero up to `MAX_WAGE_WAD`, one imdUSD per task. | 0: minting from work is off |
| `gap` | Redemption eligibility spread above `mat`, in whole percent. | `proposeGap(spread)` | `MIN_GAP` (25) to `MAX_GAP` (100). | 50 points |
| `redemptionDivisor` | How fast the redemption fee climbs: each redemption raises the base rate by redeemed ÷ fee base ÷ divisor, the fee base being the paced supply (following imdUSD supply by at most 10% an hour), never less than Ɨ 100,000. | `proposeRedemptionDivisor(divisor)` | `MIN_REDEMPTION_DIVISOR` (1) to `MAX_REDEMPTION_DIVISOR` (8). | 2 |
| `streamPayee`, `streamPerDay` | Who the Treasury pays imdUSD to, and at most how much per UTC day. Off until proposed. | `proposeStream(payee, perDay)` | Zero up to `MAX_STREAM_PER_DAY`, Ɨ 500 a day; a nonzero amount needs a payee. | Off: no payee, zero a day |
| `oracleBudget` | IMD the Treasury may send `OracleAsker` per UTC day to buy price updates ([how updates are paid for](../reference/oracle-and-question-binding.md#how-updates-are-paid-for)). Zero stops it. | `proposeOracleBudget(imdPerDay)` | Zero up to `MAX_ORACLE_BUDGET_PER_DAY`, 100 IMD a day. | 15 IMD a day |
| `workOracle` | The contract the vault reads work rights from; zero means the one the vault created at deployment. Exists so that a change in how swarm work is published never forces a new vault. | `proposeWorkOracle(address)` | Refused while `wage` is above zero, both when proposed and when applied (`WorkMintingOn`), so rights are never claimable in two oracles at once. The replacement must serve this vault (`InvalidWorkOracle`). Once anything has been minted from work, or credited by a claim and not yet minted, it must also name the current oracle as its `predecessor()`, so already-credited work is not credited twice; returning to the original is then refused. | Zero: the vault's own |
| Reserve asset and its `priceFeed` | A token the Treasury counts as backing, and the dollar price source used to value it. sIMD is listed with the vault's own `collateralPriceFeed()`, so it counts at the vault's price. | `proposeReserveAsset(asset, priceFeed, haircutBps)` | The asset and feed must be contracts that answer sensibly; imdUSD itself cannot be listed. Proposing the zero address as the feed removes a listing. | None listed |
| Reserve `haircutBps` | The share of a listed asset's market value that counts. Lower counts less. | Same proposal | From none of its value to all of it. | None listed |

The five `ParamSet` values travel together in the order `line`, `cut`, `duty`, `skew`, `chip`, so a proposal restates all five even to change one. No proposal can widen a limit.

A listed reserve feed that goes stale or reads zero counts for nothing. Listing checks that the feed answers sensibly, not that it tells the truth.

No reserve asset is listed at deployment. Listing sIMD changes `reserveValue()` and so the work ceiling; it does not change what a redemption pays or `backingPerUnit()`, which count the Treasury's sIMD at the vault's price whether it is listed or not.

**Taking backing out is never immediate.** The operator can withdraw from the Treasury with `Treasury.withdraw`, but never sIMD and never a listed reserve asset, and imdUSD only above what outstanding bad debt needs. Removing an asset from the reserve takes a delisting proposal, visible for the whole delay.

## Fixed or derived values

These are written into the contracts or calculated, not proposed.

| Identifier | What it is | Value |
|---|---|---|
| `mat` | Minimum collateral ratio, from the [network health](./network-health.md) curve. | 200% at network health 0.60 or below, 170% at 0.85 or above, falling linearly between (rounded up to a whole percent) |
| `lull` | Grace between a mark and liquidation, from the same curve, fixed at the moment of marking. | None at 0.60 or below, six hours at 0.85 or above, linear between |
| `tail` | Liquidation window after grace: the shorter of the price and health feeds' maximum ages. | One hour |
| `CHOP_PERCENT` | Liquidation bonus as a percent of debt repaid. `chip` and `cut` divide it; they never add to it. | 20% |
| `REDEMPTION_FEE_FLOOR_BPS`, `REDEMPTION_FEE_CAP_BPS` | Lowest and highest redemption fee. | 50 and 500 basis points (0.5% and 5%) |
| `REDEMPTION_SECOND_DECAY`, `FRESH_DEBT_WINDOW` | How fast the redemption fee decays, and how long new debt is treated as fresh. | The base rate halves every twelve hours, decaying each second; new debt is fresh for twelve hours |
| `SECURED_COLLATERAL_MULTIPLE` | How much collateral per unit of debt can count as backing. | 2: collateral worth up to twice the position's principal |
| `BACKING_RISE_PER_HOUR`, `FOLLOW_BPS_PER_HOUR`, `PACE_INTERVAL` | The paced figures: backing per imdUSD rises at most two points of par an hour and falls at once; the fee base and the debt the work ceiling counts follow the live figures by at most 10% an hour; elapsed time counts at most one hour between pacings. | Fixed |
| `PAYOUT_PRICE_FALL_BPS_PER_HOUR` | How fast the price a redemption is paid at may fall: 1% an hour. It rises at once. | Fixed |
| Fee-base floor | The least supply a redemption's fee increase is measured against (`_feeBaseFloor`, internal). | Ɨ 100,000 |
| Feed `maxAge`, `maxDeviationBps` | How old a feed may get, and how far one update may move it. Set when each feed is deployed. | Price and spot: one hour. Network health: one day. Each 2,000 basis points (20%). The work oracle: one day, with no move limit, since its value is a Merkle root |
| `ETH_USD_MAX_AGE`, `WORK_ORACLE_MAX_AGE` | Maximum age of the Chainlink ETH/USD reading and of a work attestation. | Two hours; one day |
| `earnLine` | Work ceiling: discounted reserve value plus backed debt scaled by `earnMat`. Gates new work mints; it never burns tokens already issued. | Calculated |
| `chi` | Stability-fee index, from the last checkpoint, elapsed time and `duty`. | Calculated |

`TIMELOCK`, the governance delay, is fixed too at 48 hours and cannot be shortened by a proposal.

## What the limits do not guarantee

A split inside the limits can leave nothing for a liquidator who did not mark. A reserve feed inside the limits can overstate value. A rate inside the limits can still make positions unsafe. A lower `wage` affects only new claims, and a lower `earnMat` only new mints. See [Risks and open questions](../economics/risks-and-open-questions.md).
