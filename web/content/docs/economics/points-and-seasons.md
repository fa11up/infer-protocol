---
title: Points and seasons
section: economics
order: 4
audience: everyone
sources:
  - points/season1.ts
  - points/preseason.ts
  - points/engine.ts
  - points/season1-cli.ts
  - points/cli.ts
---

# Points and seasons

Points are how INFER is shared out to the people who use imdUSD. They are counted from public chain data only, by
open code anyone can run, and paid in seasons from the SeasonVault, an INFER contract no single key controls.

## The short version

- **Hold imdUSD in a wallet**: 1 point per imdUSD per day.
- **Provide liquidity at the peg**: 3 points per day for each dollar of your liquidity between $0.99 and $1.01 in the
  imdUSD/USDC pool, but only while the pool's price is inside that band and inside your range.
- **Liquidate an unsafe position**: 3 days of holding points for each imdUSD of debt you repay.
- A season lasts 91 days. At the end, each wallet gets a share of the season's INFER in proportion to its points.

## Season 1

Season 1 is opened on chain by governance with `openSeason(startsAt, pot, formula)` on the SeasonVault. Opening
fixes three things, none of which can be changed afterwards:

- **When it runs**: from `startsAt` for exactly 91 days (7,862,400 seconds). Opening needs at least 48 hours' notice.
- **The pot**: the INFER set aside for the season, held in the SeasonVault from that moment.
- **The rules**: `formula` is a hash of the season's rules document. The document is published after the season, and
  the contract refuses any payout computed from a document whose hash does not match. Nobody can change the rules
  mid-season, including us.

The terminal's Points pane shows the live count.

### What earns, and why

| Rule | What it means | Why |
|---|---|---|
| Holding, 1x | imdUSD in a wallet earns 1 point per imdUSD per day, for every block you hold it. | Holding imdUSD is using it. |
| Wallets only | Ordinary wallets, EIP-7702 wallets and Safe accounts earn, for holding and for liquidity. Other contracts (pools, vaults, hooks, other smart-contract wallets) do not. imdUSD in any pool other than the peg pool earns nothing. Wallets are classified at the season's end block. | A contract's imdUSD usually belongs to someone else, or would be counted twice. |
| Liquidity at the peg, 3x | In the imdUSD/USDC peg pool, a position earns on the dollar value of its liquidity between $0.99 and $1.01. A range wider than that earns only for its slice inside the band. | Depth at $1 is what holds the peg. Liquidity far from $1 does not help it. |
| Only while at peg | A position earns only in blocks where the pool price is between $0.99 and $1.01 and inside the position's own range. | If the peg is pushed away, nobody's liquidity earns, including the pusher's. Liquidity providers are paid for keeping the price at $1. |
| One-day minimum hold | Liquidity points wait for one day (7,200 blocks) after you last added to a position. If you remove any liquidity inside that day, the waiting points are lost. | Adding liquidity just before a snapshot and removing it right after earns nothing. |
| Liquidations | A liquidator earns 3 days of holding points per imdUSD of debt it repays. | Liquidators keep the system solvent. |

Your own vault debt is not subtracted: imdUSD you borrow and hold earns like any other imdUSD.

### How payouts are worked out

1. After the season ends, the rules document is published at its IPFS address and anyone can run the reference code
   (`points/season1-cli.ts` in the public repository) over the season's blocks.
2. Each wallet's INFER is `95% of the pot × its Season 1 points ÷ all Season 1 points`, plus its preseason share
   (below). Amounts round down.
3. The amounts form a Merkle root. A swarm panel of at least 25 agents recomputes it from the published rules; if at
   least 15 agree, the root is final. If no panel answers, governance may propose a root, which takes effect after 48
   hours unless a panel's root arrives first.
4. You register your amount, and it unlocks evenly over the next 91 days. Anyone can push a claim on your behalf; the
   INFER always goes to the wallet in the root.

Unclaimed and unallocated INFER stays in the SeasonVault for later seasons.

## The preseason

Points have counted since imdUSD launched. That **preseason** ends at the block in which governance's
`openSeason` transaction for Season 1 executes; nothing is earned between then and Season 1's start.

- Preseason wallets share **5% of the Season 1 pot**, pro rata to their preseason totals, paid in the same root as
  Season 1.
- Holding and liquidations count as in Season 1. Liquidity counted imdUSD deposited at 3x until block 26,206,625
  (16 October 2026); from that block on it counts by Season 1's liquidity rules. On 16 October about 48,000 borrowed
  imdUSD was parked in a range above a pushed-down price; under the old rule it would have taken most of all points
  while weakening the peg.

## Checking it yourself

Everything is reproducible from mainnet:

```
node points/season1-cli.ts --stablecoin 0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25 \
  --vault 0x0b69F8DA8D8cE521d74Ea69a7A3475B77302EF82 --start <block> --end <block>
```

The tool refuses to report if its data looks incomplete: the replayed imdUSD supply must equal `totalSupply()` and
the replayed pool must end at the pool's live price. Set `ETHERSCAN_API_KEY` so it can read history when Blockscout
is rate-limited.

## Questions

**I use a Safe or another smart-contract wallet.** A Safe account earns like an ordinary wallet, for holding and for
liquidity (a Safe proxy pointing at one of the official Safe singletons, versions 1.1.1 to 1.5.0). Other
smart-contract wallets do not earn in Season 1: hold and provide from an ordinary, EIP-7702 or Safe wallet.

**The pool is off peg. Does my liquidity earn?** No, not until the price is back between $0.99 and $1.01. Helping it
back is what the rule pays for.

**Can I split my imdUSD across wallets for more points?** It makes no difference: points are linear in the amount
held.

**Does imdUSD I borrow count?** Yes, if you hold it in your wallet. It costs you the stability fee and collateral at
170% or more.
