---
title: What is imdUSD
section: overview
order: 1
audience: everyone
sources:
  - src/ImdUSD.sol:12-75
  - src/ParameterizedVault.sol:11-25
  - src/ParameterizedVault.sol:142-154
  - src/CDPVault.sol:432-490
  - docs/NAMING.md:1-12
---

# What is imdUSD

imdUSD is a stablecoin meant to be worth one US dollar. You get it by locking staked IMD in a vault and borrowing imdUSD against it.

The collateral is **sIMD** (Staked IMD), the share token of IdentityMD's staking vault: each sIMD is a claim on IMD, the IdentityMD token, held by that vault. You can deposit sIMD you already hold, or deposit IMD and the vault stakes it for you in the same transaction. Everything the vault pays out (withdrawals, liquidations and redemptions) is paid in sIMD, which you unstake in the staking vault to get IMD.

The vault is the only contract that can mint or burn imdUSD. The token (`ImdUSD`) has no owner, no pause switch and no upgrade path. The vault is [`0x0b69F8DA8D8cE521d74Ea69a7A3475B77302EF82`](https://etherscan.io/address/0x0b69F8DA8D8cE521d74Ea69a7A3475B77302EF82) and imdUSD is [`0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25`](https://etherscan.io/address/0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25) on Ethereum mainnet; every address is in [Contracts and addresses](../reference/contracts-and-addresses.md).

## Who it is for

- **Borrowers** who hold IMD or sIMD and want dollars without selling it. Start with [Open a position](../guides/open-a-position.md).
- **Holders** who want to turn imdUSD back into staked IMD. See [Redeem](../guides/redeem.md).
- **Keepers**, who keep the system solvent by relaying prices and liquidating unsafe positions, and are paid from the liquidation bonus. See [How liquidation works](../keepers/how-liquidation-works.md).

## What backs it

Two things stand behind imdUSD:

1. **Collateral.** Every position must hold more sIMD, valued in dollars, than the imdUSD it owes. The required margin (the minimum collateral ratio, `mat`) rises and falls with the health of the IdentityMD network.
2. **A reserve.** The protocol's Treasury holds sIMD and any other assets governance lists. Redemptions are paid from it first.

The dollar price of IMD is not read from an exchange contract. A panel of IdentityMD agents answers a fixed question about it, the answer is signed, and anyone may submit it on chain. sIMD is then valued as the IMD it is a claim on. [How imdUSD holds a dollar](./how-it-holds-a-dollar.md) explains how these pieces keep the price near $ 1.

## What it pays when redeemed

A holder can burn imdUSD for sIMD worth $ 1, less a fee. If the system holds less than $ 1 of backing per imdUSD, the payout shrinks to match instead of redemption closing.

## What is unproven

- The peg depends on traders buying imdUSD below the redemption price. Nothing guarantees the market price stays at $ 1.
- The price comes from one signer, the IdentityMD oracle service, answering one fixed question. Minimum panel sizes, the fixed question and a second comparison price limit that trust; they do not remove it.
- Network health is also a signed figure, and it moves both the collateral requirement and how long a marked borrower has to recover.
- A liquidation can leave bad debt. There is no insurance fund. Anyone can cancel a drained position's bad debt with imdUSD the Treasury holds (`cover`), but only as far as the Treasury has it.
- Minting from work (`earn`) rests on a task tally the swarm publishes and a panel signs. It is not an on-chain proof that the work happened.
- The economic settings are set at launch and can then be changed by one governing account, a multisig wallet that needs two of its three signers, only within hard limits written into the contracts and only after a public 48-hour delay; see [Parameters](../governance/parameters.md) and [Risks and open questions](../economics/risks-and-open-questions.md).

## A note on names

The vault's verbs and settings (`lock`, `draw`, `bite`, `mat`, `duty` and the rest) are an homage to MakerDAO, which invented the collateralised stablecoin. Their origins are recorded in `docs/NAMING.md`. These guides name actions in plain words, with the contract name alongside.
