---
title: Keeper economics
section: keepers
order: 4
audience: keepers
sources:
  - src/CDPVault.sol:99-101
  - src/CDPVault.sol:143-164
  - src/CDPVault.sol:703-755
  - src/DeploymentConfig.sol:103-122
  - src/SwarmRelay.sol:59-114
  - src/Parameters.sol:296-310
  - docs/MAINNET-RUNBOOK.md:72-86
---

# Keeper economics

A keeper does three paid jobs: relays price updates, marks unsafe positions and liquidates them. Two unpaid ones keep the vault's figures current: pacing it hourly and re-pricing positions after a price update ([Mark and liquidate](./mark-and-liquidate.md#pace-and-re-price)). This page covers what you are paid, what you must hold and what you risk.

## The bonus and how it is split

When you liquidate (`bite`), you repay part of a borrower's debt and receive sIMD worth that amount plus a bonus. The bonus rate is `CHOP_PERCENT`, 20% of the debt repaid, written into the contract.

> bonus = sIMD seized − the debt repaid, valued in sIMD

The bonus is divided three ways:

| Part | Name | Goes to |
|---|---|---|
| Marker's share | `chip` | The address recorded when the position was marked |
| Protocol's share | `cut` | The Treasury (`feeRecipient()`) |
| The rest | | The liquidator, along with the full value of the debt repaid |

`chip` and `cut` are fractions of the bonus, in basis points, set by governance; both are 1,000 (10% of the bonus) at launch. So on $ 100 of debt repaid the bonus is $ 20: $ 2 to the marker, $ 2 to the Treasury, and a liquidator who did not mark keeps $ 16 on top of the $ 100. Together they cannot exceed the whole bonus: `Parameters` refuses such a proposal (`SharesExceedBonus`), and the vault refuses a liquidation with `InvalidBonusShares` if it ever happened.

The split only divides a bonus that already exists. The borrower loses the same amount however it is split.

Who gets what:

- **You mark and liquidate.** You receive everything except the protocol's share.
- **You liquidate someone else's mark.** You receive the seized sIMD minus the protocol's share and the marker's share; the marker is paid in the same transaction.
- **You mark, someone else liquidates.** You receive the marker's share when they do.

A dust remainder swept to the liquidator ([How liquidation works](./how-liquidation-works.md#the-dust-sweep)) is not part of the bonus, so it does not change either share.

The only limit on `chip` and `cut` is that together they fit inside the bonus. At that limit, a liquidator who did not mark gets back only the value of the debt repaid, with nothing for the trouble, and has no reason to act. Whether a given split leaves liquidation worth doing is an open question: [Risks and open questions](../economics/risks-and-open-questions.md).

## Marking costs gas and pays later

A mark pays nothing when you make it. You are paid the marker's share only if the position is later liquidated while your mark stands. If the borrower recovers, or the mark expires, you get nothing and have spent the gas. Marking with `barkFor` credits another address, which is how a bundled `relayAndBark` pays the keeper instead of the relay contract.

## Relaying costs money

Relaying an attestation costs gas, and buying one costs whatever the oracle service charges. The protocol normally buys its own updates from the Treasury through `OracleAsker` ([How updates are paid for](../reference/oracle-and-question-binding.md#how-updates-are-paid-for)), and triggering it with `ask`, `arm` or `fundOracle` costs you only gas.

Relayers are not reimbursed and earn no direct reward. The benefit is indirect: a relay unlocks the actions that do pay (marking, liquidating) and keeps the protocol working.

## What you must hold

Three separate balances:

1. **ETH for gas.** Every relay, mark, liquidation and clear mark.
2. **imdUSD.** Liquidation burns the caller's imdUSD, so a keeper with none cannot liquidate anything. This is working capital, not an expense: it comes back as sIMD at a discount, which you hold, or unstake and sell.
3. **IMD, only if you want to buy updates yourself** when the protocol's daily budget is spent. The Treasury normally pays.

If you liquidate through `SwarmRelay`, also approve the relay to spend at least the amount of imdUSD you repay.

## Risks you carry

- **Price risk on what you receive.** You are paid in sIMD, whose dollar value moves with IMD. You carry that risk until you sell, and unstaking takes at least one more block: sIMD received in a block cannot be unstaked in the same block.
- **Small positions.** Gas must cost less than the part of the bonus you keep.
- **Races.** Other keepers can mark, liquidate or relay first, and you pay gas for a reverted transaction. Bundling with `relayAndBite` closes the gap between your price update and your liquidation, but not the race to get into a block.
- **Stale or disagreeing feeds** halt every action that pays you.
- **Underwater positions.** If a position is worth less than its debt plus the bonus, no one can profitably liquidate all of it.
- **Stranded rewards.** If `SwarmRelay` is a position's recorded marker and the position is then liquidated directly, the marker's share goes to the relay and cannot be recovered. Mark with `relayAndBark` or with `barkFor` naming your own address.

## Operating notes

Run the keeper from a hot wallet on its own machine; no privileged key is needed. Before paying for a price update, ask the feed whether it would take the value (`accepts(value)`): a refused update is still charged. Give every transaction a gas limit above the node's estimate; the vault's cost can rise slightly between estimate and inclusion. The Treasury does not fund keepers, so top up the keeper from your own funds.
