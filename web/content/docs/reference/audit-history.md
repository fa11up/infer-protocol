---
title: Audit history
section: reference
order: 6
audience: everyone
sources:
  - docs/AUDIT-2026-10-03.md
  - docs/AUDIT-2026-10-04.md
  - docs/AUDIT-VAULT-2026-10-05.md
  - docs/AUDIT-ADVERSARIAL-2026-10-05.md
  - docs/AUDIT-FINAL-2026-10-07.md
  - docs/AUDIT-FINAL-PANEL-VAULT-2026-10-07.md
  - docs/AUDIT-SWEEP-PANEL-VAULT-2026-10-07.md
  - docs/AUDIT-RETRY-PANEL-VAULT-2026-10-07.md
  - docs/AUDIT-RETRY2-PANEL-VAULT-2026-10-08.md
  - docs/AUDIT-FINAL-VAULT-PANEL-2026-10-08.md
  - docs/AUDIT-FINAL-SWEEP-PANEL-2026-10-08.md
  - docs/AUDIT-DELTA-PANEL-2026-10-08.md
  - docs/AUDIT-LAUNCH-VAULT-PANEL-2026-10-08.md
  - docs/AUDIT-PACED-VAULT-PANEL-2026-10-08.md
  - docs/AUDIT-FINAL-SWEEP-2-2026-10-09.md
  - docs/AUDIT-PAYOUT-VAULT-PANEL-2026-10-09.md
  - docs/AUDIT-FINAL-SWEEP-3-2026-10-09.md
  - docs/AUDIT-FINAL-SWEEP-4-2026-10-09.md
---

# Audit history

Every review the contracts have been through, in order, each linked to its job and its full record. Each round was pinned to one commit; its findings were fixed or answered in the commit after it, and the next round was pinned to that. Read top to bottom, the table is one chain from the first audit to today.

## How the reviews are run

The audits are jobs on the IdentityMD network, paid in IMD, and each is public on the [IMD explorer](https://explorer.imd.fun). Three kinds appear below:

- **Panel** (`template: audit`): four specialists read the same code at the same commit, one each for arithmetic, permissions, economics and control flow, and a judge merges their findings and re-runs every claim against the tree before it is kept. Most of the history is panels.
- **Adversarial review** (`adversarial-review`): one reviewer over the whole of the contracts, looking for what crosses subsystem lines.
- **Single audit** (`audit-imported-code`): one auditor over a stated scope, used for the first two rounds.

Four reviews were done in-house rather than by the network; they are marked as such.

Each record keeps the reviewer's or judge's summary verbatim, every finding with its reproduction, the raw submission beside it (with its sha256), and, for the later rounds, a resolution table saying how each finding was answered. A proof that came with a finding is kept as a regression test, so a fixed finding stays fixed.

## The chain

Severity counts (C/H/M/L/I) are critical, high, medium, low and info, as the round's judge or auditor kept them. "Answered in" is the commit that fixed, or accepted with a stated reason, every finding of that round.

| # | Date | Review | Kind | Pinned to | C/H/M/L/I | Answered in | Record |
|---|---|---|---|---|---|---|---|
| 1 | 2026-10-03 | The in-house contracts | Single audit, job [`c71449d1`](https://explorer.imd.fun/jobs/c71449d1-899c-4314-9c50-33730fb2dc09) | the pre-launch tree | 0/1/2/4/4 | `332f023`, `0fe0381`, `19829a9` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-2026-10-03.md) |
| 2 | 2026-10-04 | The dollar denomination and work-backing surface | Single audit, job [`da7d5b1c`](https://explorer.imd.fun/jobs/da7d5b1c-b574-4738-b241-8c03aff321cd) | `36f305a` | 0/0/3/2/0 | `1f15c2a` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-2026-10-04.md) |
| 3 | 2026-10-04 | What is proven, what is argued, what stands before mainnet | In-house | the tree that day | a gap list, not a severity count | `00b60b9` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/INTERNAL-AUDIT-2026-10-04.md) |
| 4 | 2026-10-05 | Launch audit: the vault | Panel, job [`414e25cc`](https://explorer.imd.fun/jobs/414e25cc-f7f9-47d1-bc5e-c0dfb8705119) | `e52a025` | 0/0/3/4/9 | `03e8d0c` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-VAULT-2026-10-05.md) |
| 5 | 2026-10-05 | Launch audit: governance | Panel, job [`ae08d373`](https://explorer.imd.fun/jobs/ae08d373-e004-4a5f-99a2-34bb602b4599) | `e52a025` | 0/0/1/3/11 | `03e8d0c` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-GOVERNANCE-2026-10-05.md) |
| 6 | 2026-10-05 | Launch audit: the oracle | Panel, job [`f6faeaf9`](https://explorer.imd.fun/jobs/f6faeaf9-0d86-44af-8a08-6d80d9f15a96) (judge out of budget after one finding; the specialists' others went into the fix plan) | `e52a025` | 0/1/0/0/0 | `03e8d0c` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-ORACLE-2026-10-05.md), [fix plan](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-FIX-PLAN-2026-10-05.md) |
| 7 | 2026-10-05 | Launch audit, phase 2: the fixed tree | Adversarial review, job [`5e2f7703`](https://explorer.imd.fun/jobs/5e2f7703-9fe2-4c2b-bf7d-cbafd53fb4bf) | `03e8d0c` | 0/0/2/3/1 | `9dd2149` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-ADVERSARIAL-2026-10-05.md) |
| 8 | 2026-10-05 | Gas, without weakening any guard | Research report, job [`ca1b7686`](https://explorer.imd.fun/jobs/ca1b7686-352c-44f3-9053-06e1f717e7b3) | `03e8d0c` | proposals, each accepted or refused with its reason | `9dd2149` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-GAS-2026-10-05.md) |
| 9 | 2026-10-06 | Every contract, the deploy path and the oracle payloads | In-house | `a4c22a5` | 0/1/1/5/a few | `ce39fc6` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-INTERNAL-2026-10-06.md) |
| 10 | 2026-10-06 | Final pre-launch review | Adversarial review, job [`d744e818`](https://explorer.imd.fun/jobs/d744e818-03e4-42ad-9cea-192ec55f49d6) (partial: out of turns) | `002605f` | 0/1/2/3/0 | `cc4103f`, reviewed in `8dd0847` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-FINAL-2026-10-07.md) |
| 11 | 2026-10-07 | Final pre-launch review, the half the first did not reach | Adversarial review, job [`cc8d583b`](https://explorer.imd.fun/jobs/cc8d583b-bbe6-4bcf-a0e9-3b45ea4f74af) | `8dd0847` | 0/0/1/4/2 | `b73a05f` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-FINAL-2-2026-10-07.md) |
| 12 | 2026-10-07 | Final panels: the vault | Panel, job [`6a5f4140`](https://explorer.imd.fun/jobs/6a5f4140-95a4-4011-aa75-cbf064127f7f) | `b73a05f` | 0/0/2/3/3 | `8756817` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-FINAL-PANEL-VAULT-2026-10-07.md) |
| 13 | 2026-10-07 | Final panels: governance and the Treasury | Panel, job [`e4a6f30e`](https://explorer.imd.fun/jobs/e4a6f30e-93df-464e-ba53-e341e01d1ee8) | `b73a05f` | 0/0/1/2/5 | `8756817` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-FINAL-PANEL-GOVERNANCE-2026-10-07.md) |
| 14 | 2026-10-07 | Final panels: the price path | Panel, job [`f1346a93`](https://explorer.imd.fun/jobs/f1346a93-e4d4-40da-9e2d-cf536b24e57a) | `b73a05f` | 0/0/1/3/3 | `8756817` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-FINAL-PANEL-ORACLE-2026-10-07.md) |
| 15 | 2026-10-07 | Sweep panels: the vault | Panel, job [`43b96259`](https://explorer.imd.fun/jobs/43b96259-a6e0-4bca-b04f-0308a7943b8b) | `8756817` | 0/1/4/1/3 | `973369e` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-SWEEP-PANEL-VAULT-2026-10-07.md) |
| 16 | 2026-10-07 | Sweep panels: governance and the Treasury | Panel, job [`f6219aa5`](https://explorer.imd.fun/jobs/f6219aa5-8cf9-409f-b099-8244a20639a4) | `8756817` | 0/0/0/2/2 | `973369e` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-SWEEP-PANEL-GOVERNANCE-2026-10-07.md) |
| 17 | 2026-10-07 | Sweep panels: the price path and the deploy checks | Panel, job [`ecd0a279`](https://explorer.imd.fun/jobs/ecd0a279-c5d7-4167-8e75-9fbbc85b41fe) | `8756817` | 0/0/0/4/7 | `973369e` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-SWEEP-PANEL-ORACLE-2026-10-07.md) |
| 18 | 2026-10-08 | Retry panel: the vault's redesigned lag | Panel, job [`3226aaed`](https://explorer.imd.fun/jobs/3226aaed-03da-457d-be15-7e2828021e54) | `973369e` | 0/1/4/2/2 | `24337a2`, `58f73de` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-RETRY-PANEL-VAULT-2026-10-07.md) |
| 19 | 2026-10-08 | Retry panel 2: warmth per position | Panel, job [`a2640621`](https://explorer.imd.fun/jobs/a2640621-925d-479e-b71d-9629899ed4c6) | `24337a2` | 0/0/3/5/2 | `d7fceab` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-RETRY2-PANEL-VAULT-2026-10-08.md) |
| 20 | 2026-10-08 | Final vault panel | Panel, job [`45bf3777`](https://explorer.imd.fun/jobs/45bf3777-cc84-44eb-a7ad-bbb2c0833d07) | `d7fceab` | 0/1/4/5/3 | `6085c8a` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-FINAL-VAULT-PANEL-2026-10-08.md) |
| 21 | 2026-10-08 | Final sweep: the whole system | Panel, job [`08a12413`](https://explorer.imd.fun/jobs/08a12413-5e3b-4baf-9f1c-6d1ba99e9487) | `6085c8a` | 0/0/0/3/2 | `77d8878` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-FINAL-SWEEP-PANEL-2026-10-08.md) |
| 22 | 2026-10-08 | Delta panel: what the final sweep's fixes changed | Panel, job [`fc96f209`](https://explorer.imd.fun/jobs/fc96f209-e004-42c6-bea0-728288548eee) | `07905bb` | 0/0/1/2/4 | `46b646f` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-DELTA-PANEL-2026-10-08.md) |
| 23 | 2026-10-08 | Launch vault panel: the vault in full | Panel, job [`5383ced0`](https://explorer.imd.fun/jobs/5383ced0-fa82-4434-b6bd-62eb0fd2ff2b) | `9bd5f59` | 0/1/2/1/1 | `d3861ac`, by replacing the backing lag with paced figures | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-LAUNCH-VAULT-PANEL-2026-10-08.md) |
| 24 | 2026-10-08 | Paced vault panel: the redesigned vault in full | Panel, job [`dc27aade`](https://explorer.imd.fun/jobs/dc27aade-6adb-40da-b6d8-0bddfe280ebf) | `d3861ac` | 0/0/3/2/6 | `c1ecb05` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-PACED-VAULT-PANEL-2026-10-08.md) |
| 25 | 2026-10-09 | Final sweep 2: the whole system, after the paced figures | Panel, job [`a69e204e`](https://explorer.imd.fun/jobs/a69e204e-d047-4c2f-9944-f37a69dd2796) | `a3aa9e4` | 0/1/0/2/4 | `92b873b` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-FINAL-SWEEP-2-2026-10-09.md) |
| 26 | 2026-10-09 | Payout vault panel: the vault on the sweep's fix (the paced payout price, the clamp, the seed, the price read once, the transient guard) | Panel, job [`f936eafb`](https://explorer.imd.fun/jobs/f936eafb-0bfb-4584-95be-9113b9d451ad) | `c90e8d9` | 0/1/0/3/1 | `73191e0` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-PAYOUT-VAULT-PANEL-2026-10-09.md) |
| 27 | 2026-10-09 | Final sweep 3: the whole system, after the payout price | Panel, job [`ed4f7f6d`](https://explorer.imd.fun/jobs/ed4f7f6d-0b24-4762-91b5-3f1d61657d68) | `e4baedf` | 0/1/0/3/2 | `dba2cb3` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-FINAL-SWEEP-3-2026-10-09.md) |
| 28 | 2026-10-09 | Final sweep 4: the whole protocol, every mechanism, after the premise was corrected | Panel, job [`6229d0fc`](https://explorer.imd.fun/jobs/6229d0fc-c6a5-4c3e-bb56-64461d50b1cb) | `c7d50ee` | 0/0/1/2/4 | `df82607` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-FINAL-SWEEP-4-2026-10-09.md) |
| 29 | 2026-10-10 | The work-root fix: the work oracle keeps no epoch, so a missed day no longer stops it accepting roots | In-house | `549dfdd` | no findings; one comment corrected | `c1381eb` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-INTERNAL-2026-10-10-WORK-ROOT.md) |
| 30 | 2026-10-10 | Intake v2 and the oracle purchases' failure callback | In-house | `79d0b82` | no findings | `79d0b82` | [Record](https://github.com/imdusd/infer-protocol/blob/main/docs/AUDIT-INTERNAL-2026-10-10-INTAKE-V2.md) |

## What the chain shows

- **No critical finding in any round.** The highs were five: three in the vault's backing lag, each fixed in the commit after it, then two in the oracle's reach over redemption payouts, which a pool held down through the feed's window could inflate: round 25 found the route and the price a redemption is paid at was paced; round 26 showed the first rate (5% an hour) only delayed the hold by five hours, and the rate is now 1% an hour, so a profitable hold runs through the better part of a day. Round 27 found a sixth in the same root, liquidation at a held-down price, and it is the one high accepted rather than fixed: slowing liquidations to stop it would leave real crashes to bad debt that every holder bears, so the bound is stated in plain words, the site warns a marked borrower, and the proof is kept as the measure of the bound. Every other high was fixed in the commit after the round that found it, with its proof kept as a regression test.
- **The panels found their bugs in each round's newest code.** That is why the vault has had more rounds than the rest: its backing guard and its lagged capital were repaired through rounds 15 to 23, each repair audited again and each found wanting in the next round, until round 23's high was in the repair made for round 22. The lag was then replaced outright by three paced figures with a one-sentence guarantee (record 23); round 24 audited that and found no high, three mediums (an ordering gap, a wrongly stated condition, and a stale collateral term nobody but its owner could re-price), each fixed or restated in the commit after it.
- **Two items are accepted rather than fixed,** each with its reason in the code and in [Risks and open questions](../economics/risks-and-open-questions.md): a repayment one transaction before a redemption can lift what that redemption is paid, within a stated bound and only below par; and a redraw after a redemption releases a repayment's share of the fee base early. The rounds that tried to close the first did worse than the edge itself, and the records say how.
- **What the reviews do not cover** is in [Risks and open questions](../economics/risks-and-open-questions.md): the oracle service's signer, the fixed questions, and the economic assumptions behind the peg.

The raw record of every network job, and the full text of every finding, are in the repository's `docs/` folder.
