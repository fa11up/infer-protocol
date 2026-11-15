---
title: About imdUSD and INFER
section: overview
order: 0
audience: everyone
sources:
  - src/ImdUSD.sol:12-75
  - docs/MAINNET-RUNBOOK.md:194-360
  - web/src/site.tsx:41
  - web/worker/supply.js:1
---

# About imdUSD and INFER

**imdUSD** is a stablecoin meant to be worth one US dollar. You get it by locking staked IMD (sIMD) in the imdUSD vault on Ethereum and borrowing imdUSD against it. The vault is the only contract that can mint or burn imdUSD. The token has no owner, no pause switch and no upgrade path. Collateral is priced by attestations from the IdentityMD agent swarm: each price lands on chain only when a quorum of agents agrees. See [What is imdUSD](what-is-imdusd.md) and [How it holds a dollar](how-it-holds-a-dollar.md).

**INFER** is the protocol's token. It was launched by the IdentityMD swarm on IMD's launchpad (launch 1282). Protocol revenue goes to the INFER Treasury, and INFER can be staked as sINFER. See [infer.imdusd.com](https://infer.imdusd.com) and its [tokenomics](https://infer.imdusd.com/tokenomics/).

## Contracts (Ethereum mainnet)

| Contract | Address |
| --- | --- |
| imdUSD (token, 18 decimals) | `0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25` |
| imdUSD vault | `0x0b69F8DA8D8cE521d74Ea69a7A3475B77302EF82` |
| INFER (token, 18 decimals) | `0x53d0eA0A685220718Dc6a0a6e4617194C6F37921` |
| Treasury | `0x6Ac8fF96Fb8DCF5d79A8eF1E59D9AC23f2BD27Bc` |

Every core contract is verified on Sourcify (chain 1). The full list is in [Contracts and addresses](../reference/contracts-and-addresses.md).

## Supply

Read live from the chain (refreshed at most every minute):

- imdUSD: [total](https://infer.imdusd.com/supply/imdusd/total), [circulating](https://infer.imdusd.com/supply/imdusd/circulating)
- INFER: [total](https://infer.imdusd.com/supply/infer/total), [circulating](https://infer.imdusd.com/supply/infer/circulating)
- Both, with the holders left out of circulating: [supply.json](https://infer.imdusd.com/supply.json)

Circulating supply is total supply minus what protocol contracts hold and haven't released. For imdUSD that's the Treasury. For INFER it's the Treasury, the SeasonVault (season rewards not yet paid), the LegacyRedeemer (set aside for legacy redemptions), the FounderStream (not yet vested) and the InferDripper (not yet dripped). Staked INFER (sINFER) belongs to its holders and counts as circulating.

## Reviews

The contracts were reviewed by IdentityMD swarm panels and in-house reviews before launch. Every record is in the [audit history](../reference/audit-history.md). These are not third-party audit firm reports.

## Links and contact

- X: [@imdusd](https://x.com/imdusd). Messages there reach the team.
- Code: [github.com/imdusd](https://github.com/imdusd)
- Data: the protocol's verified event index at [imdusd.com/api/v1/meta](https://imdusd.com/api/v1/meta)
- DefiLlama: [INFER](https://defillama.com/protocol/infer)
