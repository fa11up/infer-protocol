---
title: Relay oracle updates
section: keepers
order: 3
audience: keepers
sources:
  - src/SwarmRelay.sol:10-134
  - src/SwarmFeed.sol:26-62
  - src/SwarmFeed.sol:152-244
  - src/SwarmFeed.sol:283-496
  - src/UsdPriceFeed.sol:23-95
  - oracle/relay-attestation.js:1-60
  - docs/MAINNET-RUNBOOK.md:72-86
---

# Relay oracle updates

No key can push a price into the vault. A feed changes only when someone submits a valid signed attestation, and anyone can do that through `SwarmRelay`. This page covers what you relay, how, and why the relay can carry the action that needs the price in the same transaction.

## What the feeds are

| Feed | Contract | Holds |
|---|---|---|
| Primary | `PriceFeed` | IMD/ETH over a block window |
| Spot | `SpotFeed` | IMD/ETH at the last block of a window |
| Network health | `NhiFeed` | The network health index |

A fourth reading, IMD/USD, is computed by `UsdPriceFeed` from the primary feed and Chainlink ETH/USD. It takes no attestations; Chainlink keeps its ETH/USD leg up to date. Addresses: [Contracts and addresses](../reference/contracts-and-addresses.md).

## Why a relay contract

Each feed accepts updates from exactly one caller, written into its code, and that caller is `SwarmRelay`. Calling `submitAttestation` on a feed from anywhere else reverts with `UnauthorizedRelayer`. The relay is open to everyone, has no owner, holds nothing and cannot alter an attestation. Every feed check still runs, so the worst a caller can do is deliver an update the feed would have accepted anyway, or waste their own gas.

It is a contract rather than a key for two reasons. Several feeds can update in one transaction, so the vault never compares a new price with a network health figure from a block earlier. And an update can be bundled with the action it unlocks, so no one can act on the new price between your update and your call.

## Where attestations come from

An attestation is a signed answer from the IdentityMD oracle service, bound to one chain and one feed: a request must name the target feed, or the signature will not verify. It carries the figure the feed will store, the block window it covers, the panel counts, and issue and expiry times. You pass it with its 65-byte signature. The full field list is in [Oracle and question binding](../reference/oracle-and-question-binding.md).

Most updates arrive without a keeper: the protocol buys them from the Treasury and delivers them through `SwarmRelay` itself. A keeper's part is to trigger those purchases when the chain allows, and to relay by hand when an automatic delivery fails or the day's budget is spent. See [How updates are paid for](../reference/oracle-and-question-binding.md#how-updates-are-paid-for).

## What a feed checks

On `submitAttestation`, a feed reverts with the first of these that applies:

| Error | Meaning |
|---|---|
| `UnauthorizedRelayer` | The caller is not `SwarmRelay` |
| `InvalidAttestationChain` | The attestation reads a different chain than the feed's question |
| `PanelTooSmall` | Fewer panel members than the feed's minimum (`MIN_PANEL_SIZE`) |
| `NotEnoughAgreement` | Fewer agreeing members than `MIN_AGREED`, or more than the panel |
| `InvalidAnswerType` | Wrong answer type |
| `ExpiredAttestation` | Past its expiry |
| `InvalidTimestamp` | Issued in the future, or after its own expiry |
| `StaleAttestation` | Issued longer ago than the feed's maximum age, or earlier than the value the feed already holds |
| `ReplayedAttestation` | This request was already used |
| `InvalidSignature` | Not signed by the oracle service's key |
| `InvalidWindow`, `WindowSpanOutOfRange`, `WindowNotAdvancing` | The block window is backwards, the wrong length, or not later than the last accepted one |
| `WindowInFuture`, `WindowTooOld` | On a feed whose data lives on its own chain (every mainnet feed): the window ends after the current block, or more than one feed lifetime ago |
| `WrongQuestion(expected, given)` | It answers a different question than this feed's |
| `ZeroValue` | The figure is zero |
| `ExcessDeviation` | The figure is too far from the current epoch's anchor, or, inside a widened epoch, from the first value accepted in it |

A newly deployed feed has no value and counts as stale. Freshness is measured from when the attestation was signed, so delivering it late does not make it last longer. The move limit is measured against an anchor that holds for one feed lifetime, and it widens the longer a feed has been silent (twice the normal limit an hour past its maximum age, more for every further hour), so after a large price move the feed catches up after a delay rather than never; `epoch()` tells you how far the next value may move. [Oracle and question binding](../reference/oracle-and-question-binding.md) explains the rules.

Before buying a request, you can ask a feed what it will accept: `expectedQuestionHash(fromBlock, toBlock)` returns the question hash for that window.

## Relay: the four entry points

All four are on `SwarmRelay` and open to anyone.

1. **`relay(feed, attestation, signature)`** delivers one attestation to one feed.
2. **`relayMany(feeds, attestations, signatures)`** delivers several in one transaction. The lists must be the same length (`LengthMismatch`). It is all or nothing: if any feed refuses, the whole call reverts, so a set of feeds the vault compares is never half updated.
3. **`relayAndBark(feeds, attestations, signatures, vault, borrower)`** relays, then marks the borrower with you as the marker by calling `vault.barkFor(borrower, msg.sender)`. A plain `bark` would record the relay as the marker and strand the marker's share. It moves no tokens.
4. **`relayAndBite(feeds, attestations, signatures, vault, borrower, debtToRepay)`** relays, then liquidates in the same transaction.

### Why bundle

Between a separate update and your call, another keeper can see the new price and act first, and a liquidation that needs the fresh price fails if the update has not landed. Bundled, the update and the action succeed or fail together, and nobody can act on the new price in between.

### How `relayAndBite` handles tokens

The vault burns the caller's imdUSD and pays the caller the seized sIMD, and here the caller is the relay. So:

1. You approve `SwarmRelay` for at least `debtToRepay` of imdUSD.
2. The relay pulls exactly `debtToRepay`, never more; any extra approval stays unused.
3. It calls `vault.bite(borrower, debtToRepay)`.
4. It sends you all the sIMD the vault paid it, measured by its balance change.
5. It checks it holds no more imdUSD or sIMD than before, and reverts with `StablecoinRetained` or `CollateralRetained` otherwise.
6. It emits `RelayedLiquidation(keeper, vault, borrower, debtRepaid, seized)`.

Because it measures balance changes, tokens sent to the relay by someone else can neither be claimed by a liquidator nor make the checks fail for everyone.

## When a relay fails

- A feed that refuses reverts the whole call, including any bundled action. That is intended; find the reason in the table above.
- If another keeper delivers the same attestation first, yours reverts with `ReplayedAttestation` or `StaleAttestation`. Read the feed and move on.
- A feed that is still fresh does not need an update.
- The ETH/USD leg can go stale on its own. Price-dependent actions then revert with `StaleFeed`, and no attestation you relay fixes it.
