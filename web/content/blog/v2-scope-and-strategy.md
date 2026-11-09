---
title: "imdUSD v2: Scope and Strategy"
date: 2026-10-21
updated: 2026-11-09
summary: "Where imdUSD goes next: a multi-collateral dollar with a permissionless peg, a standing bid that keeps liquidation value in the protocol, debt that is peg liquidity, identity.md seat staking and more chains. A living document, updated as the build moves."
author: imdUSD
living: true
---

*A living document. It describes where we intend to take the protocol and is updated as the work moves; the
changelog at the end lists every change. Nothing here is live until it is deployed, audited and announced.*

## The short version

imdUSD v1 proved the idea: a dollar borrowed against staked IMD and priced by the swarm, running on Ethereum
mainnet since 11 October 2026. v2 is the version built to grow:

- **Many collaterals, not one.** sIMD, ETH, wstETH, BTC, stablecoins, imdUSD v1 itself, and identity.md seats.
- **Positions you can hold and hand over.** Every position is an NFT with its own id. You can own many, transfer them,
  and grant a key only the rights you choose.
- **A standing bid.** Depositors stand ready to buy liquidated collateral at once, so the value of a liquidation stays
  with them instead of going to whoever runs the fastest bot.
- **A peg nobody has to babysit.** Redemptions set the floor, a toll slows moves away from $1, and a keeper inside our
  own pool hook sells above the peg and buys below it. All permissionless, none of it a custodial reserve.
- **Debt that is peg liquidity.** Bring USDC and the protocol pairs it with newly minted imdUSD in the peg pool.
- **Positions that repay themselves.** Collateral that earns (stablecoin vault yield, staked ether) pays down the
  debt against it.
- **Seat staking.** Pledge an identity.md seat, keep it earning, and borrow against it.
- **More chains.** One dollar across Ethereum and Robinhood Chain, after the beta, with others later.

The new core is built and has been through a full internal adversarial review. It has not had an outside audit yet.
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
  keeper, a below-peg buffer, an LP vault that keeps liquidity in the band and positions whose debt is itself depth.
- **One collateral means one risk.** Every v1 loan moves with IMD. v2 spreads borrowing across assets with their own
  markets and their own prices.
- **Liquidation value leaks.** In v1, bots collect what a price update makes available. v2's standing bid keeps it.

## Principles

1. **Permissionless at the edges.** Borrowing, repaying, redeeming, liquidating and keeping the peg are open to
   anyone, with no keys and no operator.
2. **A fresh price or no new debt.** Borrowing and withdrawing need a fresh, agreeing price, exactly as in v1;
   repaying and depositing never wait. This is our calling card, not a limitation.
3. **Governance sets floors, not prices.** Borrowers choose their own interest rate; governance only sets the minimum
   per collateral, through a public 48-hour timelock. The governance Safe cannot touch anyone's collateral and cannot
   change a type's price source once it is listed. It can mint imdUSD in one way only: by naming the cross-chain bridge
   as a minter, once, through that public timelock. Lowering a risk limit is instant; raising one always waits.
4. **One Treasury.** Every product pays its fees into the same imdUSD Treasury. No new tokens, no emissions.
5. **Limits measured, not posted.** Where a limit depends on market depth, the chain measures that depth itself.
6. **Show the work.** Every contract is verified, every parameter is on chain, every raise waits out a timelock.

## What v2 includes

**A multi-collateral core.** Each collateral is its own type with its own price, risk settings and debt ceiling. All
of them count toward one chain-wide cap:

| Collateral | What it is | Notes |
|---|---|---|
| **sIMD** | Staked IMD, as in v1 | Priced by the swarm. Its line opens only after its new feeds are seeded and checked |
| **ETH, wstETH** | Ether and Lido staked ether | Chainlink prices, with a second price leg for wstETH |
| **BTC** | cbBTC and WBTC | Chainlink prices, one type per wrapper, with a second price leg |
| **Stablecoins, earning** | sUSDS and Steakhouse USDC savings vaults | The vault's yield repays your debt |
| **Stablecoins, held** | USDC and USDT, kept as they are | No yield and no third-party vault risk |
| **Peg positions** | Shares of our peg liquidity vault | See below |
| **imdUSD v1** | v1 dollars, 1:1 | The migration path from v1, closed until Season 1 ends |
| **identity.md seats** | The 2,000 swarm seats | See seat staking below |

Risk settings start conservative and are only ever loosened through the timelock. A change to a type's liquidation
terms does not ambush open loans: a position stays on the terms it last took risk under, for a grace period.

**Positions as NFTs.** A position has its own id and is an ERC-721 token, and an owner can hold many per collateral.
Its whole state lives on the id, so a transfer carries its debt, rate and cooldown with it. Owners can grant rights
piece by piece (add collateral, repay, set the rate, withdraw or borrow) to another key, by transaction or by
signature, and Safes and smart accounts can sign too. A transfer drops every grant.

**Borrower-set rates.** There is no single global interest rate. Each borrower picks their own, at or above the floor
for their collateral. Redemptions take from the lowest rates first, so a higher rate buys protection from redemption.
The rate becomes a market price, and protocol revenue rises exactly when the peg is under pressure. Every borrow pays
seven days of its type's average rate up front, and a rate change inside seven days of the last one pays seven days at
the old rate, so nobody can sit at a low rate and jump only when a redemption comes.

**A standing bid.** The Backstop holds imdUSD in two sleeves that depositors choose between: *blue* (ETH, wstETH, BTC,
staked stablecoins) and *edge* (sIMD at first).

- When a position is liquidated and its sleeve has room for the whole debt, the sleeve takes the collateral in the same
  transaction at the liquidation penalty, and the caller pays nothing. Otherwise the liquidator who calls it pays the
  debt and takes the collateral, as in v1. Of the penalty, half goes to the Treasury and a tenth to whoever marked the
  position; the sleeve's depositors keep the rest.
- A type can be set to liquidate only what restores its target ratio, not the whole position. At launch every type
  closes in full.
- New deposits count only after a full day and withdrawals are queued, so flash deposits cannot steer anything.
- The edge sleeve takes the first loss on edge types and earns 20% of their interest in exchange, and the room on those
  types is bounded by what stands behind them.
- The bid only pays while the price legs agree and the live pool is not far below the price. Otherwise the normal
  liquidation path applies, so depositors are not forced to overpay.

**A peg with a floor and a ceiling, both permissionless.** The pool hook shapes how the pool behaves between them.

- **Floor: redemptions.** Anyone can hand in imdUSD and receive $1 of collateral from the lowest-rate loans of the type
  they pick, minus a fee that goes to the Treasury. The fee starts at its 5% cap and falls to its floor (0.5% on volatile
  collateral, 0.1% on stablecoins) about 40 hours after launch, then rises with use, per type. Seats and peg positions
  are never redeemed against. The payout reads the live market alongside the attested price, so a
  lagging feed cannot strand redemptions the way it does in v1.
- **Toll: the hook.** Swaps inside $0.9975-$1.0025 pay only the pool's 0.01% fee. A swap that pushes the price further
  away pays a surcharge rising to 1.5% at 1% off the peg. Below $0.99 it steps up to 5%, rising to 20% at $0.98; above
  $1 it stays at 1.5%. Swaps toward $1 pay nothing extra.
- **Keeper: mint above, buy below.** Anyone can trigger it, gated by a 30-minute average so a single trade cannot set it
  off. Above $1.0025 it mints and sells imdUSD, up to a cap set by governance, and holds the USDC it receives. Below
  $0.9975 it buys back and burns with that USDC.
- **Below-peg buffer.** There is no separate reserve. Keeper profit and the toll's USDC fill a small buffer, and anyone
  may add to it, up to a target set by governance. It buys imdUSD below the peg once nothing is outstanding. The
  bought imdUSD goes to the Treasury.

**Peg positions: debt that is peg liquidity.** Deposit USDC and the position mints matching imdUSD, and both go into the
peg liquidity vault at the peg. Your collateral is the vault shares and your debt is the imdUSD. Every dollar of USDC
becomes two dollars of depth where the peg needs it, and you earn the pool's fees on it. The position is valued from
the vault's own holdings, new debt opens only while the vault is two-sided, it has its own line, and it is never
redeemed against.

**Depth measured on chain.** The line on IMD collateral must stay within what IMD's own market can absorb. In v2 nobody
posts that number. Samplers read the main IMD exit pools' depth from its own liquidity every hour, and the line follows a
robust seven-day low. A posted figure can only be a ceiling, and a swarm-attested depth reading can be added as a
second limit. An attacker can spend real money to lower the line for a while; they cannot raise it.

**Savings: sImdUSD.** Deposit imdUSD and earn a share of what borrowers pay, streamed to savers: 35% to start, changed
only through the timelock, and never above 50%. A savings rate is what lets other protocols list imdUSD, and a dollar
that is held is a dollar that is not sold into the pool.

**Positions that repay themselves.** Collateral that earns pays down the loan against it. A stablecoin in a savings
vault, or staked ether, has its yield credited against the debt automatically. The protocol keeps 10% of that yield as
its fee. A pledged seat's rewards are paid to you, less the same 10% fee: they do not repay the loan by themselves.

**Seat staking (identity.md NFTs).** An identity.md seat earns from the swarm, but owning one means running a worker
and holding an illiquid NFT. v2 makes a seat a working, liquid asset:

- **Borrow against your seat.** Built, and in the beta. Each pledged seat sits in its own account, so its rewards stay
  attributable to it. You keep running your worker, the seat keeps earning, and its rewards keep coming to you (less a 10% fee). Seats are
  priced from real sales, through a median-sale recipe we added to the plane and which is now live. They start at 40%
  loan-to-value, 25 seats in all and 3 per borrower, and are never redeemed against. The type opens only once its price
  legs are live.
- **Liquid seats (planned).** Holders who do not want to run a worker can deposit a seat with an operator who does,
  and hold a claim on its rewards: either a receipt for their own seat, or a share of a pool of seats. That claim can
  then be collateral too, so a seat earns, stays liquid and borrows at once. We are confirming two policy questions
  with the plane's developer first.

**Peg liquidity vault.** One shared position in the imdUSD/USDC pool, held between $0.99 and $1.01, compounding its
fees. Deposit both sides, withdraw any time. Live from the first day of the beta.

**A bounded Allocator.** One contract through which a keeper key moves protocol funds between approved places, each
action within a refilling limit and a slippage bound. It cannot choose a recipient, raise a limit, touch user funds,
mint imdUSD or change a parameter, and a separate key can freeze it at once.

**After the beta.**

- **Rate managers.** Hand your rate to a manager within bounds you set, and leave whenever you like. Built, optional and
  outside the core.
- **Loop vault.** Deposit IMD and hold a target leverage on sIMD without managing it by hand. Built, with its keeper
  wiring still to do.

**Robinhood Chain.** Robinhood Chain gets its own full core. It is built, and it launches on its own after the beta:

- **Collateral:** ETH, USDG (the chain's dollar, staked on deposit into an approved savings vault so its yield repays
  the loan, like the earning stablecoins above) and IMD, priced from the same swarm attestations as on Ethereum.
- **Its own peg pool.** imdUSD/USDG with the same hook.
- **Built for an L2.** If the chain's sequencer goes quiet, liquidations wait out a one-hour grace once it is back,
  so nobody is liquidated over an outage they could not act in. Repaying and depositing are never held.
- **Its own debt cap.** All borrowing on the chain together stays under one line, set through the timelock.
- **One dollar across chains.** imdUSD moves between Ethereum and Robinhood Chain over LayerZero, burned on one side
  and minted on the other, through our own bridge contract. It has no owner: routes, rate limits and security
  settings change only through the 48-hour timelock, and a guardian can pause a route instantly but not reopen it.
- **Tokenised stocks and treasuries.** Built, for after that launch. The legal review is done: the contracts stay
  permissionless and our site follows each issuer's own restrictions on who may hold its tokens. Only tokens with a
  Chainlink price and real on-chain depth qualify, starting with a short list of the deepest (index funds, T-bill funds
  and a few large stocks). Each one's collateral ratio is set from its measured weekend and holiday gaps (back to 2000
  where the history exists), a liquidation while the market is closed waits for the open, and a token its issuer pauses
  freezes its type instead of being mispriced.

## How it has been checked

v2 has not had an outside audit. Here is what has been done so far, and what we have chosen to accept.

- **An internal adversarial review.** Twelve areas, each with its own reviewers and an independent verifier for every
  finding, run the way a swarm agent panel would run it. Findings were fixed and re-checked over several rounds, or
  recorded as accepted.
- **A second review in November.** Every multi-step flow was checked for states it can get stuck in or should never
  reach, and every send for what happens between sending and confirming. Its fixes are in the code.
- **About 1,300 tests,** including mainnet fork suites and invariant suites.
- **Launch rehearsals.** The staged deployment is rehearsed end to end on mainnet forks, including a run interrupted
  partway and resumed.
- **A gas audit.** A typical redemption fell from about 1.36M gas to about 0.94M.
- **Ethereum's next gas repricing.** We checked v2's contracts against the storage and code price changes proposed for
  the Glamsterdam fork and made room where a transfer would have run short. Those prices are not final yet.

**What we have accepted.** sIMD is priced by two swarm-attested legs, and for the beta nothing on chain checks that pair
against the market. A wrong pair, or a stolen attester key, could move sIMD by up to 40% after a silence and 20% per
epoch. Measured at a 24,333 imdUSD line, a pair 40% too low would cost borrowers about $18,000 in unfair liquidations; a
pair 40% too high pays an attacker nothing. We built an on-chain market check and took it out: it cost a keeper hundreds
of samples a day and could itself be griefed, and at the beta's small sIMD line it was not worth it. It stays on a branch,
ready if an audit disagrees. We will measure this risk again before any raise of the sIMD line, and the line stays closed
until the new feeds are seeded and checked.

## What we are exploring

Further upgrades we are working on. None is committed to a date, and each will be announced here if it ships.

- **Private balances.** You should be able to hide what you hold while your money keeps working. We will not build a
  shielded pool. imdUSD, sImdUSD and peg vault shares are made to fit the ones that exist: no transfer hooks, holds or
  freezes, so a share in a pool keeps earning. We expect to start with Railgun on Ethereum and to ask Privacy Pools by
  0xbow to list them later. It needs a legal read before anything ships. Signed borrowing, where a fresh key owns the
  position, would extend this after the beta.
- **A pool of earning tokens.** A swap pool that holds only staked tokens (sIMD and sINFER first), staking what comes in
  and unstaking what goes out inside the same swap. Liquidity keeps earning staking yield between trades instead of
  sitting idle. Built and left out of the beta; it is not yet audited.
- **Solana.** imdUSD moving to Solana over the same bridge, as a dollar you can hold and send there, before any
  borrowing on Solana itself.

Now shipped from this list: **grouped price attestations.** Our `oracle.group` contribution to the IdentityMD plane is
merged and live: several questions in one order, every window resolved against the same block, each answer still an
ordinary attestation.

## One terminal

imdusd.com is already a single desk: borrow, swap any token, loop, provide peg liquidity and track points from one
screen. v2 brings a new layout for that desk, designed around the added features rather than squeezed into the
current one.

## How v2 launches

1. **Audit.** The swarm's audit pipeline on a public snapshot of the code, on top of our own review, before any real money.
2. **Live beta, before Season 1 ends.** v2 opens on mainnet with small debt ceilings. The loop vault, the earning-token pool, the bridge and Robinhood Chain are left out. Ceilings rise through the
   48-hour timelock as it proves itself. The
   sIMD line opens separately, once its feeds are seeded and checked, on no fixed date.
3. **Migration opens when Season 1 ends.** Moving v1 imdUSD into v2 stays closed until then, so nobody gives up their
   Season 1 standing by trying v2 early. Season 1 continues on v1 exactly under its published rules.
4. **v2 becomes the home for what comes after.** Future seasons and new products build on v2.

During the beta the new token is called **imdUSD** and the original becomes **imdUSD v1** across our sites, so the
two are never confused.

## Roadmap

| Area | Status |
|---|---|
| Multi-collateral core, borrower-set rates, liquidations | Built, internally reviewed; in the beta |
| Position NFTs and operator rights | Built, internally reviewed; in the beta |
| Standing bid (Backstop sleeves) | Built, internally reviewed; in the beta |
| Redemption redesign (live price leg, per-type fees, rolling limits) | Built, internally reviewed; in the beta |
| Peg hook: toll, keeper and buffer | Built, internally reviewed; in the beta |
| Peg liquidity vault and peg positions | Built, internally reviewed; in the beta |
| Measured IMD depth | Built, internally reviewed; in the beta |
| sImdUSD savings | Built, internally reviewed; in the beta |
| Seat staking | Built, internally reviewed; in the beta, opens when its price legs are live |
| Allocator | Built, internally reviewed; in the beta |
| Deployment tooling and mainnet rehearsals | Built |
| Keeper for the beta | Built and tested on a local fork; not yet run against the live oracle network |
| Outside audit | Next |
| Live beta | Before Season 1 ends |
| v1 migration path | Built, opens after Season 1 |
| Rate managers | Built, after the beta |
| Loop vault | Built, after the beta |
| Robinhood Chain core and bridge | Built, its own launch after the beta |
| Tokenised stocks and treasuries | Built, after the Robinhood Chain launch |
| Liquid seats | Designed; waiting on two policy answers from the plane |
| Private balances | Designed; needs a legal read |

## Ideas we have parked

These are worked out but frozen for now. Each has a reason and a trigger for picking it back up.

- **Isolated lending markets for launch tokens, paying peg liquidity.** Every token launched on imd.fun would get
  its own lending market, with part of the interest paid to imdUSD liquidity providers at the peg. Designed with the
  swarm's help, then parked: today's launch pools hold too little liquidity for safe markets. We will revisit when
  launch pools hold real depth.
- **Fee notes.** Fixed-term notes that let the protocol buy its own peg liquidity with a small, fixed cost of capital,
  repaid from revenue. The contract is built and deploys dormant; no series opens until v2 revenue exists to back one.
- **Oracle subscriptions.** We already run some of the plane's most-used paid price feeds; selling them as a
  shared service is a later product.
- **imdUSD as a launch pair on imd.fun.** That integration belongs to the plane's developer, who has said they are
  working on it. v2 does not depend on it.

And two things we have decided not to build: a custom stableswap curve (a concentrated position around $1 already
does the job, and we looked again at the stable-pair hooks now on Uniswap v4: the shortage is USDC bidding under the peg,
which a curve does not supply) and vote-escrow gauges (they need token emissions, and there are none).

## What does not change

- **v1 keeps running.** Your v1 position, your v1 imdUSD and the v1 terminal keep working.
- **Season 1 rules are fixed.** They were committed on chain when the season opened and cannot be changed by anyone.
- **Nothing here is a promise of price or yield.** imdUSD is a dollar, not an investment. Everything in this document
  is a plan and may change; the changelog below records when it does.

## Changelog

- **2026-11-09** Published the rebuilt core described under 2026-11-06, with the 2026-11-07 corrections. Added the
  November review to *How it has been checked*.

- **2026-11-07** Corrections (also made to the version then published): a pledged seat's rewards are paid to its
  holder and do not repay the loan; the governance Safe can mint in one way, by naming the bridge minter once through
  the timelock; lowering a limit is instant. Also: the standing bid takes a whole liquidation or none of it, the
  penalty split, full closes at launch, and the redemption fee floor per type.
- **2026-11-06** The core was redesigned and rebuilt, so most of this document changed. Added position NFTs, the standing
  bid, peg positions, measured depth, the Allocator, *How it has been checked* and private balances. Corrected the peg:
  no separate below-peg reserve, a toll instead, and redemption fees go to the Treasury, not to the borrowers redeemed.
  Seats moved from designed to built and in the beta. Loop vault, Robinhood Chain and stocks moved to built, after the
  beta. Stated the sIMD risk we accepted. Grouped price attestations shipped.
- **2026-10-22** Robinhood Chain section updated to the built core, stocks after legal review; added *What we are
  exploring* (grouped price attestations, a pool of earning tokens, Solana); the terminal gets a new layout; v2's
  components no longer have a heading each.
- **2026-10-21** First version.
