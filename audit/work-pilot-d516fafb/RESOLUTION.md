# Audit d516fafb (round 2): resolution

| # | Sev | Finding | Fix | Check |
|---|---|---|---|---|
| 1 | medium | Late revisions read at build time: an unanchored day looked like "no revision", so the root depended on when it was built | Builder: a request is credited only once EVERY day from answer-1 to answer+`--revision-days` has its receipt anchored; an unanchored day refuses (exit 2). A frozen record that cannot be read refuses instead of throwing. README: build a window only once its last answer is revision-days+1 days old | Dry run 26194146-26215746 reproduces the auditors' root 0xebaa5549...d824; a 10-28 window refuses "the receipt for 2026-10-29 is not anchored yet" |
| 2 | low | REVISION_DAYS / LOOKBACK not recorded | Both are flags (no env), written to `tally.json.inputs` with toBlock's hash, the finalized height, the read block, every receipt hash read, the exclude file and the prior epochs | tally.json of the dry run |
| 3 | low | A request that can never be proven blocks every later epoch | `--exclude <file>` (intakeRequestId + reason, listed in `skipped` for the governor); uri lower-cased; a non-matching uri is decoded from its committed result document (below). README sentence corrected | Bad exclude entry refused; an exclude naming no completed request refuses |
| 4 | low | Window could end at an unfinalized block | `--to` must be at or below every RPC's finalized block; toBlock's hash recorded (both RPCs must agree) | `--to head-2` refused "not finalized yet" |
| 5 | low | `--pilot` read epochCount/nextFromBlock from one RPC | Read from every RPC at one block (`agreed()`, with retries) and must agree; refused while the latest epoch is under 6 days old | - (needs a deployed pilot) |
| 6 | low | retire() never handed the window back | Contract: `retire` hands the window back when nothing of the epoch was paid and it is the latest epoch | `test_retireOfUnpaidLatestEpochHandsBackItsWindow` (fails on 953d7c7: 101 != 1), `test_retireKeepsTheWindowOncePaidOrFollowed` |
| 7 | info | retire() can strand a batch mid-payout | Contract: `retire` reverts `PaidRecently` within VETO_WINDOW of a paid batch (`Epoch.lastPaidAt`); the power is stated in the NatSpec | `test_retireWaitsAfterABatchIsPaid` (fails on 953d7c7) |
| 8 | info | Finding-4 regression did not exercise the variant; RESOLUTION claim unchecked | Test now proposes the later-start recount [250,300] and expects `WindowNotContiguous(201)`; the future-window test now proves the NEXT propose still works. Every new contract test was run against 953d7c7 and fails there for the right reason. No offline/fixture builder test yet: the builder is checked by the live dry runs above | Fork 19/19 |
| 9 | info | firstFromBlock unbounded | Contract: constructor reverts `InvalidFirstBlock` above `block.number`; `propose` @param text aligned | `test_firstFromBlockMustNotBeInTheFuture` (fails on 953d7c7) |
| 10 | info | "not an oracle request" dropped without a record | Now `skip("not an oracle request")`, listed in `skipped`. (The lookback refusal still comes first: without the `Requested` event the action is unknown) | Dry runs list 16 / 20 such skips |
| 11 | info | One bonus per oracle request enforced per run only | `--prior` (required in pilot mode for every earlier non-vetoed epoch; each tally root checked against the chain) seeds the dedupe; such requests skip as "an earlier epoch paid this oracle request" | `--prior` of the same window: all 22 skipped, nothing paid |

FOUND WHILE FIXING (not in the audit): since 2026-10 the plane completes answered requests with
`ipfs://<cid>/result.json` instead of `/oracle/requests/<uuid>`, so the round-two builder would have refused every
window from then on. The builder now fetches that document from any gateway, checks keccak256(bytes) against the
Completed event's resultHash, and reads the oracle request from `message.requestId` (the signed attestation).
Checked: window 26250000-26265000 credits 22 requests, 14 from IPFS results and 8 from old uris.

Tests: fork 19/19 (Tenderly), offline 780/0.
