---
title: The peg pool
section: overview
order: 3
audience: everyone
---

# The peg pool

imdUSD trades against USDC in one Uniswap v4 pool. It opened at exactly $1, charges a 0.01% fee to trade near the peg, and adds a surcharge to any swap that pushes the price away from $1. The surcharge rules live in a v4 hook, `PegFeeHook`, which has no owner and nothing anyone can change.

| | |
|---|---|
| Pool | imdUSD / USDC, Uniswap v4, Ethereum mainnet |
| Pool id | `0x3cb8cc9c22f7da5c3169d4059131ddba9e61f68230977797c03a2f1214992035` |
| Hook | [`0x33cA5c16208EC08aC97d4f6315aaFA792A916044`](https://etherscan.io/address/0x33cA5c16208EC08aC97d4f6315aaFA792A916044#code) (`PegFeeHook`, verified source) |
| Pool key | currency0 imdUSD, currency1 USDC, fee 100 (0.01%), tick spacing 1 |
| PoolManager | [`0x000000000004444c5dc75cB358380D2e3dE08A90`](https://etherscan.io/address/0x000000000004444c5dc75cB358380D2e3dE08A90) |
| Trade | [Uniswap](https://app.uniswap.org/explore/pools/ethereum/0x3cb8cc9c22f7da5c3169d4059131ddba9e61f68230977797c03a2f1214992035) |
| Source and audits | [github.com/fa11up/imdusd-peg-hook](https://github.com/fa11up/imdusd-peg-hook) |

Anyone can deploy a copy of the hook at another address and open a pool beside this one. Only the pool id above is the peg pool: pin it, not the token pair.

## What a swap pays

Every swap pays the pool's fee, 0.01%, to the liquidity providers. A swap that ends with imdUSD more than 0.25% from $1, having pushed it that way, also pays a surcharge. The surcharge is priced from where the swap **ends**:

| imdUSD price where the swap ends | Total fee (pool fee + surcharge) |
|---|---|
| $0.9975 to $1.0025 | 0.01% |
| $0.995 or $1.005 | about 0.72% |
| $0.99 or $1.01 | about 2.15% |
| $0.98 or $1.02 and beyond | 5% |

Between 0.25% and 2% from $1 the surcharge rises in a straight line, and from 2% out the total stays at 5%. A swap that moves the price **towards** $1 pays only the 0.01% pool fee, however far from $1 it starts. So does any swap that ends inside the ±0.25% band.

Three consequences of pricing by the end price:

- **A sale split into steps pays less than one swap to the same price,** about a third to a half less, because each step pays at its own end price. It never pays less than the pool fee.
- **A swap that crosses $1 is charged by where it lands,** on its whole amount, even if it started further from $1 on the other side. Arbitrage that restores the peg stops at $1 and pays only the pool fee.
- **A trade placed just before yours can push your swap past the band's edge,** so it pays the ramp. The surcharge goes to the Treasury, not to whoever placed that trade, and your swap's own price limit caps what you pay.

## Why a surcharge

Below $1, imdUSD has a floor that does not depend on this pool: redemption swaps imdUSD for collateral, for a fee of 0.5% to 5% (see [Redeem](../guides/redeem.md)). A swap that pushes imdUSD to $0.98 or below pays 5%, the most redemption ever charges, so a large sale that would break the peg costs at least as much as redeeming would, while redemption itself pulls the price back towards $1. Above $1 the same surcharge applies to buying, and the cheaper source of imdUSD is borrowing it from the vault. The surcharge falls away as the price returns to the band.

## Where the surcharge goes

The surcharge is taken in the currency on the swap's unspecified side: the output of an exact-input swap, the input of an exact-output one. The hook holds it as PoolManager claims (ERC-6909), which never moves a token during the swap, so no swap can fail on it. Anyone may call `sweep(currency)` on the hook to turn the claims into tokens at the imdUSD [Treasury](../reference/contracts-and-addresses.md) (`0x6Ac8fF96Fb8DCF5d79A8eF1E59D9AC23f2BD27Bc`). Liquidity providers earn the 0.01% pool fee only.

## What the hook allows

`PegFeeHook` attaches to exactly one pool. Its `beforeInitialize` refuses any pool key other than imdUSD/USDC at fee 100, tick spacing 1, with this hook, and any opening price other than exactly $1. It has no owner, no settings and no storage: the fee, the band, the ramp, the Treasury and the tokens are fixed in the contract. Its address carries exactly the three hook permissions it uses: `beforeInitialize`, `afterSwap` and `afterSwapReturnDelta`.

Read-only helpers: `stablePrice(sqrtPriceX96)` gives imdUSD's price in USDC (1e18 = $1), `feeFor(sqrtPriceX96, zeroForOne)` gives the total fee in hundredths of a basis point for a swap ending at that price, and `surchargeFor` gives the surcharge alone.

## Adding liquidity

The first position covers $0.9524 to $1.05. Anyone may add liquidity through Uniswap's PositionManager like any v4 pool, at any range. The first deposit was bounded at $1: each token's maximum was what a $1 position needs, so a pool pushed off the peg before it would have made the deposit revert rather than land at a moved price. Deposit the same way, with `amount0Max` and `amount1Max` set for the price you expect.

## Audits

The hook went through three panel audits on the IdentityMD network, each with four specialists and a judge who reproduces every claim. The full record is `audits/AUDIT-2026-10-10.md` in the hook's repository.

| Round | Job | Findings (C/H/M/L/I) | What changed |
|---|---|---|---|
| 1 | [`5648bda5`](https://explorer.imd.fun/jobs/5648bda5-e878-45f4-8dcd-b20102b4af0c) | 0/1/1/3/2 | The fee had been priced from the price before each swap, which a seller could route around. Redesigned around the end price. |
| 2 | [`3d492b20`](https://explorer.imd.fun/jobs/3d492b20-162b-4b2e-a680-f78b4ef7dcf4) | 0/0/2/3/3 | The surcharge was sent to the Treasury during the swap, so a refused transfer could stop swaps. It is now held as claims and swept separately. |
| 3 | [`442fd649`](https://explorer.imd.fun/jobs/442fd649-f535-4fd4-b3d7-bcffafa490b9) | 0/0/1/3/3 | No finding in the claims or the sweep. An empty-pool guard added in round 2 could be switched off, so it was removed: a bounded first deposit protects the pool instead. |
