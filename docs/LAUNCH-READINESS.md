# Launch readiness (2026-10-05, status updated at the freeze 2026-10-10)

**Frozen:** the deploy commit is `release/mainnet` at `9e37405` (tag `mainnet-freeze-2026-10-10c`). Its contracts
equal `main`'s except `src/DeploymentConfig.sol`, which carries the converged mainnet plan: governance Safe
`0xbeFd108085613662356aa26A2466Ad3426DA9C32`, Intake v2 `0xa43e6F75ee006411F79Ac1C84120606C2330DE82`, `OracleAsker`
`0x4B1c81141dC3755f24c7c227C0368383Ba2AB43B`, `TreasuryFactory` `0xEB2Bc6C3f05eeeFf436201E11f4c455c974772E9`.

The goal: deployable on short notice. Each area says what is done, the evidence, and what is still owed.
**Blocking** = cannot deploy without it. **Before freeze** = must be decided before the deploy commit is
frozen, because the contracts are immutable. **After deploy** = first operational acts.

## 1. Contracts

| item | status | evidence |
|---|---|---|
| External audit, three panels (vault, governance + Treasury, oracle) | done, all fixed or accepted | `AUDIT-{VAULT,GOVERNANCE,ORACLE}-2026-10-05.md`, `AUDIT-FIX-PLAN-2026-10-05.md` |
| Adversarial review of the fixes + gas review | done, merged `9dd2149` | `AUDIT-ADVERSARIAL-2026-10-05.md`, `AUDIT-GAS-2026-10-05.md` |
| Internal suites | green at the freeze: forge 654/0 (4 skipped); `AUDIT_PROOFS` 655/0; `script/checks` 116/116 (the 23 stale assertions were recomputed from the shipped rules); fork 6/6 incl. `test/fork/IntakeV2.t.sol` against the live Intake v2 | `docs/AUDIT-INTERNAL-2026-10-10-INTAKE-V2.md` |
| Redemption invariant, the 1-wei rounding note | **closed**: 40 fresh seeds, 0 failures, after the handler model was corrected to the vault's payout scale (`9dd2149`) | |
| **Scoped pre-deploy review** (everything after `03e8d0c`: phase-2 fixes, the `SwarmWorkOracle` creator change, `DeployMainnet` + `plan.py`, the asymmetric asker trigger and the governed work-oracle slot) | **done**: final adversarial reviews (`AUDIT-FINAL-2026-10-07.md`, `AUDIT-FINAL-2-2026-10-07.md`), panel rounds through the fourth final sweep (`AUDIT-FINAL-SWEEP-4-2026-10-09.md`, no high), and in-house reviews of the work-root fix and the Intake v2 failure callback (`AUDIT-INTERNAL-2026-10-10-*.md`) | `web/content/docs/reference/audit-history.md` |
| Accepted residuals | D2 chunked-redemption fee, D3 non-monotone backing figure, D4 two-push drift arming, D5 sIMD same-block hold griefing, D6 self-mark 18% penalty, D9 recapitalised drained borrower | `AUDIT-FIX-PLAN-2026-10-05.md` |

## 2. Deployment

| item | status |
|---|---|
| `script/DeployMainnet.s.sol` (CREATE2 plan, refuse-unless-matching, resumable, read-back, record for the keeper) | built `9314830` |
| `deploy/mainnet/plan.py` converges the config (4 passes) | built |
| Fork rehearsal `deploy/mainnet/rehearse-fork.sh` | **passing** end to end, incl. the keeper |
| Intake bodies match the feeds' pinned questions | `node deploy/mainnet/check-bodies.mjs` passes |
| **Intake deployed by the dev, address known** | **done**: live since 2026-10-07 (v1 `0x1397…ea56`); `INTAKE` is v2 `0xa43e…de82` since 2026-10-10, and `OracleAsker` buys through its `requestWithFailure`, so a refused or unanswered request clears the feed's in-flight slot at once (`onOracleFailure`, `AskFailed`) |
| Cold governance address, throwaway deployer (~0.05 ETH) | governance: **done**, the 2-of-3 Safe above (also `FEE_RECIPIENT`); deployer: at deploy time |
| Live attestations for NHI and SPOT with the frozen payloads | user: proven on testnet (request ids not in this repo's record; only PRICE `e2c85027` is archived) |

## 3. Oracle operations

| item | status |
|---|---|
| Guard analysis on 50 days of IMD history | done: `oracle-guards/ORACLE-GUARDS-2026-10-05.md` |
| Asymmetric trigger: the Treasury pays on a 5% FALL, never on a rise (worst over-valuation 21% → 9.0%, cost 3.9 → 2.2 IMD/day) | **built** (`OracleAsker.triggerBps`), keeper reads it, rehearsed |
| `ORACLE_BUDGET_PER_DAY` 15 IMD | **built** (governable later behind 48h) |
| Feeds kept live at launch | ours: the keeper drives the Treasury-paid path (drift + NHI keep-alive) and pays itself (`askPaid`) when positions are at risk |
| Sponsor points for anyone who pays for updates | no contract change needed: `AskedPaid(feed, requestId, payer, price)` is already emitted, so the points engine can credit payers off chain; a co-op hub can come later without touching the protocol |

## 4. Keeper

| item | status |
|---|---|
| Mainnet mode (deployment record, asker path, sIMD pricing, inventory-capped bites, guarded sends, one-at-a-time loops) | done, `imdusd/imd-keeper@7888e46` at the freeze, rehearsed on the fork |
| Review | internal only (private repo; the swarm cannot read it). Its failure modes cost the keeper's own funds, not the protocol's solvency |
| Host (NOT the swarm worker box), hot key, three balances (ETH gas, imdUSD inventory, IMD for `askPaid`), Blockscout API key | **after deploy** — user |

## 5. Frontend and docs

| item | status |
|---|---|
| Public site (homepage + docs) live on imdusd.com, terminal gated off | done |
| QA + accessibility review | done on the terminal before the sIMD / maker changes (`QA-REVIEW-2026-10-05.md`) |
| Browser suite against the **maker** ABIs | **owed**: now runnable — point `web/deployment-source.json` at the fork rehearsal's deployment |
| Launch values on the homepage and docs | docs: **filled** from the frozen code (2026-10-10); homepage `LAUNCH` in `web/src/Landing.tsx` still reads "Pending". Addresses: **after deploy**, from `deployment.json` |

## 6. Governance, first acts (runbook §7)

Seed the three feeds (3 attestations), list sIMD as a reserve asset (48h), fund the keeper, start it, then
announce. The window to abandon closes at the first user deposit.

## 7. Upstream

Drafts in `docs/upstream/`: stability promises (issue), imdUSD as payment (issue), window-free question id
(issue, discussion), and the direct asks led by the Intake.

## 8. Work integration — the one migration risk

**Accepting imdUSD as payment needs nothing from our contracts**: imdUSD is a plain ERC-20 and acceptance is
the plane's listing (x402 / Intake `priceOf`). The swarm's payment door is already on Ethereum mainnet.

**Minting from work is different.** The vault's work oracle is `immutable` and pins, in bytecode: the
WorkRegistry address, the daily-receipt jobId scheme, the `identitymd-oracle-batch-v2` schema and its leaf
encoding, and the attester. Minting ships off (wage 0), so nothing is at risk at launch — but if the
"full circle" integration needs ANY of those to differ, turning minting on would need a new vault and a
migration of every position.

The same class of risk covers the price feeds through the pinned attester key: an in-place key rotation
upstream bricks every feed. That one is not ours to make governable (price authority is never governed —
a design rule), so it is handled upstream: the stability issue asks for additive versioning and a key
rotation overlap.

**BUILT (user's call, 2026-10-05):** a governed work-oracle slot — `Parameters` may replace the vault's work oracle
behind the 48-hour timelock, **only while the wage is zero**. Rights claimed under an earlier wage can
still be outstanding in the old oracle; what makes double-SPENDING impossible is that the vault reads one
oracle, `earn` is refused while the wage is zero, and a superseded SwarmWorkOracle refuses claims (final
panel audit, 2026-10-07). It is a governed power, not a neutral one: together with a reserve listing it
lets the governor mint, which Parameters states as a trust assumption.
`Parameters.proposeWorkOracle` (48h); `vault.oracle()` now returns the governed replacement or the created
oracle. Refused while the wage is nonzero (at proposal and at application); once anything has been minted
from work the replacement must name the current oracle as `predecessor()`. Vault initcode 44,210 / 49,152 when built; 47,946 at the freeze (margin 1,206 B).
`test/WorkOracleGovernance.t.sol` (7 tests). It removes the only known forced migration.
