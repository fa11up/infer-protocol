---
title: Oracle and question binding
section: reference
order: 4
audience: integrators
sources:
  - src/SwarmFeed.sol:26-496
  - src/DeploymentConfig.sol:45-78
  - src/PriceFeed.sol:17-48
  - src/NhiFeed.sol:17-46
  - src/SpotFeed.sol:24-53
  - src/SwarmWorkOracle.sol:50-232
  - src/SwarmRelay.sol:37-134
  - src/UsdPriceFeed.sol:23-96
  - src/OracleAsker.sol:1
  - src/Treasury.sol:493-608
  - src/CDPVault.sol:865-885
  - src/ParameterizedVault.sol:152-164
  - oracle/question-prefix.mjs:45-104
---

# Oracle and question binding

The vault's prices come from IdentityMD panels: a panel of agents answers a fixed question, the IdentityMD oracle service signs the answer, and anyone can submit the signed answer (an attestation) to a feed. `SwarmFeed` is the contract that checks attestations. Four contracts are built on it:

- `PriceFeed`: the median of 13 evenly spaced IMD/ETH readings across a block window.
- `SpotFeed`: the IMD/ETH reading at the last block of a window, from the same pool.
- `NhiFeed`: the [network health index](../governance/network-health.md).
- `SwarmWorkOracle`: a Merkle root of the swarm's work tally, not a price.

Each one accepts answers to its own question and no other.

## What an attestation contains

| Field | Meaning |
|---|---|
| `requestId` | The oracle request it answers. Each can be used once. |
| `chainId` | The chain the question reads data from (Ethereum mainnet, `1`), which is not necessarily the chain the feed lives on. |
| `questionHash` | Hash of the question the panel answered. |
| `answerType`, `answer` | The answer's type (`3`, a `uint256`, for every feed here) and its encoded bytes. |
| `figure` | The number the feed stores, scaled by 1e18. For the work oracle, a Merkle root. |
| `fromBlock`, `toBlock`, `blockHash` | The block window the answer covers. |
| `panelJobId` | The panel job that produced it. |
| `panelSize`, `quorum`, `agreed` | How many agents sat on the panel, the requested quorum, and how many agreed. |
| `issuedAt`, `expiresAt` | When the service signed it and when the signature stops being valid. |

The signature is checked under an EIP-712 domain named `IdentityMD Oracle`, version `2`, with the chain the feed is deployed on and the feed's own address as `verifyingContract`. So a signature made for one feed cannot be used on another. The exact signed type is:

```text
OracleAttestation(bytes32 requestId,uint256 chainId,bytes32 questionHash,uint8 answerType,bytes answer,uint256 figure,uint64 fromBlock,uint64 toBlock,bytes32 blockHash,bytes32 panelJobId,uint16 panelSize,uint16 quorum,uint16 agreed,uint64 issuedAt,uint64 expiresAt)
```

The signature must be 65 bytes in standard form and recover to the feed's `attester`. It is one signature from the service, not a signature from each panel member.

Panel floors are written into the contract: `panelSize` must be at least 25 (`MIN_PANEL_SIZE`), and `agreed` at least 15 (`MIN_AGREED`) and no more than `panelSize`. `quorum` is signed but not checked, so no percentage of the panel is enforced, only these two counts.

## Question binding

`expectedQuestionHash(uint64 fromBlock, uint64 toBlock)` returns the hash of the feed's question for that window. The question text, its definitions, the answer type, the data chain and the evidence mode are all part of what is hashed. Request settings such as guards, the requested panel size and the consumer are not.

You can call it before you pay for a request: if the hash of the question you are about to buy does not match, the feed will refuse the answer.

`submitAttestation` runs these checks, and stores nothing unless all pass:

1. The caller is the feed's `relayer`, the data chain and answer type match, and the panel counts clear the floors.
2. `issuedAt` is not in the future, the attestation has not expired, it is no older than the feed's maximum age or the value already stored, and its `requestId` has not been used.
3. The signature recovers to `attester`.
4. The window runs forward, its length fits the feed's limits below, it ends after the last accepted window, and `questionHash` equals `expectedQuestionHash(fromBlock, toBlock)`. When the data chain is the chain the feed is on (every mainnet feed), the window must also have closed at or before the current block and no more than one feed lifetime ago, counted in 12-second blocks (`WindowInFuture`, `WindowTooOld`).
5. The figure passes the feed's value check (next section). The feed then stores the figure, signing time, request and window end, and emits `ValueUpdated` and `AttestationAccepted`.

| Feed | Allowed window, `toBlock - fromBlock` | What the window means |
|---|---|---|
| `PriceFeed` | 300 to 1,200 blocks | The span the median is taken over. |
| `SpotFeed` | 150 to 1,200 blocks | Only its last block is priced. |
| `NhiFeed` | 150 to 1,200 blocks | Keeps answers in order; the question reads live service counters when answered. |
| `SwarmWorkOracle` | 5,000 to 9,000 blocks | Picks the daily work receipt as of the window's end. |

The feed does not check `blockHash`. On mainnet the recency bound above stops a fresh signature being put on a window from hours earlier, chosen for its price; a feed whose data lives on another chain cannot see that chain's head, and there only the forward-moving window and `issuedAt`, the service's statement of when it signed, stand in for it.

The relay-side procedure, including the errors each check raises, is in [Relay oracle updates](../keepers/relay-oracle-updates.md). What has and has not been shown against the live service is tracked in [Swarm evidence](../economics/swarm-evidence.md).

## Freshness and the two price checks

A feed is stale before its first value, and once more time than its maximum age (one hour for the price and spot feeds, one day for network health and the work oracle) has passed since the stored value was signed. `latestValue()` returns the stored value even when it is stale, so always read `isStale()` too.

**How far one update can move a feed.** A figure of zero is always refused. Every figure after the first is measured against an *epoch*: an anchor value and an allowance that hold for one feed lifetime from when the epoch opened, so several updates inside a lifetime cannot walk the price further than one could. An epoch opened on a fresh value allows `maxDeviationBps` (2,000 basis points, 20%, on the price, spot and health feeds) from its anchor. One opened after the feed has been silent for a whole hour past its lifetime allows twice that (`STALE_DEVIATION_MULTIPLE`), plus an eighth of `maxDeviationBps` for every further whole hour of silence (`STALE_GROWTH_OF_CAP_BPS`, `STALE_GROWTH_PERIOD`), up to `MAX_ALLOWANCE_BPS`. For a one-hour price feed that is 20% through the first hour stale, 40% after two silent hours, 45% after four, 50% after six, 60% after ten and 100% after twenty-six; the one-day health feed reaches the same steps a day later. Silence is counted from the later of the stored value's signature and its relay. Inside a widened epoch, once its first value has landed, every later value in that epoch is held to `maxDeviationBps` around that first value, so the first honest refresh after a silence closes the wide allowance for everyone after it. **The way back.** A value relayed at the end of an epoch opens the next one around itself, so a single pushed value late in an hour could otherwise lock the honest price out for two hours. Once an epoch has ended, a value the normal rule would refuse is still accepted if it lies within `maxDeviationBps` of the level the ended epoch held its values to, and the new epoch opens there. It reaches no level that epoch did not already allow, and closes about two lifetimes after the epoch opened, when the widening from silence takes over. `epoch()` returns the anchor, when the epoch opened and the allowance; `accepts(value)` answers whether the feed would take a value now by the full rule, way back included. Ask `accepts` before paying for an update. A genuine move larger than the allowance is therefore followed after a delay, never refused for good, while re-anchoring the feed far from the market costs an attacker that same silence, during which anyone can refresh it honestly. The first value ever has no bound on chain; the deployment buys and relays it and checks it against the pool before the vault is deployed. `SwarmWorkOracle` skips the limit and keeps no epoch, since roots have no distance, but still refuses zero.

**Primary against spot.** `skew` (500 basis points, 5%, at launch) is a separate check in the vault: the primary and spot IMD/ETH prices may differ by at most that fraction of the primary. Both are raw IMD/ETH, so ETH/USD plays no part. Both read the same pool, so agreement guards against a bad answer, not against the pool itself being moved.

## Relayer and dollar price

Each feed accepts attestations only from its relayer, `SwarmRelay`, which anyone may call. `relay`, `relayMany`, `relayAndBark` and `relayAndBite` change nothing about the feed's checks. Bundles succeed or fail as a whole, but they do not give whoever paid for the update priority over other keepers.

`UsdPriceFeed.latestValue()` multiplies the primary IMD/ETH price by Chainlink's ETH/USD answer, adjusting for its decimals, and returns USD per IMD (scaled by 1e18) with the older of the two timestamps. A missing, malformed, zero or negative ETH/USD answer gives no usable price. `isStale()` is true if the primary is stale or ETH/USD is stale or dated in the future, and `maxAge()` reports the shorter allowance.

`latestValue()` does not itself reject a well-formed but stale ETH/USD answer, so use it with `isStale()`. `ethUsdPrice()` does check ETH/USD's age. The vault checks staleness before it uses any dollar price.

## How updates are paid for

The protocol pays for its own price updates from its Treasury, and no key decides when.

**`OracleAsker`** buys an attestation for a feed through IdentityMD's on-chain request contract (the Intake), paying the Intake's listed price in IMD. Anyone may call `ask(feed, body)`, but it pays only when the chain shows the update is needed:

- **The network health feed is close to stale**: three quarters of the way to its maximum age (18 hours for the one-day health feed), or with no value yet. Only feeds marked to be kept alive are refreshed this way. The price feeds are not, because keeping them fresh on a clock would cost far more than it protects.
- **Any feed has been silent a whole lifetime and its allowance has widened** to 6,000 basis points (60%) or more (`wideOpen(feed)`): ten silent hours for a price feed, 33 for the health feed, price and spot included. No arming is needed: the honest value lands first, and the epoch it opens holds every later value to the normal bound around it.
- **IMD's pool has fallen below the feed** by more than a quarter of the feed's deviation bound (5% at a 20% bound). Only a fall is paid for: a feed above the market values collateral too high, which lets positions borrow too much and be liquidated late, so it is corrected early. A rise only values collateral too low, which limits borrowing and puts no one at risk, so the Treasury never pays for one; whoever wants the extra borrowing room buys the update with `askPaid` below. `triggerBps(feed)` returns both thresholds, with zero meaning never. The fall must first be recorded with `arm(feed)` and still be there five blocks later (and no more than 100 blocks after arming). A pool pushed off price and back within one transaction, as with a flash loan, cannot trigger a paid update.

`body` must be the exact request the feed's question was built from; the asker stores only its hash. Each body asks for a relative window ("the last N hours"), which the oracle service resolves afresh for every request; a fixed block range could be answered only once. Spending is limited five ways: one request in flight per feed until it is answered, fails or times out (two hours), at least ten minutes between paid requests for the same feed, a two-hour wait after one of the Treasury's own purchases was refused by the feed or ended without an answer, a maximum price of 1 IMD per request, and the daily budget below.

The Intake delivers the answer by calling the asker back, and the asker hands it to `SwarmRelay`, so the feed checks it exactly as it would one relayed by hand. The callback never fails because a relay was refused: it frees the feed for the next request and reports whether the answer landed (`Delivered`). If it did not, the attestation is still public and anyone may relay it, and, if the Treasury paid for that request, the Treasury does not pay for that feed again until the two-hour request timeout has passed.

A request can also end without an answer: the oracle service refuses it, or the panel does not agree. The Intake then calls the asker's failure callback, `onOracleFailure`, at once. It frees the feed straight away, so anyone may buy a fresh update in the next transaction instead of waiting out the timeout, and emits `AskFailed(feed, requestId, status, reason, agreed, answered)`, where `status` is 1 for a refused request and 2 for one that ended without a result. A failed request is not refunded, so if it was the Treasury's own purchase the Treasury waits the two-hour timeout before paying for that feed again; a purchase someone else paid for holds the Treasury back no more than its answer would have.

**`Treasury.fundOracle()`** is how the asker gets its IMD. Anyone may call it. It tops the asker up to one day's budget, `oracleBudget` (15 IMD at launch, at most 100) in [Parameters](../governance/parameters.md), and never past it: it sends at most what is left of the day's budget and at most what brings the asker's balance to one day's worth, because the asker has no way to give IMD back. It spends the Treasury's plain IMD first (launch-pool fees, donations; not if IMD is listed as a reserve asset), then unstakes sIMD so the asker receives IMD. sIMD refuses a withdrawal in a block in which the Treasury received shares, as right after a liquidation: the call then sends only the plain IMD, or nothing, without reverting, and the shares unstake a block later. The call needs enough gas for the unstaking step (`InsufficientGasForUnwrap`). The budget changes only through a delayed governance proposal and has a hard upper limit. Days are UTC days.

**`askPaid(feed, body, maxPrice)`** is how anyone else gets a fresh price. The caller pays the Intake's price in their own IMD, up to `maxPrice`, and an update is bought for any feed at any time, because no protocol money is spent. While a price feed is stale, borrowing, withdrawing against debt, marking, liquidating and redeeming wait until someone buys an update this way, the pool falls far enough for the Treasury to buy one, or the feed has been silent long enough for the Treasury's wide-open refresh.

**`askPaidMany(feeds, bodies, maxPriceEach)`** buys several updates in one transaction, each at the same price ceiling. The terminal's Update price uses it when the spot needs refreshing too: the vault acts only while the two agree within `skew`, so the spot is added when it is stale, more than half of `skew` from the market the new primary will reflect, or due to expire long before the new primary. Otherwise the primary is bought alone (`askPaid`) and the spot is not paid for. A feed whose update is already on its way is skipped and not charged, and the call fails only if it bought nothing. Each answer still arrives on its own, usually minutes apart, so actions can stay paused until both have landed.

Relayers are not reimbursed. None of this is required: when the budget is spent or the Intake is unavailable, anyone can still buy an attestation from the oracle service and relay it.
