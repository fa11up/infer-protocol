# Mainnet runbook

*Drafted 2026-10-04, while the tenth testnet increment was still executing. Nothing here has been
run on mainnet.*

**The deploy commit is frozen** (2026-10-10): branch `release/mainnet` at `9e37405`, tag
`mainnet-freeze-2026-10-10c`, which supersedes the earlier freezes `cc98431` and `42bb580`. It differs
from `main` in `src/DeploymentConfig.sol` only: the release carries the converged mainnet addresses, `main`
keeps the Sepolia values and placeholders. Any further contract change means replan, re-freeze and rerun
the rehearsals.

This is the operational document for moving this protocol from Sepolia to Ethereum mainnet: what has
to be true before the first transaction, which keys exist and what each can do, the deployment
sequence, and what to read back off chain after each step. It exists partly to be **audited** — the
configuration layer has never had independent review, and an audit needs files to review.

**What this is not.** It is not a decision record (`docs/COMPUTE-BACKING-DESIGN.md` is), not a
contract reference (`README.md` and `docs/ABI.md` are), and not a schedule. It says how, not when.

---

## 0. The name changes first

Mainnet launches as **INFER** — *Inference-Backed Endogenous Financial Reserve* — and the stablecoin
is **imdUSD**. "COMP" was a testnet placeholder and must not reach mainnet: COMP is Compound's
governance token, listed on every major venue, so shipping a second one guarantees mislabelling by
aggregators, refused listings, and a domain and ENS name that belong to someone else.

The on-chain cost of the rename is **one line** — `ERC20("imdUSD", "imdUSD")` in
`src/ImdUSD.sol` — because the Solidity identifier never appears in a launch manifest (the vault
creates the token in its own constructor). Everything else is identifiers and prose.

Nothing else in this runbook depends on the name, but the name must be settled before the deploy,
because the token's `name()` and `symbol()` are immutable once constructed.

---

## 1. Prerequisites, in order

Each step assumes the previous one is merged and green. Steps 2 and 3 are independent of each other.

| # | step | why it blocks mainnet |
|---|---|---|
| 1 | Rename COMP → imdUSD | the token's identity is immutable once deployed |
| 2 | sIMD as the collateral token (wrap on deposit) — **built** | decides what collateral *is*. Deploy the vault with `StakedIMD` `0x9Efa934D9fAd4AE28c998a40195646b965a97247` as its collateral token: it then prices collateral through a `SharePriceFeed` it creates, and `lockIMD` wraps plain IMD on deposit. Fork-tested against the live vault (`test/ShareCollateralFork.t.sol`). |
| 2b | Oracle paid from the Treasury (`OracleAsker` + `Treasury.fundOracle`) — **built; the Intake is live** | without it every price update is bought by hand in a browser. `OracleAsker` buys through the IdentityMD Intake only when the chain shows a need (a keep-alive feed, which is NHI only, 75% of the way to stale; IMD's v4 pool armed-and-still a quarter of the deviation cap BELOW a price feed; or any feed silent a whole lifetime whose allowance has widened to `WIDE_ALLOWANCE_BPS`, 60%) and delivers through SwarmRelay inside the Intake's 200k-gas callback stipend (heaviest delivery measured 147,114 gas; the failure callback 22,815). `fundOracle` streams at most `Parameters.oracleBudget` IMD per UTC day to it — keyless, unwrapping sIMD on the way. **Unblocked 2026-10-07:** PR #66 merged and the Intake went live at `0x1397434cd35e8a9C8aC312A61D3A285EB31dea56`. **Since 2026-10-10 `INTAKE` is Intake v2, `0xa43e6F75ee006411F79Ac1C84120606C2330DE82`** (plane `f5c0d20b`; same owner, writer, signer, 200,000-gas callback stipend and 0.5 IMD price as v1; v1 stays served). v2 keeps every v1 function, event and getter unchanged and adds a failure callback (`requestWithFailure`), **which `OracleAsker` now uses**: every request names `onOracleFailure`, and when the plane refuses the ask (status 1) or the panel ends without a result (status 2) the Intake calls it at once. The feed's in-flight slot clears then rather than at `ASK_TIMEOUT` (two hours during which nobody, keeper or borrower, could buy that feed an update), `AskFailed(feed, requestId, status, reason, agreed, answered)` says so on chain, and the Treasury's own purchase backs off for the timeout as after a refused relay (a failed request is not refunded; a caller's failed purchase holds the Treasury back no more than its answer would have). Measured 22,815 gas against the 200,000 stipend. It had to change with the address because `OracleAsker` accepts deliveries only from `INTAKE`. Proven against the live contract in `test/fork/IntakeV2.t.sol`: payment through `requestWithFailure`, the answer callback, the failure callback for both statuses with the slot clearing and a purchase landing in the next transaction, and v2 refusing failure arguments that name another request. On `main`, `ORACLE_ASKER` stays a placeholder (`0x…f07`); on `release/mainnet` `plan.py` has converged it to `0x4B1c81141dC3755f24c7c227C0368383Ba2AB43B` (and `TREASURY_FACTORY` to `0xEB2Bc6C3f05eeeFf436201E11f4c455c974772E9`), which supersede the plans `0x255295…`, `0x1b7A21…` and `0x9061…` made before the Intake and failure-callback changes. The asker's constructor still refuses an `INTAKE` with no code. |
| 3 | **Delete the reporter fallback** — **done** (`SwarmFeed` has no `report`; attestations are the only way a value is set) | a single key can otherwise re-anchor the price — see §4 |
| 4 | CREATE2 deployment script with address assertions — **built** (`script/DeployMainnet.s.sol`, `deploy/mainnet/`), rehearsed on a fork | removes the silent-misconfiguration failure mode — see §6 |
| 5 | Independent audit of this configuration — **done** (three panels + adversarial + gas, `docs/AUDIT-*-2026-10-05.md`, fixes through `9dd2149`). The scoped review owed after `03e8d0c` is **done** too: two final adversarial reviews, then panel rounds through the fourth final sweep (job `6229d0fc`, no high), then two in-house reviews of the last changes (`docs/AUDIT-INTERNAL-2026-10-10-*.md`); the chain is in `web/content/docs/reference/audit-history.md` | the configuration and every fix after it have had outside review |
| 6 | Keeper / watcher daemon — **mainnet-ready** (`imdusd/imd-keeper@7888e46` at the freeze), rehearsed bark → bite → Treasury-paid ask on a fork | the protocol is not operable without it — see §7 |

---

## 2. Keys

Only **two** keys need provisioning, plus one throwaway. Contracts replaced the rest, which is the
point: an authority held by a contract with no owner cannot be lost, stolen or mis-set.

| name | what it can do | where it lives |
|---|---|---|
| `APPROVED_OPERATOR` | propose parameter changes (48 h timelock), list and delist reserve assets, withdraw from the Treasury anything that is not the collateral or a listed reserve asset, and imdUSD only down to outstanding bad debt (for governor-managed LP) | **a 2-of-3 Safe, `0xbeFd108085613662356aa26A2466Ad3426DA9C32` on `release/mainnet`. Never on a server.** It is a constant, so the address can never change; signers and threshold rotate inside the Safe. |
| keeper daemon | relay attestations, bite, mark, buy oracle requests | **hot, on its own machine.** Never the swarm worker box: tasks from strangers execute as that user. |
| deployer | one-time broadcast; needs ETH only | throwaway, discard after §6 |

Held by contracts, not keys:

| constant | points at | consequence |
|---|---|---|
| `feeRecipient()` | the **Treasury the vault creates** in its constructor | protocol revenue cannot land in a wallet. `ParameterizedVault` overrides `feeRecipient()`, so the `FEE_RECIPIENT` constant is read only by the plain `CDPVault`, which mainnet does not deploy. **No standalone Treasury is needed** (docs job 2f5a387d found the runbook deploying one that would receive nothing). |
| `ATTESTATION_RELAYER` | the **SwarmRelay** contract | relaying is permissionless; no relayer key to lose |
| `WORK_ORACLE_FACTORY` | the **WorkOracleFactory** contract | the work oracle's creation code lives outside the vault |

Not ours:

| constant | whose | documented assumption |
|---|---|---|
| `ORACLE_ATTESTER` | the IdentityMD operator's signer | **a single key signs every attestation.** Question binding means a signature must answer *our* pinned question and clear the panel floors, which bounds it considerably — but it is one signer on the price path, and that is a trust assumption of this protocol, not a bug in it. |

### What the keeper needs funded

Three separate balances, and they are not interchangeable:

* **ETH** for gas.
* **imdUSD inventory** — `bite` burns the *caller's* stablecoin. A keeper with no imdUSD cannot
  bite anything. This is working capital, not an expense.
* **No IMD.** The launch keeper never pays for an oracle request itself (`KEEPER_ORACLE_FALLBACK = false`,
  `ASK_PAID_IMD_PER_DAY = 0`, decided 2026-10-09): it triggers the Treasury-paid updates the OracleAsker
  already allows, funded by the IMD sent to the asker at deploy (section 7 step 4).

Oracle requests are no longer the keeper's to fund: `Treasury.fundOracle()` streams up to
`Parameters.oracleBudget` IMD a day to `OracleAsker`, which pays the Intake (prereq 2b). That is the
budgeted, keyless route the earlier "spender role" note asked for — a destination fixed in source and
a governed daily cap, not an authority. The keeper still needs ETH for gas and imdUSD inventory to
bite. `Treasury.withdraw` stays `APPROVED_OPERATOR`-only; do not put that key on the daemon.

---

## 3. Constants, classified

Every value in `src/DeploymentConfig.sol`, and what has to happen to it. **A constant that is wrong
is immutable and silent** — this is exactly how launch 519 shipped two dead feeds.

### Must change for mainnet

| constant | now (Sepolia) | mainnet |
|---|---|---|
| `CHAINLINK_ETH_USD` | `0x694AA176…` (Sepolia) | **`0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419`** |
| `APPROVED_OPERATOR` | miyagod.eth EOA | the governance Safe (set on `release/mainnet`) |
| `FEE_RECIPIENT` | miyagod.eth EOA | unused by `ParameterizedVault`; set to the governance Safe so nothing names a hot wallet |
| `ATTESTATION_RELAYER` | the Sepolia SwarmRelay | the mainnet SwarmRelay (CREATE2, §6) |
| `WORK_ORACLE_FACTORY` | `0x…0f05` placeholder, no code | the mainnet factory (CREATE2, §6) |

### Must be deleted

| constant | why |
|---|---|
| `FEED_REPORTER_0/1/2`, `FEED_QUORUM` | §4. Removing the fallback removes these and four constructor arguments from every feed. |

### Verify, do not assume

| constant | check |
|---|---|
| `ORACLE_ATTESTER` | the live service's signer. Confirm against a real attestation before deploying; `test/InHouse.t.sol` pins the typehash and domain against the live service and must pass on a **mainnet** fork. |
| `ATTESTATION_CHAIN_ID` | already `1`. The data chain was always mainnet, even while the consumer was Sepolia — do not "fix" it. |
| `ATTESTATION_ANSWER_TYPE` | `3` = uint256. Launch 519 shipped `1` (address) and the feeds were permanently unusable. |

### Economic, carry over unchanged unless deliberately revised

Values as in `src/DeploymentConfig.sol` and `script/DeployMainnet.s.sol` on 2026-10-06 (the source is
authoritative; this list is checked against it, not the other way round):
`SKEW_BPS` 500 · `CHIP_BPS` 1000 · `CUT_BPS` 1000 · `DUTY_BPS` 444 · `LINE` $1M · `REDEMPTION_DIVISOR` 2 ·
`ETH_USD_MAX_AGE` 2 hours · `PRICE_MAX_AGE` / `SPOT_MAX_AGE` 1 hour · `NHI_MAX_AGE` 1 day ·
feed `maxDeviationBps` 2000 (stale: 2x, `SwarmFeed.STALE_DEVIATION_MULTIPLE`) · `ORACLE_BUDGET_PER_DAY` 15 IMD.
Unchanged at the freeze (`9e37405`), with `EARN_MAT_BPS` 2500 · `WAGE_WAD` 0 · stream off · `CHOP_PERCENT` 20 ·
redemption fee 50–500 bps · `gap` 50.

### The compute channel ships off

`EARN_MAT_BPS`, `WAGE_WAD` and `WORK_ORACLE_MAX_AGE` ship in the deployment, with minting from work OFF
(`WAGE_WAD = 0`). The work oracle no longer names one agent: it asks the ERC-8004 adapter who controls each
agent (`isController`), so every agent's controller claims its own credit. Turning minting on is a governed
wage proposal, not a redeploy; see §7b.

The economic values above are governable through `Parameters` under a 48-hour delay, so a wrong value here
is a correctable mistake rather than a permanent one. That asymmetry is the design: economics are
governable, authority never is.

---

## 4. Why the reporter fallback must not ship

`SwarmFeed.report()` lets `FEED_REPORTER_0` set a feed's value directly. The deviation bound caps
the move at `maxDeviationBps` **while the current value is fresh** — but once the value ages past
`maxAge`, the bound lifts entirely and the next accepted value re-anchors the band to anything. On
mainnet that is one key able to set the price of all collateral after a day of staleness, which is
custody of every position.

It cannot simply be pointed somewhere harmless and left in: the honest fix is deletion. The
machinery is ~60 of `SwarmFeed`'s 352 lines — `report`, the reporter constants, `quorum`, `_median`,
`_nextRound`, `round`, `reportCount`, `lastReportedRound`, `_reports`, `_roundStartedAt` — and
removing it drops four arguments from every feed constructor. `_accept` and `_checkValue` stay,
because the attestation path shares them.

**Two consequences to plan for.**

* `submitAttestation` calls `_nextRound()` to discard an unfinished fallback round. That call goes too.
* **A freshly deployed feed is inert until its first attestation.** Today a reporter seeds it. On
  mainnet the first operational act is buying three attestations (1.5 IMD) — see §7 — and until they
  land the vault refuses everything. That is the safe direction, and it is a sequence item, not a bug.
* `script/DeployGoverned.s.sol:44` currently requires the broadcaster to **be** the reporter
  (`require(operator == FEED_REPORTER_0, …)`). That is a testnet convenience and must be removed:
  on mainnet the broadcaster is a throwaway deployer and is neither the operator nor a reporter.

**The trade, stated plainly.** The reporter is a liveness fallback *and* a trust hole. Testnet wants
the fallback. Mainnet wants it gone and accepts that a stalled attestation pipeline halts the vault —
which is already how a stale feed behaves, so the failure mode is one we have tested.

---

## 5. Pre-flight, before any mainnet transaction

Run every one of these. Each has failed for real at least once in this project's history.

```bash
# 1. the suite, under the runner test/README.md documents
forge test                                   # at the freeze: 654 pass, 0 fail, 4 skipped
AUDIT_PROOFS=true forge test                 # 655 pass
forge test --match-path 'script/checks/*.t.sol'   # 116 pass

# 2. the fork suite against LIVE mainnet state, not Sepolia
forge test --match-path test/InHouse.t.sol         --fork-url $MAINNET_RPC_URL
forge test --match-path test/SharePriceFeedFork.t.sol --fork-url $MAINNET_RPC_URL

# 3. both deploy scripts dry-run against mainnet, with the real operator
OPERATOR=<cold> forge script script/DeployGoverned.s.sol --rpc-url $MAINNET_RPC_URL

# 4. every question prefix verified against a LIVE attestation, per feed
node oracle/question-prefix.mjs oracle/<payload>.json --verify <requestId>   # must print MATCH

# 5. the oracle payloads, against the feed they will actually target
node oracle/preflight-oracle.mjs <payload>.json <feedAddress> --rpc $MAINNET_RPC_URL
```

**Step 4 has never been done.** No prefix has been verified against a live attestation bought with
the frozen payloads. It costs 0.5 IMD per feed to find out, and the alternative is discovering a
one-character mismatch after deploying an immutable feed that refuses every attestation.

---

## 6. Deployment: one broadcast, with assertions

The prereq contracts (`SwarmRelay`, `WorkOracleFactory`, `TreasuryFactory`, and `OracleAsker` — see step 4) are read by other contracts as **source constants**, so their addresses
must be in the bytecode before the feeds compile. That looks like it forces two broadcasts. It does
not, because CREATE2 makes an address a pure function of initcode and salt:

```
address = keccak256(0xff ++ deployer ++ salt ++ keccak256(initcode))[12:]
```

None of SwarmRelay and the two factories references a feed, so there is no cycle — their addresses are computable with no
prior transaction. The canonical deterministic deployer
**`0x4e59b44847b379578588920cA78FbF26c0B4956C`** is live on mainnet and Sepolia with identical
bytecode (verified 2026-10-04), so the same salts give the same addresses on both, and later on Base
and Robinhood Chain.

### As built (2026-10-05): `script/DeployMainnet.s.sol`

```bash
node deploy/mainnet/check-bodies.mjs                     # the 3 Intake bodies: prefixes match, relative windows, no guards
git switch -c release/mainnet                            # plan.py rewrites constants the Sepolia fork tests use
python3 deploy/mainnet/plan.py --write --operator <cold governance> --intake <the swarm's Intake>
#   sets APPROVED_OPERATOR, FEE_RECIPIENT, INTAKE, then converges ATTESTATION_RELAYER, WORK_ORACLE_FACTORY,
#   ORACLE_ASKER, TREASURY_FACTORY and CHAINLINK_ETH_USD on the CREATE2 plan (4 passes from the Sepolia config)
forge test && <suites> ; git commit                      # THIS commit is what the scoped review and the broadcast use
KEEPER_DIR=../imd-keeper deploy/mainnet/rehearse-fork.sh # full rehearsal on an anvil fork (does not touch the tree)
FOUNDRY_PROFILE=deploy OPERATOR=<cold governance> forge script script/DeployMainnet.s.sol --rpc-url $MAINNET_RPC_URL \
    --broadcast --slow --account <throwaway deployer>
```

`run()` refuses unless: chain id 1; Chainlink is mainnet's and fresh; every planned address equals its
source constant; `INTAKE` has code; `OPERATOR` equals `APPROVED_OPERATOR`; the broadcaster is NOT the
operator; StakedIMD wraps IMD; the wage and the stream ship off. It is resumable (an address that already
has code is skipped). Each stage reads back off chain what it deployed and writes
`deploy/mainnet/out/deployment.json` + `bodies/`, which is what the keeper runs from; stage two adds the
vault and what it created, recorded before `verify` runs.

Choices fixed in the script, part of the deploy commit: salts `infer-protocol/mainnet/v1/<Contract>` for
every contract but the vault (below); feed
`maxDeviationBps` **2000** (the asker asks on a FALL of 5%, a quarter of the cap, never on a rise); the
asker treats price and spot as pool-tracked and keeps only NHI alive on the Treasury's clock (any feed
silent a lifetime with its allowance wide open is also paid for, price and spot included).

The vault's salt is not in the script: `runVault()` reads it from `VAULT_SALT`, the operator's secret,
and refuses it unset or equal to the salt this file once named. With the salt public, anyone could fill
the vault's CREATE2 address between the stages, since its initcode is public once stage one lands (final
sweep panel audit 2026-10-08, low). Nothing reads the vault's address as a source constant, so nothing
needs the salt before stage two, and stage two goes through a private relay (§7 step 2) so the salt is
not public before the vault exists. deployment.json records the vault only once it is deployed. Neither
stage runs while deployment.json names a deployed vault other than the one `VAULT_SALT` gives, so a rerun
with another salt cannot deploy a second vault or drop the first from the keeper's record.

Rehearsed on a mainnet fork: 8 transactions, **26.2M gas** in total, the largest the vault at **12.7M**
(block limit 60M) — about 0.026 ETH at 1 gwei.

FOUND WHILE BUILDING IT: `SwarmWorkOracle`'s constructor compared its creator to `WORK_ORACLE_FACTORY`, so
the factory's initcode contained the factory's own address and no CREATE2 address could ever satisfy it.
It now accepts any contract creator; `CDPVault._validateOracle` is what binds the oracle to the vault.

### Why the swarm does not deploy this (checked against plane `b5dd2eb`, 2026-10-05)

Mainnet launches are open (chain 1, all four kinds), but a swarm launch cannot run this script. The
deployer service only calls `ProjectFactory.launchContracts`: up to 8 contracts, **one transaction**,
each at `CREATE2(factory, contractSalt(launchNumber, i), initcode)`, constructors run as the factory.
Three things rule it out for this stack:

1. **Gas.** The stack is 26.2M gas; EIP-7825 caps a transaction at 16,777,216 (the plane's own
   `MAX_TRANSACTION_GAS`). It would take three separate launches.
2. **Addresses.** Four addresses are compile-time constants read by immutable code. A launch's
   addresses depend on a launch number the plane assigns at admission, so each launch would need the
   previous one's numbers compiled in first: three paid, sequential swarm jobs with a recompile and a
   re-pinned commit between each — or rewriting those constants as constructor arguments, which is the
   manifest-supplied-authority shape that bricked launch 519.
3. **Nothing gained on cost.** Our own broadcast is ~0.006 ETH at today's 0.12 gwei.

The dev's ceiling is honoured here instead: `run()` refuses unless (base fee + 0.1 gwei) x 28M gas
≤ **0.05 ETH** (i.e. base fee ≤ ~1.7 gwei), and checks each deployment stays under the EIP-7825 cap
(largest, the vault, 12.7M). Broadcast with `--priority-gas-price` ≤ 0.1 gwei.

### The sequence

1. **Compute** the CREATE2 addresses of `SwarmRelay`, `WorkOracleFactory` and `TreasuryFactory` from their
   initcode and chosen salts. No transaction.
2. **Write** them into `src/DeploymentConfig.sol`, along with every value in §3. Commit — the commit
   hash is what the configuration audit reviews.
3. **Compile.** The feeds now embed the right addresses.
4. **Dry-run.** The script recomputes each CREATE2 address from the compiled initcode and
   **asserts it equals the source constant.** A mistyped address fails here, before any gas is spent.
   This assertion is the whole reason to prefer CREATE2 over two broadcasts.
   **`ORACLE_ASKER` is a fourth computed address, and it comes AFTER the feeds:** its constructor
   takes the feed addresses and their body hashes, so its initcode (and CREATE2 address) depends on
   them, while the Treasury the vault creates reads it as a source constant. Feeds do not reference
   it, so there is no cycle: compute the feeds' addresses, then the asker's, then write the constant.
   Every body must use a RELATIVE window (`"window":{"hours":N}`): a literal block window can be answered
   only once, then every repeat is refused as not advancing. Its body hashes are `keccak256` of the frozen oracle.request bodies — the same bytes the feeds'
   pinned questions were generated from.
5. **Broadcast** the prereqs at their computed addresses, then the three feeds (stage one), then, after
   the first values are checked (§7), the vault from the secret salt through a private relay (stage two), which creates imdUSD, `Parameters`, the Treasury's sibling and `UsdPriceFeed` in its own
   constructor, so the stack comes up linked with no follow-up transaction.
6. **Read it back off chain.** Not the script's own logs — the chain:
   * each feed's `attester`, `relayer`, `attestationChainId`, `attestationAnswerType`, `maxAge`,
     `maxDeviationBps`
   * each feed's `expectedQuestionHash(from, to)` against the JavaScript hash for the same window
   * the vault's `gem`, `stablecoin`, `oracle`, `priceFeed`, `nhiFeed`, `spotFeed`,
     `parameters`, `treasury`, `usdPriceFeed`, `feeRecipient`
   * `treasury.vault() == vault` and `parameters.vault() == vault`
   * `vault.earnLine() == 0` — correct on an empty stack, and proof the ceiling is live

### Rollback position

| after step | what exists | how to abandon |
|---|---|---|
| 1–4 | nothing on chain | delete the branch |
| 5, prereqs deployed | ownerless contracts holding nothing | **abandon them.** They cost gas and hold no funds or authority. Pick new salts and start again — do not try to reuse them. |
| 5, feeds deployed | immutable feeds, unseeded | abandon. An unseeded feed is inert and holds nothing. |
| 5, vault deployed | the whole stack, no positions | abandon **only before anyone deposits.** After the first deposit there is no rollback, only migration. |
| 7, seeded | a live protocol | no rollback. |

The practical implication: **the window to abandon closes at the first user deposit, not at the
deploy.** Deploy, verify, and only then announce.

---

## 7. First operational acts, in order

The deploy itself is `run()` (everything but the vault), then steps 1 and 2 below, then `runVault()`.

The deploy is TWO stages (`DeployMainnet.run`, then `runVault`), and the first values go between them:
the vault is live from its constructor, so deployed in one go it could price a draw against a first value
somebody else raced in off a pumped pool before any check ran (sweep panel audit, oracle, low). The split
buys a check the operator runs before deploying the vault; the secret salt and the private relay are what
stop anyone else deploying it first (final sweep panel audit 2026-10-08, low: with the salt public, anyone
could).

1. **Buy one attestation per feed** and relay it (stage one has deployed the feeds and the asker, not
   the vault). Until each feed holds a value it is stale. Three requests, 1.5 IMD. Order matters: walk
   the feeds to the live market *before* pinning any guards — a request bought with guards around a
   stale level was refused by a panel when IMD moved 44.6% in a day.
2. **Verify on chain** that each feed's value is the attested figure, that `usedRequests[requestId]` is
   true, and that divergence between primary and spot is inside `SKEW_BPS`. Then run
   `REFERENCE_IMD_ETH_WEI=<market> REFERENCE_NHI=<index> forge script script/DeployMainnet.s.sol --sig "verifySeeded()"
   --rpc-url $MAINNET_RPC_URL`, where `<market>` is IMD's price in wei of ETH per 1e18 IMD taken from
   somewhere the pool cannot be held against (the day's observed market, the explorer's history) and
   `<index>` is the live network health index as you read it (`api.imd.fun/swarm`, 1e18-scaled): a
   feed's first value is bounded by nothing on chain and the relay is permissionless, and the pool itself
   can be held at a pumped level through the check. It refuses a pool more than 5% from the reference,
   a price or spot value more than 5% from the pool, and an NHI more than 5% from the index or at or
   under 0.6 (the vault would open at mat 200 with no grace, and the feed's daily epoch would take days
   to walk it back: payout vault panel 2026-10-09, low). **If it fails, do not deploy the vault**: the
   feed follows the market once its allowance has widened (two hours of silence for 40%, longer for
   more), so relay honest values and run it again. Then `runVault()` (same environment plus the
   reference and `VAULT_SALT`) deploys the vault and runs `verify`. Make the salt fresh and random
   (`openssl rand -hex 32`, prefixed `0x`) and keep it out of the repository, shell history and logs.
   **Broadcast it through MEV Blocker's full-privacy endpoint** (`--rpc-url https://rpc.mevblocker.io/fullprivacy`),
   never the default endpoint or a public mempool: the transaction carries the salt in its calldata, the
   default endpoint shares transactions (without signatures) with searchers, and until it lands anyone who
   saw it could deploy the same vault first (delta panel audit 2026-10-08, low). If `verify` then refuses
   a vault that is already there, stop: deployment.json records it, and the operator decides from what
   is at the address. What a redemption is paid can rise by at most
   two points of par an hour however much capital arrives (`BACKING_RISE_PER_HOUR`, the paced backing), so
   no size of loan lifts a below-par payout faster than that; an honest recovery reaches redeemers at the
   same rate.
3. **List the reserve assets** through `Parameters.proposeReserveAsset` — each needs a price source
   and a haircut, and each waits 48 hours. Until the register is non-empty, `reserveValueUsd()` is
   zero and so is the first term of `earnLine`.
4. **Start the keeper and fund the OracleAsker** before announcing. **Decided 2026-10-09:** send **5 IMD
   straight to `ORACLE_ASKER`** right after the vault, and run the keeper with `KEEPER_ORACLE_FALLBACK = false`
   and `ASK_PAID_IMD_PER_DAY = 0`: it calls `fundOracle`, arms and asks on falls of 5% or more, keeps NHI alive
   at 75% of its age and refreshes a wide-open feed, all paid from the asker's balance, and never spends its
   own IMD. The feeds are seeded once, by `launch.sh seed` inside `go`. A quiet market costs about 3 IMD a day
   (NHI every ~18 h, price and spot wide-open refreshes every ~9 h), so 5 IMD covers the hold before INFER's
   launch fees reach the Treasury; watch the asker's balance (the ops dashboard alerts below 1 IMD) and top it up.
   The paragraphs below are the 2026-10-07 reasoning that preceded this; the keeper-pays fallback they describe
   exists in the keeper and is switched off.

   *2026-10-07:* `Treasury.fundOracle` pays from the Treasury's plain IMD and sIMD, and until revenue lands
   (launch-pool fees, liquidation cuts) it holds neither — so it cannot fund the asker, and nothing in this
   sequence would keep NHI alive: 24 hours after the hand-seeded value every price action would refuse
   `StaleFeed` (final review 2026-10-07, medium). The keeper covers that gap with its own IMD
   (`KEEPER_ORACLE_FALLBACK`, within `ASK_PAID_IMD_PER_DAY`): NHI near stale first, then falls, then a
   primary whose allowance has widened. It prints `FUNDING …` on every run while the Treasury cannot
   pay. Once revenue lands (launch-pool fees in IMD arrive through `handOffLaunchFees`; liquidation
   cuts in sIMD) the Treasury takes over and the fallback can be switched off: `fundOracle` spends the
   Treasury's plain IMD first and unwraps sIMD after it (it spent only sIMD before the final panel audit),
   unless IMD has been listed as a reserve asset, which keeps it protected. An unattended protocol
   with live positions and no liquidator accumulates bad debt.

   **Two things that path needs (second-half review 2026-10-07, low).** (a) A refused answer still
   costs the full price (`askPaid` pulls it before the request), and NHI carries the same 20% cap as
   the price feeds against a one-day epoch: if the live index has moved more than the feed's allowance
   from its anchor, every purchase before the allowance widens (25 hours after the last value for 40%)
   is refused and charged, and four of them are the keeper's whole day. The keeper therefore reads the
   live index (`api.imd.fun/swarm`, the NHI body's own formula) against `NhiFeed.epoch()` before every
   NHI purchase and waits, saying how long, rather than buying an answer the feed will refuse; it holds
   its budget for the first purchase that lands. (b) Transfer IMD straight to `ORACLE_ASKER` right
   after the deploy (5 IMD as of 2026-10-09; one day's budget, `ORACLE_BUDGET_PER_DAY` = 15 IMD, is the ceiling), so the
   Treasury-paid path is not dead on day one and the keeper's own IMD is the second line, not the only
   one. `fundOracle` tops the asker up only to the budget, so prefunding it is harmless.
5. **Only then** announce. Nothing gates deposits: the vault takes `lock` and `draw` from the block it lands, so
   until the announcement the only protection is that nobody knows the address.

---

## 7b. Minting from work: off at launch, switchable later — with one deploy-time requirement

Minting from work ships OFF (`WAGE_WAD = 0`; `SwarmWorkOracle.claim` refuses while the wage is zero, so
no agent's tasks are spent for nothing). Turning it on later is a governance action, not a redeploy:
`Parameters.proposeWage(wad)` (at most one imdUSD per task), visible for 48 hours, then anyone applies it.
`earnMat` and the reserve listings (also governed) set how much it can ever mint.

**Two things governance cannot do, so they are decided now:**

1. **The vault must be deployed with the real work oracle.** Pass `WORK_ORACLE_SENTINEL` as the vault's
   `oracle_` so it creates a `SwarmWorkOracle` through `WORK_ORACLE_FACTORY`. The oracle is immutable on
   the vault. `DeployGoverned`/`DeployProtocol` pass zero, which builds the TEST FAUCET (`MockWorkOracle`);
   the mainnet CREATE2 script must not.
2. ~~The deferred audit finding needs code.~~ **DONE.** D1 is closed by the paced figures
   (`paced()`, `BACKING_RISE_PER_HOUR`, `FOLLOW_BPS_PER_HOUR`, `PACE_INTERVAL`, since 2026-10-08; the per-position
   lag before them is gone): the redemption cap reads the paced backing, the fee base the paced supply, `backedDebt`
   the paced debt, at every wage; and the price a redemption is PAID at falls at most 1% an hour (`payoutPrice()`,
   `PAYOUT_PRICE_FALL_BPS_PER_HOUR`), so a one-step fall of the attested price, honest or a held-down pool,
   reaches the payout only at that rate: the whole 20% after about 22 paced hours (final sweep panel 2026-10-09,
   high; the rate bounds the speed of the fall, not its size, so at the 5% an hour first set a pool held down
   for five paced hours was paid the whole step: payout vault panel 2026-10-09, high). A pool pushed UP through
   one window writes the rise at once and underpays redeemers until it has decayed, about 18 hours for 20%
   (accepted: nobody is forced to redeem). Liquidation is NOT paced (final sweep panel 3 2026-10-09, high,
   accepted): a pool held down through the feed window and the six-hour grace lets a liquidator take 1.5x the
   debt repaid at the real price per 20% step, from borrowers who do not top up. Pacing it would stall
   liquidations in a real crash. Operators: watch for a pool held well under its recent range while marks
   appear across the book (a held-down pool, not a crash, is the alarm), and say so publicly; the site warns a
   connected borrower whose position is marked, with the grace countdown and what clears it. When the book
   reaches `LINE` the site says borrowing is closed until repayments or a governance raise (48 hours). Anyone may `pace()` and `resecure(owner)`; the keeper paces hourly and
   re-prices every open position after each price update, so a recovery reaches redeemers through a quiet spell
   and no position's collateral term stays fixed at a stale price (paced vault panel 2026-10-08, medium).
   Three rules keep the accepted dip rare (a position leaving and returning across two transactions paces the
   figure to the backing of the book without it): liquidate underwater positions promptly, cover realized bad
   debt promptly (donate imdUSD to the Treasury if no fees have accrued yet), and refinance in one transaction.
   Nothing about minting from work needs a new vault.
3. **The work oracle can be replaced only until the first mint, with what ships.** Once anything has
   been minted from work, `Parameters.proposeWorkOracle` requires the successor to answer
   `predecessor()` with the current oracle, and `SwarmWorkOracle` has no such function, so no oracle
   the shipped code can create qualifies (second-half review 2026-10-07, info). Replacing it after the
   first mint means a new contract type that carries the old tallies, then a 48-hour proposal; before
   the first mint, a fresh `SwarmWorkOracle` built directly for the vault,
   `new SwarmWorkOracle(address(vault), WORK_ORACLE_MAX_AGE)` from any account, is proposable, and
   `address(0)` (back to the vault's own) is too. `WorkOracleFactory.create` is NOT a route: it binds the
   oracle to its caller (final panel audit, governance, info). And at wage 0 nothing mints: `earn` is
   refused while the wage is zero, so rights claimed under an earlier wage wait for the next one.

## 8. Open decisions this runbook does not make

* ~~Whether the Treasury's reserve holds IMD or sIMD.~~ **DECIDED: sIMD only.** It falls out of the
  collateral choice rather than needing a policy — if collateral is sIMD then the protocol's bonus
  share arrives as sIMD, and stability fees arrive as imdUSD which the register refuses as a reserve
  asset on principle. So the reserve is sIMD by construction. One registered asset, priced by
  `SharePriceFeed`, and `reserveValueUsd()` sums over a single entry.
  **It is not listed automatically**: after deploy, propose `proposeReserveAsset(sIMD,
  vault.collateralPriceFeed(), haircut)` and apply it 48h later. Until then the reserve backs nothing in
  `earnLine` (redemption is unaffected — it prices the collateral it pays out itself). The Treasury
  values the vault's own collateral per 1e18 raw units, like the vault, so listing it through
  `collateralPriceFeed` is correct; before that fix it counted for a millionth of its value.
* ~~Redemption asset ordering.~~ **Obsolete.** With one reserve asset there is no order to establish,
  and the `Treasury._remove` swap-and-pop hazard — a delisting silently reordering the register — stops
  mattering. A redeemer receives sIMD from the reserve and sIMD from positions: the same asset either
  way, so the route is invisible to them.
* **Chains after mainnet.** `docs/DEPLOYMENT-PLAN.md` covers Base and Robinhood Chain. CREATE2 with
  fixed salts gives identical addresses, which is worth preserving deliberately rather than by luck.
* **Multi-collateral beyond sIMD.** Adding an uncorrelated asset (ETH, USDC) needs per-asset risk
  parameters and a restated solvency bound. sIMD does not, because it is the same risk asset in a
  wrapper. Do not let the second be used as precedent for the first.
* **Redemption channel B is now unnecessary, not merely deferred.** Its whole purpose is to price a
  redeemer's CHOICE among heterogeneous reserve assets by how far each sits below a target basket
  weight. With a single-asset reserve there is no choice to price, so the mechanism and the undecided
  basket weights both go away. It returns only if the reserve ever diversifies.
