# Resolution of audit 3d5324e9

| # | Sev | Finding | Fix | Regression |
|---|---|---|---|---|
| 1 | low | toBlock unbounded; max value bricks every later propose | `toBlock < block.number` (`WindowInFuture`); `nextFromBlock = toBlock + 1` cannot overflow | `test_windowCannotEndInTheFuture` (fails on old code with Panic 0x11) |
| 2 | low | an unpayable epoch holds its total in `totalCommitted` forever | `retire(epoch)` by the governor, 30 days after posting, releases `total - paid`; retired epochs refuse `pay`. Builder reads the epoch number from the pilot | `test_retireReleasesAnUnpayableEpoch`, `test_retireReleasesOnlyTheUnpaidRemainder` |
| 3 | low | windows not contiguous; a typo leaves a hole of uncountable paid work | `fromBlock == nextFromBlock` (`WindowNotContiguous(expected)`); builder reads `nextFromBlock()` | `test_windowsAreContiguous`, `test_capsGapAndWindowsBindThePoster` |
| 4 | low | two consecutive vetoes lose blocks | a veto sets `nextFromBlock` back to the struck epoch's `fromBlock`; with contiguity that is always the last live epoch's `toBlock + 1` | `test_consecutiveVetoesLoseNoBlocks` |
| 5 | low | `abi.decode` of a malformed binding reverts the batch; adapter upgrader is trusted | binding read as three raw words, range-checked; trust stated in NatSpec + README | `test_malformedBindingSkipsOneShareNotTheBatch` (fails on old code: whole batch reverts) |
| 6 | low | builder ignores Intake `Completed.status` | only status 0 (answered) counts; 1/2 are excluded on chain | dry run 10-15..17: 5 excluded by status, same root as before |
| 7 | low | builder silently skips unprovable paid requests | every uncertain case refuses the run (exit 2): lookback miss, answered with no oracle uri, plane names no job / not attested, job absent, entry mismatch. Definite exclusions only are `skipped` | manual: the refusal paths |
| 8 | info | exit strands unpaid shares; no `predecessor()` | documented (NatSpec, README "Ending it"): pay out before turning off; `retire` for the unpayable | — |
| 9 | info | trust assumptions | documented (NatSpec, README "Who holds what power") | — |
| 10 | info | builder checks only the first acceptance entry; no dedupe by oracle request | every entry must answer the request (else refuse); one bonus per oracle request | — |

Also: builder `--pilot` mode tested on a local mainnet fork with a deployed pilot (same root `0xebaa…d824`, a wrong
`--epoch` refused); `--to` at or after the head is refused.
Suites: fork 15/15, offline 780/0.
