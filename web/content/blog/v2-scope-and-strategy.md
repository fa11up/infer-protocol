---
title: "imdUSD v2: scope and strategy"
date: 2026-10-21
updated: 2026-10-21
summary: "Where imdUSD goes next: a multi-collateral dollar with a permissionless peg, self-repaying positions, identity.md seat staking and more chains. A living document, updated as the build moves."
author: imdUSD
living: true
---

*A living document. It describes where we intend to take the protocol and is updated as the work moves; the
changelog at the end lists every change. Nothing here is live until it is deployed, audited and announced.*

## The short version

imdUSD v1 proved the idea: a dollar borrowed against staked IMD and priced by the swarm, running on Ethereum
mainnet since 11 October 2026, its price set by the swarm rather than by a team. v2 is the version built to grow:

- **Many collaterals, not one.** sIMD, ETH, wstETH, BTC, yield-bearing stablecoins, imdUSD v1 itself, and
  identity.md seats.
- **A peg nobody has to babysit.** Redemptions set the floor and a keeper inside our own pool hook sets the ceiling.
  Both are permissionless, and neither needs a custodial reserve.
- **Positions that repay themselves.** Collateral that earns (stablecoin vault yield, seat rewards) pays down the
  debt against it.
- **Seat staking.** Pledge an identity.md seat, keep it earning, and borrow against it.
- **More chains.** One dollar across Ethereum and Robinhood Chain first, with others after.

We will open v2 as a capped **live beta before Season 1 ends**, and open migration from v1 when Season 1 is over.

## Why a v2, and why a new system

v1 cannot simply be upgraded, by design:

- **Its minter is permanent.** The v1 token accepts exactly one minter, fixed at deployment. No new vault can ever
  mint v1 imdUSD. That is a safety property, and it means growth needs a new system.
- **It is built around one collateral.** One collateral, one price feed, one liquidation penalty. Adding ETH or BTC
  in place is not possible.
- **It is at its size limit.** The v1 vault contract is within a thousand bytes of Ethereum's contract size cap.

v1 also taught us where the hard parts are, and v2 is designed around them:

- **The peg needs buyers, not just rules.** v1's redemption floor works, but when the price feeds lag the market,
  redeeming pays less than the pool does and nobody redeems. v2 redemptions read the live market as well as the
  attested price, and every collateral type has its own fees and limits.
- **Depth at $1 is thin.** A stablecoin is only as good as the size you can trade at $1. v2 adds a protocol-run peg
  keeper, a small below-peg reserve and an LP vault that keeps liquidity in the band.
- **One collateral means one risk.** Every v1 loan moves with IMD. v2 spreads borrowing across assets with their own
  markets and their own prices.

## Principles

1. **Permissionless at the edges.** Borrowing, repaying, redeeming, liquidating and keeping the peg are open to
   anyone, with no keys and no operator.
2. **A fresh price or no new debt.** Borrowing and withdrawing need a fresh, agreeing price, exactly as in v1;
   repaying and depositing never wait. This is our calling card, not a limitation.
3. **Governance sets floors, not prices.** Borrowers choose their own interest rate; governance only sets the minimum
   per collateral, through a public 48-hour timelock. The governance Safe cannot mint imdUSD, cannot touch anyone's
   collateral and cannot change a collateral's price source once it is listed.
4. **One Treasury.** Every product pays its fees into the same imdUSD Treasury. No new tokens, no emissions.
5. **Show the work.** Every contract is verified, every parameter is on chain, every change waits out a timelock.

## What v2 includes

### A multi-collateral core

Each collateral is its own type with its own price, risk settings and debt ceiling:

| Collateral | What it is | Notes |
|---|---|---|
| **sIMD** | Staked IMD, as in v1 | Priced by the swarm's IMD feeds, as today |
| **ETH, wstETH** | Ether and Lido staked ether | Chainlink prices |
| **BTC** | cbBTC and WBTC | Chainlink prices, one type per wrapper |
| **Stablecoins, earning** | USDC, USDT or USDS deposited into an approved savings vault for you | The vault's yield repays your debt |
| **Stablecoins, held** | The same coins, kept as they are | No yield and no third-party vault risk |
| **imdUSD v1** | v1 dollars, 1:1 | The migration path from v1 |
| **identity.md seats** | The 2,000 swarm seats | See *Seat staking* below |

Risk settings start conservative and are only ever loosened through the timelock.

### Borrower-set rates

There is no single global interest rate. Each borrower picks their own, at or above the floor for their collateral.
Redemptions take from the lowest rates first, so a higher rate buys protection from redemption. The rate becomes a
market price, and protocol revenue rises exactly when the peg is under pressure.

### The peg: a floor and a ceiling, both permissionless

- **Floor: redemptions.** Anyone can hand in imdUSD and receive $1 of collateral from the lowest-rate loans, minus a
  small fee that goes to the borrowers redeemed. The payout reads the live market alongside the attested price, so a
  lagging feed cannot strand redemptions the way it does in v1.
- **Ceiling: the peg keeper.** imdUSD's own pool hook mints and sells imdUSD when it trades above $1 and buys it back
  below, within a cap set by governance, triggered by anyone and gated by a 30-minute average so a single trade
  cannot set it off.
- **Below-peg reserve.** A small USDC reserve in the hook buys imdUSD under $0.99, so the floor has a buyer on day one.

### Savings: sImdUSD

Deposit imdUSD and earn a share of what borrowers pay, streamed to savers. A savings rate is what lets other
protocols list imdUSD, and a dollar that is held is a dollar that is not sold into the pool.

### Positions that repay themselves

Collateral that earns pays down the loan against it. A stablecoin in a savings vault, or a seat earning swarm
rewards, has its earnings credited against the debt automatically. The protocol keeps 10% of that yield as its fee.

### Seat staking (identity.md NFTs)

An identity.md seat earns from the swarm, but owning one means running a worker and holding an illiquid NFT. v2 makes
a seat a working, liquid asset:

- **Borrow against your seat.** Each pledged seat sits in its own account. You keep running your worker, the seat
  keeps earning, and its rewards repay your loan. Seats are priced from real sales, start at a conservative
  loan-to-value, are capped while the market for them proves itself, and are never redeemed against.
- **Liquid seats (planned).** Holders who do not want to run a worker can deposit a seat with an operator who does,
  and hold a claim on its rewards: either a receipt for their own seat, or a share of a pool of seats. That claim can
  then be collateral too, so a seat earns, stays liquid and borrows at once.

We have checked how the IdentityMD plane pairs, schedules and pays seats against its source code, and designed the
accounts around it: one account per seat, so every seat's rewards stay attributable to that seat. We are
confirming two policy questions with the plane's developer before liquid seats ship.

### Earn vaults

- **Peg liquidity vault.** One shared position in the imdUSD/USDC pool, held between $0.99 and $1.01, compounding its
  fees. Deposit both sides, withdraw any time.
- **Loop vault (in design).** Deposit IMD and hold a target leverage on sIMD without managing it by hand, at a
  conservative target well away from liquidation.

### More chains

imdUSD v2 is a LayerZero OFT, the same standard IMD itself uses, so it moves between chains by burning on one and
minting on the other, with rate limits on every route.

- **Robinhood Chain first,** with its own full core: ETH, the chain's stablecoin, IMD, and protection for sequencer
  outages.
- **Tokenised stocks and treasuries** on Robinhood Chain are in scope but will only ship after an independent legal
  review.
- **Solana and other chains** after that.

### One terminal

imdusd.com is already a single desk: borrow, swap any token, loop, provide peg liquidity and track points from one
screen. v2 adds tabs to the same desk rather than new apps: Borrow, Swap, Earn, Stake, Points.

## How v2 launches

1. **Audit.** The swarm's audit pipeline plus our own review, before any real money.
2. **Live beta, before Season 1 ends.** v2 opens on mainnet with small debt ceilings, the loop vault and anything not
   yet audited left out. Ceilings rise through the 48-hour timelock as it proves itself.
3. **Migration opens when Season 1 ends.** Moving v1 imdUSD into v2 stays closed until then, so nobody gives up their
   Season 1 standing by trying v2 early. Season 1 continues on v1 exactly under its published rules.
4. **v2 becomes the home for what comes after.** Future seasons and new products build on v2.

During the beta the new token is called **imdUSD** and the original becomes **imdUSD v1** across our sites, so the
two are never confused.

## Roadmap

| Area | Status |
|---|---|
| Multi-collateral core, borrower-set rates, liquidations | Built, in review |
| v1 migration path | Built, opens after Season 1 |
| Redemption redesign (live price leg, per-type fees, rolling limits) | Built, in review |
| Peg keeper and below-peg reserve | Built, in review |
| sImdUSD savings | Built, in review |
| Deployment script and mainnet rehearsal | Built |
| Peg liquidity vault | Built, in review |
| Loop vault | In design |
| Seat staking and liquid seats | Designed; waiting on two policy answers from the plane |
| Robinhood Chain core | Next |
| Tokenised stocks and treasuries | After legal review |
| Audit and live beta | Before Season 1 ends |

## Ideas we have parked

These are worked out but frozen for now. Each has a reason and a trigger for picking it back up.

- **Isolated lending markets for launch tokens, paying peg liquidity.** Every token launched on imd.fun would get
  its own lending market, with part of the interest paid to imdUSD liquidity providers at the peg. Designed with the
  swarm's help, then parked: today's launch pools hold too little liquidity for safe markets. We will revisit when
  launch pools hold real depth.
- **Fee notes.** Fixed-term notes that let the protocol buy its own peg liquidity with a small, fixed cost of capital,
  repaid from revenue. Parked until v2 revenue exists to back them.
- **Oracle subscriptions.** We already run some of the plane's most-used paid price feeds; selling them as a
  shared service is a later product.
- **imdUSD as a launch pair on imd.fun.** That integration belongs to the plane's developer, who has said they are
  working on it. v2 does not depend on it.

And two things we have decided not to build: a custom stableswap curve (a concentrated position around $1 already
does the job) and vote-escrow gauges (they need token emissions, and there are none).

## What does not change

- **v1 keeps running.** Your v1 position, your v1 imdUSD and the v1 terminal keep working.
- **Season 1 rules are fixed.** They were committed on chain when the season opened and cannot be changed by anyone.
- **Nothing here is a promise of price or yield.** imdUSD is a dollar, not an investment. Everything in this document
  is a plan and may change; the changelog below records when it does.

## Changelog

- **2026-10-21** First version.
