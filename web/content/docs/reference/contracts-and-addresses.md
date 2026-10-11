---
title: Contracts and addresses
section: reference
order: 1
audience: integrators
sources:
  - docs/MAINNET-RUNBOOK.md:194-360
  - script/DeployMainnet.s.sol:1
  - src/ParameterizedVault.sol:25-309
  - src/CDPVault.sol:274-328
  - src/ImdUSD.sol:19-75
  - src/SwarmFeed.sol:26-156
  - src/SwarmRelay.sol:37-134
  - src/Treasury.sol:36-323
  - src/WorkOracleFactory.sol:29-38
  - src/SwarmWorkOracle.sol:50-232
  - src/SharePriceFeed.sol:36-93
  - src/UsdPriceFeed.sol:23-96
  - src/OracleAsker.sol:1
---

# Contracts and addresses

`ParameterizedVault` is the imdUSD vault: it holds every position (an account's collateral and debt) and is the only contract that mints or burns imdUSD. Start with [What is imdUSD](../overview/what-is-imdusd.md) for the overview.

All addresses are on Ethereum mainnet, and every contract below is verified on Etherscan and Sourcify. The vault was deployed at block 26166417 on 11 October 2026.

Some contracts are deployed on their own; the vault creates the rest in its constructor. To find a vault-created contract, read the vault's getter, then check that the contract names the vault back before you integrate with it. A listed address is not proof of a deployment until you have checked it on chain.

| Contract | Address | Fixed links and governed values |
|---|---|---|
| `SwarmRelay` | [`0x9AEb55c7A16C11B37DC96BD22a33906D1668e20B`](https://etherscan.io/address/0x9AEb55c7A16C11B37DC96BD22a33906D1668e20B#code) | No owner, settings or upgrade path. Each call names its own targets. |
| `WorkOracleFactory` | [`0x24458aeF6cf074C7FB09B6734b1247508f137409`](https://etherscan.io/address/0x24458aeF6cf074C7FB09B6734b1247508f137409#code) | Anyone may call it; no governor or settings. The vault's copy of its address is written into the contract. |
| `PriceFeed` | [`0x070e0603737242B01aBC1D223f7C92D63E86EC97`](https://etherscan.io/address/0x070e0603737242B01aBC1D223f7C92D63E86EC97#code) | Inherits `SwarmFeed`. Signer, relayer, data chain, answer type and question are written into the contract. Maximum age (one hour) and deviation bound (2,000 basis points, 20%) are set once at deployment. |
| `NhiFeed` | [`0x014DabF6F940c9C383D9ef48636F70D842F65D7A`](https://etherscan.io/address/0x014DabF6F940c9C383D9ef48636F70D842F65D7A#code) | Same setup as `PriceFeed`, with its own question. Maximum age (one day) and deviation bound (20%) are set once at deployment. |
| `SpotFeed` | [`0x77E1684402869Bf2B7c70B8bf21E1C7Ca7104951`](https://etherscan.io/address/0x77E1684402869Bf2B7c70B8bf21E1C7Ca7104951#code) | Same setup, with its own question. Maximum age (one hour) and deviation bound (20%) are set once at deployment. |
| `OracleAsker` | [`0x00856Bd495941f3b95dA5b7e374c76d822C9059E`](https://etherscan.io/address/0x00856Bd495941f3b95dA5b7e374c76d822C9059E#code) | No owner or settings. Its feeds and their request bodies are fixed at deployment. Pays only when the health feed is close to stale, when any feed has been silent a whole lifetime with its allowance wide open, or when IMD's pool has fallen below a price feed (never for a rise); see [How updates are paid for](./oracle-and-question-binding.md#how-updates-are-paid-for). The Intake reports a request that ends without an answer straight back to it, which frees the feed for the next purchase at once. |
| `ParameterizedVault` | [`0x0b69F8DA8D8cE521d74Ea69a7A3475B77302EF82`](https://etherscan.io/address/0x0b69F8DA8D8cE521d74Ea69a7A3475B77302EF82#code) | Collateral (sIMD), stablecoin, the three feeds, `parameters`, `treasury`, `usdPriceFeed` and `collateralPriceFeed` are all fixed. Economic settings come from its own `Parameters`. No upgrade path and no way to swap a feed. The work oracle it creates can be replaced through `Parameters`, only while minting from work is off; `oracle()` returns whichever is in use. |
| `ImdUSD` | [`0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25`](https://etherscan.io/address/0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25#code) | Bound to the vault for good; only the vault mints and burns. No governor, pause or upgrade. |
| `Parameters` | [`0x3D96A6Ffada9C2E5B8fF8eb3f8AFB360116dA881`](https://etherscan.io/address/0x3D96A6Ffada9C2E5B8fF8eb3f8AFB360116dA881#code) | Its vault cannot be changed. The governor and every hard limit are written into the contract; changes go through the delay in [Parameters](../governance/parameters.md). |
| `Treasury` | [`0x6Ac8fF96Fb8DCF5d79A8eF1E59D9AC23f2BD27Bc`](https://etherscan.io/address/0x6Ac8fF96Fb8DCF5d79A8eF1E59D9AC23f2BD27Bc#code) | Serves only its vault; that vault's `Parameters` governs which reserve assets are listed and how they are priced. `feeRecipient()` returns it. The operator can never withdraw the collateral (sIMD) or a listed reserve asset, and can withdraw imdUSD only above what outstanding bad debt still needs. Anyone may call `payStream()` (a governed daily imdUSD payment to a governed payee) and `fundOracle()` (a governed daily IMD budget for price updates). |
| `TreasuryFactory` | [`0xbF6410aD823F49D24935135EE230db89faBca6B2`](https://etherscan.io/address/0xbF6410aD823F49D24935135EE230db89faBca6B2#code) | No owner or settings. It exists so the vault's deployment code stays under the network's size limit. |
| `UsdPriceFeed` | [`0x297b85afc6bbF9d9cCa636F7ED74c56DA79287A0`](https://etherscan.io/address/0x297b85afc6bbF9d9cCa636F7ED74c56DA79287A0#code) | Its IMD/ETH feed is fixed; the Chainlink address and its maximum age (two hours) are written into the contract. No settings or governor. |
| `SharePriceFeed` | [`0xF065C8b65AA9Ac6fd9cBAd15301738e91389d9e1`](https://etherscan.io/address/0xF065C8b65AA9Ac6fd9cBAd15301738e91389d9e1#code) | Fixed to sIMD and to the vault's `UsdPriceFeed`. No settings. Quotes USD per 1e18 raw sIMD units. |
| `SwarmWorkOracle` | [`0xC7335a836ad85a6ac0830c6CEf602d735B9d8a8A`](https://etherscan.io/address/0xC7335a836ad85a6ac0830c6CEf602d735B9d8a8A#code) | Vault, signer, relayer, question and identity adapter are fixed; maximum age (one day) is set once. It has no move limit, since its value is a Merkle root. `wage()` reads the vault's governed settings. |

## Contracts the protocol uses

These are not part of the imdUSD deployment, but the contracts above read or pay them.

| Contract | Address | Role |
|---|---|---|
| IMD | [`0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7`](https://etherscan.io/address/0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7) | What sIMD stakes, and what oracle updates are paid in. |
| sIMD (Staked IMD) | [`0x9Efa934D9fAd4AE28c998a40195646b965a97247`](https://etherscan.io/address/0x9Efa934D9fAd4AE28c998a40195646b965a97247) | The vault's collateral (`gem()`); IdentityMD's ownerless staking vault. |
| IdentityMD Intake | [`0xa43e6F75ee006411F79Ac1C84120606C2330DE82`](https://etherscan.io/address/0xa43e6F75ee006411F79Ac1C84120606C2330DE82) | Sells oracle answers; `OracleAsker` pays it and only it may call back. |
| Chainlink ETH/USD | [`0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419`](https://etherscan.io/address/0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419) | Turns the IMD/ETH price into USD in `UsdPriceFeed`. |
| Governance Safe | [`0xbeFd108085613662356aa26A2466Ad3426DA9C32`](https://etherscan.io/address/0xbeFd108085613662356aa26A2466Ad3426DA9C32) | The governor of `Parameters` and the Treasury's operator, a 2-of-3 Safe. Every change waits out the delay in [Parameters](../governance/parameters.md). |
| `PegFeeHook` | [`0x33cA5c16208EC08aC97d4f6315aaFA792A916044`](https://etherscan.io/address/0x33cA5c16208EC08aC97d4f6315aaFA792A916044#code) | The imdUSD/USDC pool's fee hook; its surcharge goes to the Treasury. See [The peg pool](../overview/the-peg-pool.md). |

## Constructor and read-back checks

`ParameterizedVault(address gem_, address stablecoin_, address oracle_, address priceFeed_, address nhiFeed_, address spotFeed_)` takes six contract addresses. The three feeds must be different deployed contracts. The collateral must be a deployed contract and must not be the stablecoin. A work oracle passed in must answer `mintingRights(address)`, and if it has a `vault()` getter, that getter must name this vault. On mainnet the vault is given a reserved placeholder address for the work oracle instead, which tells it to build one through the factory.

The deployment runs in two stages. The first deploys everything but the vault at addresses computed in advance from fixed salts (the contracts that read each other's addresses as constants need them before they are compiled). The feeds' first values are then bought, relayed and checked against IMD's pool and an outside reference price, because nothing on chain bounds a feed's first value. Only then does the second stage deploy the vault, from a salt the operator keeps private and through a private transaction relay, so nobody can deploy the vault at its address first. Nothing reads the vault's address as a constant.

Once deployed, `parameters().vault()`, `treasury().vault()` and `stablecoin().vault()` must all return the vault, and so must `oracle().vault()` for `SwarmWorkOracle`. No follow-up transaction is needed to link the contracts the vault created.

## Collateral is sIMD

The vault's collateral is sIMD (Staked IMD), the 24-decimal share token of IdentityMD's staking vault, which holds IMD. `gem()` returns its address. Because sIMD is a share, the vault creates a `SharePriceFeed` to price it: the staking vault's `convertToAssets(1e18)` times the IMD/USD price from `UsdPriceFeed`, quoted per 1e18 raw sIMD units. The vault never reads `decimals()`, so quoting per raw unit is what keeps the 24-decimal share correctly valued.

`lock` takes sIMD. `lockIMD` takes IMD, stakes it on the depositor's behalf and credits the sIMD that comes back. The vault never unstakes: `free`, `bite` and `cash` pay sIMD, and the staking vault's one-block hold applies to whoever unstakes it.

The Treasury values the vault's collateral per 1e18 raw units too, so sIMD listed as a reserve asset with `collateralPriceFeed()` as its price counts at the same value the vault gives it. Listing it is a governance proposal like any other reserve change; see [Parameters](../governance/parameters.md).

See [Oracle and question binding](./oracle-and-question-binding.md) for the price sources, [Vault functions](./vault-functions.md) for everything you can call, and [Risks and open questions](../economics/risks-and-open-questions.md) for who holds which powers.
