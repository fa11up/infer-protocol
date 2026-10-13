---
title: Glossary
section: overview
order: 4
audience: everyone
sources:
  - docs/NAMING.md:1-68
  - src/CDPVault.sol:44-49
  - src/CDPVault.sol:776-848
  - src/SwarmFeed.sol:26-42
  - src/SwarmFeed.sol:210-221
  - src/ParameterizedVault.sol:120-199
---

# Glossary

Each entry gives the plain meaning first, then the contract name where there is one.

**Ɨ.** The sign for imdUSD amounts: Ɨ 100 is 100 imdUSD. It is the I of IMD struck through, as $ strikes an S (Unicode U+0197, Latin capital letter I with stroke). Dollar prices, such as IMD's price in USD, keep $.

**attestation.** A signed answer from an IdentityMD agent panel. A price feed changes only when it receives a valid one. See [Relay oracle updates](../keepers/relay-oracle-updates.md).

**backing per imdUSD.** The reserve plus the collateral standing behind debt, divided by imdUSD supply, never above $1. What a redemption is paid against is the lower of this figure and its paced copy, which falls at once but rises at most two points of par an hour, so capital brought in just before a redemption cannot lift it faster than that. Read with `backingPerUnit()`.

**bonus.** The extra collateral a liquidator receives on top of the debt they repay (`CHOP_PERCENT`). It is shared between the marker (`chip`), the protocol (`cut`) and the liquidator. See [Keeper economics](../keepers/keeper-economics.md).

**borrow (`draw`).** Mint imdUSD against your collateral, up to `mat` and the debt ceiling. Needs live prices: every price fresh, and the main and spot prices in agreement.

**chi.** The stability-fee index. It starts at 1 and rises steadily at the yearly rate `duty`. Each position remembers the value it last paid up to (`chiOf(owner)`). Anyone can record the current value with `drip()`.

**chip.** The marker's share of the liquidation bonus, paid to whoever marked the position.

**clear mark (`heel`).** Remove the mark from a position that is safe again. Anyone may do it.

**collateral ratio.** Collateral value in dollars divided by debt, as a whole percentage. Read with `collateralRatio(owner)`.

**cover.** Cancel a drained position's bad debt using imdUSD the Treasury holds. Anyone may call `cover(owner, amount)`.

**cut.** The protocol's share of the liquidation bonus, paid to the Treasury.

**debt ceiling (`line`).** The most borrowed principal that can be outstanding across all positions.

**deposit (`lock`, `lockIMD`).** Add collateral: sIMD with `lock`, or IMD with `lockIMD`, which stakes it for you.

**duty.** The yearly stability fee rate, set by governance: 4.44% at launch.

**fee base.** The supply a redemption's fee increase is measured against: imdUSD supply as paced (following the real supply by at most 10% an hour), never less than Ɨ 100,000. See [Monetary policy](../economics/monetary-policy.md).

**grace (`lull`).** The wait between a mark and the first moment the position can be liquidated. Its length follows network health and is fixed when the mark is made.

**keeper.** Anyone who relays price updates, marks unsafe positions or liquidates them. No permission is needed; keepers are paid from the liquidation bonus. See [Keeper economics](../keepers/keeper-economics.md).

**liquidate (`bite`).** Burn your imdUSD to cancel a marked position's debt and receive its collateral plus the bonus.

**liquidation window (`tail`).** How long a mark stays usable after its grace ends. After that the mark has expired (`MarkExpired`) and the position must be marked again.

**mark (`bark`).** Flag a position that is below the minimum ratio so it can be liquidated after grace. `barkFor(owner, beneficiary)` credits someone else as the marker. The mark is stored in `liquidationMarks(owner)`.

**mat.** The minimum collateral ratio, set by network health: 170% when the network is healthy, up to 200% when it is not. Read with `mat()`.

**mint from work (`earn`).** Mint imdUSD against swarm work credited to you by the work oracle, up to a ceiling (`earnLine`, scaled by `earnMat`).

**network health index.** A signed figure about how well the IdentityMD network is running. It sets `mat` and the grace length. See [Network health](../governance/network-health.md).

**paced figures (`pace`).** Slow-moving copies of backing per imdUSD, imdUSD supply and debt that redemption and the work ceiling read instead of the live figures. Backing rises at most two points of par an hour and falls at once; supply and debt follow the live figures by at most 10% an hour. Every call that moves capital paces them, and anyone may call `pace()`.

**payout price.** The price a redemption pays IMD at: the higher of the attested price and a paced price that falls at most 1% an hour and rises at once (`payoutPrice()`).

**question hash.** A fingerprint of the exact question a panel answered. Each feed refuses answers to any question but its own. See [Oracle and question binding](../reference/oracle-and-question-binding.md).

**re-price (`resecure`).** Update a position's collateral term to the current price. Anyone may call it for any position; the keeper does after every price update.

**redeem (`cash`).** Burn imdUSD and receive sIMD. See [Redeem](../guides/redeem.md).

**redemption spread (`gap`).** How far above `mat` a position can sit and still be used to fund a redemption.

**repay (`wipe`).** Burn imdUSD to pay down your debt. Fees are paid first.

**reserve.** What the Treasury holds: sIMD plus any assets governance lists. Redemption draws on its sIMD first.

**skew.** The most the main and spot IMD/ETH prices may differ before price-dependent actions pause.

**spot price.** A second IMD/ETH reading, taken at the last block of its window, used only to check the main price.

**stability fee.** Interest on debt at the rate `duty`. It is paid first when you repay.

**wage.** The imdUSD earned per accepted swarm task, set by governance within a hard limit of one imdUSD. At zero, minting from work is off, and it is zero at launch.

**work oracle.** The contract that turns the swarm's published task tally into minting rights. The vault creates one at deployment; governance may replace it, only while the wage is zero.

**withdraw (`free`).** Take collateral back out. With debt open, it needs live prices and must leave you at or above `mat`.
