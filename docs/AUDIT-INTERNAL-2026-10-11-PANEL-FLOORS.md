# Internal review: panel floors and the signed answer (2026-10-11)

The first mainnet stage one (block 26165887) was deployed and seeded, then superseded before the vault: only
the SwarmRelay is reused. Reviewed in house by the operator's decision; this note is what changed and what was
checked.

## Why

1. **The floors were the only bar, and they were low.** A request's own panel and quorum are not part of the
   question a feed pins, so anyone may buy an answer to a feed's question from a small panel and relay it through
   the permissionless relay. The feeds' constants were `MIN_PANEL_SIZE` 25 and `MIN_AGREED` 15: about fifteen
   seats could set a price.
2. **The first mainnet NHI answer could not be stored.** Request d0203e1a was attested with the right answer
   (0.98699e18) in `answer` and `figure` = 0; the feed read `figure` and refuses zero. The plane has since been
   fixed to fill `figure` again; the feeds no longer depend on it.
3. **The same NHI panel nearly signed a wrong value.** 15 of 35 members read `/swarm` during a fault
   (`agentsOnline: 0`) and agreed on 0.59; the honest cluster reached the quorum of 20 first.

## The change

| | before | after |
|---|---|---|
| `MIN_PANEL_SIZE` | 25 | 100 (the plane's largest paid panel) |
| agreement floor | `MIN_AGREED` 15 | `minAgreed()`: 51 in the base (a strict majority); **67** on PriceFeed and SpotFeed (deterministic chain reads) |
| value accepted | `figure` | the signed `answer`, exactly one 32-byte word (`InvalidAnswer` otherwise); a nonzero `figure` must equal it (`AnswerMismatch`) |
| bodies | panel 60, quorum 20 | price and spot 100/67, NHI 100/51 |
| NHI question | "If seatsEnrolled is 0, p = 0." | a reading with `agentsOnline` or `seatsEnrolled` at 0 is a fault: re-read up to three times, then report inability |

Why not higher: a floor that honest panels cannot reach refuses updates, the feeds go stale and the vault halts,
and the floor cannot be lowered without a new vault. Tonight's NHI agreement was 57% (20 of 35), so a 67 floor on
NHI would have refused the honest answer; price and spot agreed 100%.

## Checked

| What | Result |
|---|---|
| Suites | forge 664/0, `AUDIT_PROOFS` 665/0, `script/checks` 116/116 |
| New behaviour | `test/PanelFloorsAndAnswer.t.sol` 10/10: figure 0 taken from the answer (the d0203e1a shape); mismatch, malformed and zero answers refused; panel 99 refused; 50 refused / 51 taken on the base; 66 refused / 67 taken on a two-thirds feed; agreed above the panel refused; the shipped leaves carry 100 / 51 / 67 |
| Question binding | `check-bodies.mjs` ok for all three; the prefix generator reproduces d0203e1a's signed questionHash from the previous NHI body (`--verify`: MATCH), so the regenerated NHI prefix is derived the same way |
| Addresses | `plan.py` converged in 3 passes; `DeployMainnet.check()` every constant ok. SwarmRelay unchanged (0x9AEb…e20B); WorkOracleFactory 0x2445…7409, PriceFeed 0x070e…EC97, NhiFeed 0x014D…5D7A, SpotFeed 0x77E1…4951, OracleAsker 0x0085…059E, TreasuryFactory 0xbF64…a6B2 |
| Deploy | stage one skips a contract that already has code, so the existing relay is reused |
| Keeper | its hand-relay pre-check reads `answer` and the feed's `minAgreed()` |
| Rehearsal 3 (anvil fork, `launch.sh go`, keeper on the VPS) | 10/10: gas ceiling refused; "no" at the vault prompt sends nothing; a pushed pool and a bad first answer refused by verifySeeded and by `vault`; the resume skips stage one and deploys the vault on the new addresses; the keeper's silence, empty-buyer, stop-switch and Treasury-paid paths |
