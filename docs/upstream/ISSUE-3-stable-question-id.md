# A window-free question identifier for recurring consumers (discussion)

**Labels:** oracle, discussion

`OracleAttestation.sol` tells a consumer to pin its question and compare `questionHash`. But the hashed
document includes the resolved block window, so a consumer that asks the SAME question every hour has no
stable hash to pin. Our feeds work around it by pinning a ~1.9 KB canonical-JSON prefix in bytecode and
splicing the signed `fromBlock`/`toBlock` back in to recompute the hash on chain — correct, but not
something every consumer should have to write.

The window looks redundant in the hash (`fromBlock`/`toBlock` are already separate signed fields), and
nothing in the plane keys on `questionHash` (non-unique, non-indexed; the dedup key is `submissionKey`,
the request identity `requestHash`). Two shapes would fix it:

1. a new signed field `topicHash` = keccak of the document WITHOUT the window (additive: a v3 struct);
2. changing `questionHash` itself to exclude the window (breaking).

(1) is the only one compatible with existing consumers, and it fits the additive versioning asked for in
the stability issue. Not urgent for us — our workaround works and is deployed-ready — but it is the
difference between "pin a hash" and "reimplement JCS in Solidity" for the next consumer. Full analysis:
imdusd/infer-protocol `docs/UPSTREAM-STABLE-QUESTION-ID.md`.
