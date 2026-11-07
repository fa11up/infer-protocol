# imdUSD Protocol

A compute-backed CDP stablecoin whose prices and risk parameters come from IdentityMD swarm oracle
attestations. sIMD (staked IMD, `StakedIMD` `0x9Efa934D9fAd4AE28c998a40195646b965a97247`) is the collateral,
the vault mints imdUSD against it, and the swarm's answers decide what a position is worth and how harshly it
is liquidated. Built and proven on Sepolia; the mainnet deploy commit is frozen on `release/mainnet` at
`9e37405` (tag `mainnet-freeze-2026-10-10c`), which differs from `main` only in `src/DeploymentConfig.sol`.
Public docs: https://imdusd.com/docs/.

Forked from `identity-md-launches/launch-519-mockimd-pricefeed-nhifeed-cdpvault`, so the history below
the fork point is the swarm's own build across launches 458 → 493 → 517 → 519 → 586. Everything above
it is ours.

At the freeze: **654 tests pass** on a plain `forge test` (4 skipped), 655 with `AUDIT_PROOFS=true`, 116 in
`script/checks`, and the mainnet fork tests (including `test/fork/IntakeV2.t.sol` against the live Intake).

## Contracts

| | |
|---|---|
| `CDPVault` | positions, minting, the stability fee index, liquidation, bad debt |
| `ParameterizedVault` | `CDPVault` plus five overrides that read its economics from `Parameters` |
| `SwarmFeed` | attestation verification; `PriceFeed` / `NhiFeed` / `SpotFeed` are its three leaves |
| `SwarmRelay` | permissionless relay, and keeper bundling: relay-and-mark, relay-and-bite |
| `Parameters` / `Governed` | the governed economics and the reserve register, behind a 48-hour delay |
| `Treasury` | where the protocol's own revenue lands; pays redemptions from its sIMD first, funds the oracle budget |
| `TreasuryFactory` | creates the vault's Treasury, so the vault's initcode stays under EIP-3860 |
| `OracleAsker` | buys feed updates through the IdentityMD Intake (v2) with the Treasury's IMD, only when the chain shows a need; anyone may also buy one with their own IMD |
| `Registry` | replaceable counterparties — **written, not yet wired to anything** |
| `UsdPriceFeed` | the IMD/ETH feed × Chainlink ETH/USD, so one imdUSD of debt is one **dollar** of collateral |
| `SharePriceFeed` | prices any ERC-4626 share from a feed for its asset, in USD per 1e18 raw units — built for sIMD |
| `SwarmWorkOracle` | minting rights earned from an attested work tally; extends `SwarmFeed`, so it inherits question binding |
| `WorkOracleFactory` | deploys the above, because its creation code will not fit in the vault's |
| `ImdUSD` | the stablecoin; minted and burned only by its vault |
| `MockIMD` / `MockWorkOracle` / `LaunchToken` | testnet collateral faucet, the work-credit faucet `SwarmWorkOracle` replaces, launch token |

Three feed leaves exist rather than two `PriceFeed` instances because a launch manifest identifies a
deployment by contract name and has no alias field, so it cannot name one artifact twice.

The manifest is the **`evm_contracts`** kind: application contracts only, with **no token, no liquidity
pool and no reward distributor**, and `$token` does not resolve in it. Earlier rounds had to launch a
throwaway ERC-20 alongside the protocol because `evm_project` requires one; that is no longer true. The
cap is **eight**, not the four an earlier revision of this file claimed.

**Two different caps, which is worth knowing before designing around either.** A launch *manifest*
takes up to eight contracts; the *request*'s `draft.contracts` still takes four, and a request is what
approves a manifest. So the manifest names four: the three feeds, then `ParameterizedVault`.

The vault's collateral argument is an explicit **faucet sentinel**, not an address, which tells the
constructor to deploy a fresh `MockIMD` itself. That is the fix for the failure that parked round 4,
and the failure was never instruction-fixable: a launch constructs the project on a **bare chain**
before it deploys anywhere, so a literal Sepolia address has no code there and the constructor refuses
it. No wording given to the swarm can put code at an address on a chain it was never deployed to — only
a value the constructor can resolve locally can. Zero is deliberately *not* that value: zero is what an
unset manifest field looks like, and a vault quietly accepting a mock token as collateral would take a
worthless asset against real debt. `ImdUSD`, `Parameters`, `Treasury` and `UsdPriceFeed` are still
created inside the vault's constructor, now because that is what makes the deployment come up fully
linked with no transaction sent afterwards — a manifest makes none — rather than because slots are
scarce.

`SwarmWorkOracle` cannot be, and the reason is a measurement rather than a preference: its creation
code is 16,478 bytes and `ParameterizedVault` has 12,222 bytes of EIP-3860 headroom, so a vault that
created its own would be 52,880 bytes of initcode and undeployable. `WorkOracleFactory` holds that
creation code instead; a vault asks for one by passing `WORK_ORACLE_SENTINEL`, and an **absent factory
reverts** rather than silently leaving the vault on the faucet.

## The three numbers

| input | what it decides |
|---|---|
| **price** | `collateralRatio = collateral * price * 100 / (debt * 1e18)`, from a window median. On `ParameterizedVault` the price is `collateralPriceFeed()`, a `SharePriceFeed` over `UsdPriceFeed` (sIMD's exchange rate × IMD/ETH × ETH/USD), so **one imdUSD of debt is one USD-worth of collateral**; the base vault prices in ETH |
| **NHI** | `mat()` 170 at ≥0.85 rising to 200 at ≤0.60; `lull()` 6h falling to 0 |
| **spot** | not a price — a sanity bound. A gap over `SKEW_BPS` (500) halts borrowing, redemption, marking and liquidation, and any withdrawal while debt is open; deposits, repayments and withdrawals from a debt-free position stay open |

Shipped economics: liquidation bonus 20%, stability fee 444 bps, marker share 1000 bps of the bonus,
protocol share 1000 bps of it, divergence bound 500 bps, debt ceiling 1,000,000 imdUSD, redemption fee
50–500 bps with divisor 2, redemption spread `gap` 50, work ratio 2500 bps, wage 0 (minting from work off at
launch), oracle budget 15 IMD a day. Feeds: price and spot live one hour, NHI one day, each moving at most
2000 bps per epoch. The full table is in `web/content/docs/governance/parameters.md`.

The divergence guard deliberately reads the **raw** primary feed rather than the denominated price:
both legs quote IMD in ETH, so the ETH/USD factor cancels, and comparing a denominated price against
spot would sit them an ETH price apart and refuse every action.

## Question binding

A feed verifies **which question** an attestation answers, not merely that the service signed it.
This matters more than it sounds: `consumer.verifyingContract` is a field the *requester* chooses, so
without this check anyone can buy an attestation over a figure of their choosing, name someone else's
feed as the consumer, and present it as an answer to that feed's question. Every other guard —
signature, replay, freshness, panel floors — passes by construction. An independent audit found
exactly that, rated high, with a failing proof test.

`questionHash` is keccak of the control plane's canonical question document, which includes the
resolved block window, so there is no stable value to pin. But the canonicalisation is an RFC 8785
subset: keys are **sorted**, `window` sorts last, and the only part that varies between two otherwise
identical requests is a **suffix** whose two numbers the attestation carries as *signed* fields. So a
feed pins the document's prefix and splices them back in:

```solidity
bytes32 expected = keccak256(abi.encodePacked(
    QUESTION_PREFIX, _decimal(a.fromBlock), ',"toBlock":', _decimal(a.toBlock), "}}"
));
```

Two further bounds, because answering the right question is not yet answering it honestly: the window
span is bounded (a one-block window is a point read dressed as a window median; a month smooths away a
real move), and `toBlock` must **advance**, so a freshly signed attestation cannot answer over an
ancient window where the price was whatever the buyer needed. Replay protection misses that — the
`requestId` differs.

With the question bound, a feed needs no trusted relayer at all, so `SwarmRelay` being permissionless
costs nothing. A feed that pins *no* question cannot be deployed with a zero relayer; the constructor
refuses the pairing that has no defence.

The prefix is **generated, never hand-written**:

```bash
node oracle/question-prefix.mjs <payload.json>                      # emits the Solidity constant
node oracle/question-prefix.mjs <payload.json> --verify <requestId> # must print MATCH
```

`--verify` rebuilds the hash and compares it against a live attestation; the script refuses to emit a
prefix that fails. One consequence worth knowing: `definitions` is part of the hashed document, so a
figure that *moves* in there — a price band, a magnitude — changes the question and the feed stops
accepting. Moving numbers belong in `guards`, `panelSize`, `quorum` or `consumer`, none of which are
hashed.

## Governance

`Parameters` holds the governed economics — debt ceiling, protocol bonus share, stability fee, divergence
bound, marker share, the work ceiling's ratio term, the imdUSD an accepted task earns, the redemption spread
and fee divisor, the operator stream, the daily oracle budget and the work-oracle slot — plus the
Treasury's reserve register, all behind a 48-hour delay. The governor is a 2-of-3 Safe pinned in source
(`APPROVED_OPERATOR`). One proposal at a time, readable by anyone for the whole
window, then applied by **anyone**: a governor who could also withhold application could hold a
validated change over the protocol and choose its moment. Cancelling is the only instant action,
because abandoning a change can only return things to what borrowers already priced.

The bounds are constants in the contract, not governance choices, so the governor cannot widen its own
authority. What is deliberately **not** governable: the attester, the three price feeds, and the
collateral token. A wrong parameter is a bad business decision a borrower can see coming and exit
ahead of; a wrong feed is not a cost, it is custody — whoever names the price feed can bite
everyone in one block. Those stay immutable, and so does a vault's reference to its own `Parameters`.

A rate change checkpoints the fee index first. Without that, the index recomputed from deployment at
the current rate, so raising the rate repriced history and *cutting* it made the index fall below a
borrower's stored index — reverting `stabilityFeeOf`, which is on every entry point. A rate cut would
have frozen every position.

## Live on Sepolia (historical)

| | |
|---|---|
| CDPVault | `0xD8CbC70B9C2dfC75762686dd4795e2aC033452c5` |
| PriceFeed | `0xC677A113e06d70a313FfB459B291ec4bEcF5AB18` |
| NhiFeed | `0x125100448612347ba2604E9dA26f40013C602b3A` |
| SpotFeed | `0x0535C1A564B2594676239428A113d542cd6c2Ed9` |
| SwarmRelay | `0xe36FFc2688Bf5974f2187AC9086492e372926D40` *(deployed, not wired to these feeds)* |
| ImdUSD | `0xd5B99590CC79592a6C2C46991a9F873dF72b4c0B` *(created in the vault's constructor)* |
| MockWorkOracle | `0x7df0f2Ea286738f905ab5b1B8899E9e207996198` *(same)* |
| MockIMD | `0xe44ab81ce23d34e29383dd158a1dffeb1c10d439` |

**These predate question binding, the governed parameters, the USD denomination and the attested work
oracle.** Their bytecode is 5,082 bytes against
the 8,243 the current source compiles to, and `expectedQuestionHash` reverts on them because the
function does not exist. They also pin the reporter key as their relayer rather than the `SwarmRelay`
above — that contract is deployed but no live feed accepts it, and it predates keeper bundling too.
This is the stack that proved the attested path; picking up anything above it is a redeploy.

The attested path is proven end to end: oracle request `50d9b023-30cf-402d-8568-867cbced57b7`, figure
`3172735462421828`, panel 60 with 20 agreed, relayed in
`0x15854076dbc9c33c73b36eaad1871350fd6e2d19a7510d863ecc4d41f47b6b9e` at block 11830282 for 79,328 gas.
Verified by reading chain state: the feed's value is the attested figure, replay protection engaged,
and divergence against the spot feed was 119 bps against a 500 bps bound.

## Oracle tooling

IMD's only liquid market is Uniswap v4 on mainnet, both pools paired with native ETH. The v3 WETH pool
is drained — `liquidity()` is 0 — so anything priced from it is a frozen leftover.

```bash
cd oracle && npm install
node preflight-oracle.mjs <payload.json> <feedAddress> --rpc <url>   # before paying
node relay-attestation.js <oracleRequestId> --network sepolia|mainnet # after it attests (mainnet also needs FEED=0x...)
```

**Run the preflight before every paid request.** It reads the destination feed's own constraints from
chain and refuses a payload the feed could never accept — including, now, a question document the feed
does not pin and a moving number inside `definitions`. It exists because a request once attested
perfectly and still could not be relayed: `consumer` was missing, so the signature was under the
service's default domain, and the panel was under the feed's floor. Both were knowable in advance.

Other things learned the expensive way:

- **Walk the feed to the live market first, then pin guards, then pay** — in that order, in one
  sitting. A request bought with guards around a stale level was refused by the panel when IMD moved
  44% in a day. `--fix-guards` rewrites them to the feed's live band.
- `consumer.verifyingContract` must be **lowercase**, or `/requests/quote` returns a bare 400.
- `maxDeviationBps` and the update cadence are **one knob, not two**. A tight cap only works if
  updates are frequent enough that the market never moves further than the cap between them.

## Testing

```bash
forge test                                                              # 362, InHouse self-skips
forge test --match-path test/InHouse.t.sol --fork-url $SEPOLIA_RPC_URL   # 14, live state
forge test --match-path test/SharePriceFeedFork.t.sol --fork-url $MAINNET_RPC_URL  # 12, live sIMD
AUDIT_PROOFS=true forge test --match-path 'test/audit/*'                 # auditor proofs
```

`test/InHouse.t.sol` covers what the inherited suite does not: the constructor arguments and the
deployment's own authorities. That is the layer that actually failed in production — an earlier launch
deployed with a manifest placeholder that resolved to the platform's address rather than ours, and an
answer-type constant that was simply wrong, both immutable. It skips itself off-fork because it reads
live state. Most public Sepolia RPCs are not archive nodes.

## Audits

Thirty reviews through 2026-10-10: single audits, panel audits, adversarial reviews, a gas review and four
in-house reviews. The full chain, with every job, pinned commit and record, is in
`web/content/docs/reference/audit-history.md`. The first two are summarised here.

**The first two independent reviews, both bought from the swarm, both read-only.**

`docs/AUDIT-2026-10-03.md` reviewed the contracts written outside the swarm and returned
**11 findings: 1 high, 2 medium, 4 low, 4 info**, each with a Foundry proof test. All four supplied proofs were re-run and all four failed exactly as described.

Every finding is addressed. The high is the question binding above. Both mediums shared one root
cause — binding a `Parameters` to a vault was a separate transaction — and there is no fix that keeps
one, because a mid-construction callback cannot verify its caller: the vault has no code yet. So the
transaction is gone. The two proofs whose API no longer exists live in `audit/proofs/`, outside the
compiled tree, kept verbatim; the Treasury proof now **passes** and is a regression test.

`docs/AUDIT-2026-10-04.md` reviewed the USD denomination and the work-backing surface and returned
**5 findings: 3 medium, 2 low**. All five are fixed, with regressions in
`test/audit/Audit20261004.t.sol`; reverting `src/` to the audited commit fails 8 of 8 of them.

The one that mattered was ours and three hours old: `_clearIfRecovered` read the **raw** primary feed
and compared an ETH-valued ratio against `mat`, so after denomination the ratio was understated by
the whole ETH/USD factor and a position restored to health **kept its liquidation mark**. Two mediums
in `Treasury` shared one cause — `try/catch` does not cover **decoding**, so a listed feed returning
`abi.encode(uint256(2))` for a bool panicked in the caller's frame where no catch clause could see it,
reverting `earnLine()` and every `earn`. And one low was a defect in the fix written for the
*previous* audit. Two audits running, a fix has needed its own review.

A note on retrieval: a read-only job with `github: false` publishes no artifact. The findings live only
in the work record (`GET /jobs/:id/submissions` → `submissions[0].findings`), and the second audit cited
an `artifacts/audit.md` it never produced — so its proof sources were lost and had to be rebuilt from
the written reproductions. Archive the record immediately.

## Known limits

- **Nothing here operates the protocol.** A CDP protocol with no keeper is a contract that
  accumulates bad debt: somebody has to relay attestations before feeds go stale, mark positions, and
  bite them with their own stablecoin. That lives in **`fa11up/imd-keeper`**, which is private on
  purpose — it publishes bidding thresholds a searcher would use to be one block earlier.
- The live deployment's reporter and relayer are a single testnet key. **Mainnet must be a fresh
  deployment with a key held outside this repository.**
- `Registry` is written and governed but **nothing reads it**, so a rotation recorded there changes
  nothing. Wiring it means a feed resolving its relayer through a pinned registry instead of an
  immutable, which trades an immutable authority check for an external call on the attestation path.
- **Redemption is channel A only.** `cash` burns imdUSD for sIMD at the lesser of $1 and
  `backingPerUnit()`, less a size-dependent fee, at `payoutPrice()`, paid from the Treasury reserve first and
  then from a named position below `mat + gap`. Channel B in `docs/COMPUTE-BACKING-DESIGN.md` §5 is not built.
- **Minting from work ships off** (`WAGE_WAD = 0`): `earn` and work claims are refused until governance
  proposes a wage behind the 48-hour delay. The mainnet vault is deployed with the real `SwarmWorkOracle`
  (through `WorkOracleFactory`, whose address `release/mainnet` pins); on `main` `WORK_ORACLE_FACTORY` is
  still a placeholder, and the testnet manifests pass zero, which is the faucet, deliberately.
- `cut` is bounded but the bound is economically empty at its top: at 10000 a
  liquidator who did not mark receives exactly the principal back, so liquidations stop.
- There is no insurance fund. A liquidation can leave bad debt; `bite` sweeps an unreachable remainder so
  the position closes rather than freezing, and anyone may `cover` recorded bad debt with imdUSD the
  Treasury holds, but only as far as the Treasury has it.

## Documents

| | |
|---|---|
| `docs/COMPUTE-BACKING-DESIGN.md` | compute-backed minting and redemption, with the measurements behind it |
| `docs/AUDIT-2026-10-03.md` | the first independent review and every finding |
| `docs/AUDIT-2026-10-04.md` | the second, on the USD denomination and work backing |
| `oracle/work-tally-quote.json` | the question `SwarmWorkOracle` pins, read from the daily oracle receipts |
| `docs/MAINNET-RUNBOOK.md` | keys, constants, the one-broadcast CREATE2 deploy and what to read back |
| `fa11up/imd-keeper` *(private)* | the off-chain operator: price watcher, attestation relayer, CDP liquidator |
| `docs/UPSTREAM-ASKS.md` | what we have asked the operator for, what landed, and what is settled |
| `docs/archive/` | superseded per-increment notes, kept for history |
| `docs/UPSTREAM-STABLE-QUESTION-ID.md` | why `questionHash` is unstable, and why that is not a PR yet |
| `docs/ABI.md` | the deployed interfaces |
