# Genesis points

Off-chain points for INFER's genesis season. Nothing is stored or computed on chain: points come from
the imdUSD token's standard `Transfer` events and the vault's liquidation event, and anyone can rerun
this and get the same numbers.

## The rule

**1 point = 1 imdUSD held for 1 day.**

| Who | Earns | Rate |
|---|---|---|
| imdUSD in a wallet | balance × days held | 1× |
| imdUSD provided to the imdUSD/USDC pool | position × days | 3× (default), because the launch needs liquidity |
| Liquidators | debt repaid × 3 days | flat credit per liquidation |
| Borrowing, redeeming | nothing by themselves | a borrower earns by holding or providing what they mint |

- **Points belong to an address, not to the token.** A buyer earns from the block the imdUSD arrives;
  the seller keeps what it earned and stops. Nothing moves with the token.
- **Flat and linear.** Splitting across wallets earns exactly the same, and a late entrant earns at the
  same rate as an early one. Only the balance at the end of a block counts, so a flash loan earns
  nothing.
- **Excluded:** the vault, the Treasury (stability fees are minted to it) and the Uniswap v4
  PoolManager, whose imdUSD belongs to the LPs and is credited to them at the liquidity rate.
- **Counting:** from the stablecoin's deployment, still counting (`endBlock` unset). INFER's seasons are
  opened on chain by governance, each with its own rules committed when it opens.

**Time is measured in blocks**: a day is 7,200 blocks at 12 seconds. Every holder sees the same block
count, so each share is exact. Only the absolute figure moves with a missed slot. No timestamps are
needed, so any RPC or explorer reproduces the same numbers.

**Liquidity** (`lp.ts`): imdUSD put into the peg pool less imdUSD taken out, per wallet, never below zero,
read from the imdUSD transfers to and from the PoolManager inside transactions that emit the pool's
`ModifyLiquidity` (pool `0x3cb8cc9c…2992035`, from block 26,167,383). The amount deposited, not the
position's value at each block, so it needs only logs.

## Season 1 rules (`season1.ts`)

The preseason closed at block 26,206,625 and its engine (`engine.ts`) is unchanged, so its frozen totals
reproduce. Season 1 uses `season1.ts`, written after 2026-10-16, when the pool was pushed to $0.899 and ~48k
borrowed imdUSD was parked in a range above the price (under "imdUSD deposited x 3" that one position would
have earned ~77% of all points while weakening the peg):

| # | Rule |
|---|---|
| 1 | **Holding (1x) is for wallets only**: EOAs and EIP-7702 accounts. Pools, vaults, other hooks and every other contract earn nothing (classified by code at the block the run reads through). imdUSD in any pool but ours earns nothing |
| 2 | **Liquidity earns only in our hook pool, on its depth at the peg**: the USDC value of the position's liquidity inside $0.99-$1.01, `L x (sqrt(min(upper, $1.01)) - sqrt(max(lower, $0.99)))`, 3x. A wide range earns only for its slice; a range outside the band earns nothing |
| 3 | **Active and at peg only**: a position earns only while the pool price is inside the band AND inside its own range. When the peg is pushed away, nobody's liquidity earns |
| 4 | **One-day minimum hold**: liquidity points stay pending for 7,200 blocks after a position's last addition; removing any liquidity inside that window forfeits what is pending |
| 5 | *(off, user 2026-10-16: reward early supporters)* Holding net of your own vault debt. Available as `--net-debt` |
| - | Liquidators: debt repaid x 3 days, as before |

```bash
node points/season1-cli.ts --stablecoin 0x.. --vault 0x.. --start <block> [--end <block>] [--allow 0x..] --out season1.json
node --test points/season1.test.ts
```

With rule 5 off, a borrower who mints and holds earns 1x for the cost of collateral (170%+) and its rate. The
liquidity rules are what stop the 2026-10-16 pattern: borrowed imdUSD parked off-peg in the pool earns nothing.

## Files

- `lp.ts`: liquidity, as `lp` events for the engine (preseason).
- `season1.ts` + `pool.ts` + `tickmath.ts` + `season1-cli.ts`: Season 1 (rules above).
- `engine.ts`: the rule. Pure; the terminal imports it through Vite and the CLI runs it under Node's
  type stripping, so both always agree.
- `logs.ts` + `chains.ts`: read logs from Blockscout, never a public RPC's `eth_getLogs`, which can
  silently return an empty array. Zero logs is an error, never "nobody holds anything".
- `cli.ts`: writes the leaderboard as JSON.

## Run

```bash
node points/cli.ts --stablecoin 0x.. --vault 0x.. --chain ethereum --exclude <treasury> --out points.json
node --test points/engine.test.ts points/lp.test.ts
```

**Only mainnet counts.** Testnet balances cost nothing to fake.
