# Stability promises for on-chain oracle consumers (attester key, attestation v2, question document v1, receipt v2)

**Labels:** oracle, contracts, discussion

## Summary

An on-chain consumer of the oracle is immutable by construction: the safe way to verify an attestation is
to pin the signer, the typed-data shape and the question in bytecode, and that is exactly what
`OracleAttestation.sol` recommends ("pin its question and compare `questionHash`"). The flip side is that
any in-place change to one of those four things permanently bricks every such consumer. We are about to
put one on Ethereum mainnet holding user collateral, and would like the promises below written down
(in `docs/` or the README for oracle consumers), so consumers can plan rather than guess.

## What an immutable consumer pins, and where it comes from

| pinned | source of truth in the plane | what happens if it changes in place |
|---|---|---|
| attester address `0x5598…2982` | `ORACLE_ATTESTER_ADDRESS` (config, `apps/control-plane/src/config.ts`) | every feed refuses every answer, forever |
| EIP-712 `OracleAttestation`, domain `"IdentityMD Oracle"` version `"2"`, field order | `packages/protocol/src/oracle-eip712.ts`, `packages/contracts/src/OracleAttestation.sol` | signatures stop recovering to the attester |
| canonical question document v1 (`{v, question, chainId, window, answerType, head?, definitions?, evidence?}`, JCS-sorted) | `packages/protocol/src/schemas/oracle.ts` (`questionDocument`) | `questionHash` stops matching the pinned question |
| daily receipt `identitymd-oracle-batch-v2`: jobId derivation, `agentRoot`, `agentLeafEncoding ["uint256","uint32","uint64"]`, `WorkRegistry` at `0xb6d0…a775` | `apps/control-plane/src/work/oracle-batches.ts`, `packages/protocol/src/schemas/oracle-receipt.ts` | a work oracle pinned to that question can no longer be answered |

## The ask

1. **Additive versioning, never in place.** A new attestation version, document version or receipt schema
   is added beside the old one and both are served for an overlap window — exactly what was done when
   attestation version 1 was kept alongside version 2. A consumer opts in by asking for the new version.
2. **Attester key continuity.** If the attester key must rotate, the old key keeps signing (for consumers
   that ask for it) through an announced overlap, with the rotation announced on the dev's on-chain inbox
   and in the repo. A compromised key is the exception, and saying so explicitly is fine.
3. **An overlap window we can plan around** — we would suggest 90 days, but any stated number works.
4. **Where announcements go** (the on-chain inbox is fine), so consumers can watch one place.

## Why it matters beyond us

Every contract that follows `OracleAttestation.sol`'s own advice is in the same position, and a stated
policy is what makes building on the oracle a reasonable bet for the next consumer. It costs a paragraph
of documentation and the discipline the plane already practises.

## Context

imdUSD (imdusd/infer-protocol): three price/health feeds and a work-tally oracle, each a `SwarmFeed`
pinning signer, domain and question, consumed by an immutable vault. Deploy script and audits are public.
