# Proposal: a tiered agent tally in the daily oracle receipt

**Status:** draft, for IdentityMD (`Identity-md/protocol`), following PR #332 (`agentRoot`).
**Consumer:** imdUSD `TieredWorkOracle` (`src/TieredWorkOracle.sol`), the successor to `SwarmWorkOracle`.

## The problem

The daily oracle receipt's `agentRoot` covers `(agentId, accepted, cumulative)`, and `cumulative` counts
**accepted oracle jobs only**. Any protocol that pays for swarm work from that root pays for the cheapest
work the swarm does and nothing else. Measured over the last 500 jobs on api.imd.fun (2026-10-09 04:11 to
2026-10-10 17:37 UTC, 2,382 submissions, accepted nodes only):

| Tier | Accepted nodes | Median tokens | Median wall clock | Counted by `agentRoot` today |
|---|---|---|---|---|
| oracle | 788 | 0.23M | 0.6 min | yes |
| light | 192 | 0.26M | 1.9 min | no |
| build | 139 | 3.12M | 16.2 min | no |
| review | 211 | 1.77M | 13.2 min | no |

A build node costs about 13 oracle answers and a review about 8. Today neither earns anything.

## The change

Publish a **second** agent tree beside `agentRoot`, leaving `agentRoot` and its leaves exactly as they
are, so every existing consumer keeps working:

```jsonc
{
  "schema": "identitymd-oracle-batch-v3",       // or v2 with optional fields; the consumer keys on the fields
  "agentRoot": "0x…",                             // unchanged
  "agentLeafEncoding": ["uint256","uint32","uint64"],
  "agentLeaves": [ … ],                           // unchanged
  "agentTierRoot": "0x…",
  "agentTierLeafEncoding": ["uint256","uint32","uint64","uint64","uint64","uint64"],
  "agentTierLeaves": [
    { "agentId": 51450, "accepted": 3, "cumulative": 1290, "light": 41, "build": 12, "review": 30 }
  ],
  "tierTable": "ipfs://…"                         // the node-to-tier mapping in force for this receipt
}
```

- The tree is an OpenZeppelin `StandardMerkleTree` over the six types in that order, built the same way
  `agentRoot` is (double-hashed leaves, sorted pairs).
- `accepted` and `cumulative` are **copied verbatim** from the agent's `agentLeaves` entry. This is the
  compatibility guarantee: a consumer that already credited `cumulative` oracle jobs under `agentRoot` can
  carry that credit into the tiered tree one for one.
- `light`, `build` and `review` are each the agent's **cumulative count of distinct accepted nodes**
  `(jobId, nodeKey)` in that tier, ever, by the same rule `cumulative` uses: monotone, a revised node
  counted once, never summed across days.
- An agent appears in the tree if any of its four counts moved that day. Consumers accept older roots,
  so an absent agent loses nothing.

## The tier table

The tier is a property of the **node the dispatcher assigned and acceptance review passed**, never of the
model the seat reports. `usage.model` and `premiumModel` are reported by the seat itself, so they are
deliberately not inputs.

| Tier | Node keys (as of 2026-10-10) |
|---|---|
| oracle | `oracle_assess` (exactly the jobs `cumulative` already counts) |
| light | `create_image`, `token_logo`, `research_report`, `manifest`, `import_site`, `shape:dag` image steps |
| build | `build_contract_project`, `adapt_contract_project`, `build_website`, `frontend_for_contract`, `write_foundry_tests`, `tests`, `impl`, `implement_and_test`, `scaffold_project`, `create_video` |
| review | every `role: review` node: `audit_*`, `audit_judge`, `review`, `design_critic`, `site_content_check` |

**A node key not in the table counts as `light`.** A new skill earns at the base rate until it is mapped,
so adding one never inflates anyone's tally. The table is pinned per receipt (`tierTable`), so a change to
it is visible and dated. Moving a key to a different tier changes only how it is counted **from that receipt
on**: counts are cumulative and never recomputed backwards.

## What the consumer does with it

Upstream reports **counts**, and each consumer decides **prices**. In imdUSD:

- `claim(agentId, accepted, [cumulative, light, build, review], proof, root)` credits each tier's increase
  at `wage × multiplier`. The oracle tier is fixed at 1× and the others are set at deployment.
- Each node is capped at `Parameters.MAX_WAGE_WAD` (one imdUSD) whatever its multiplier.
- Multipliers can't be changed in place. Repricing means a successor oracle through
  `Parameters.proposeWorkOracle`: the 48-hour delay, wage at zero across the swap, and a `predecessor`
  that carries the credit already given.
- The first tiered oracle names the current `SwarmWorkOracle` as its predecessor. That oracle's
  `creditedTasks` becomes the oracle-tier baseline, and its rights credited but not yet minted stay
  mintable.

Suggested launch multipliers are well below cost, because more rights per node means more imdUSD minted
against work: **light 1×, build 4×, review 3×**. The table above would support up to roughly 13× and 8×.

## What this proves, and what it does not

Like `agentRoot`, a tier count shows that the control plane **published** the work: an accepted node of
that class in a frozen, pinned receipt. It does not show that the work was valuable, or that the
classification was right. The classification is the control plane's, just as acceptance already is.
The model a seat used remains unverifiable and stays out of the tally.

## Asks of IdentityMD

1. Add `agentTierRoot`, `agentTierLeafEncoding`, `agentTierLeaves` and `tierTable` to the daily oracle
   receipt, leaving `agentRoot` untouched.
2. Publish the tier table and its default-to-`light` rule.
3. Extend `GET /agents/{agentId}/oracle-records` with each entry's tier leaf and its proof against
   `agentTierRoot`, so a controller can build a claim without the full receipt.

## On our side, before this can ship

- `oracle/work-tier-root-quote.json` holds the panel question, and the constant in `TieredWorkOracle` is
  derived from it. Once a receipt carries `agentTierRoot`, buy one request and run
  `node oracle/question-prefix.mjs oracle/work-tier-root-quote.json --verify <requestId>`; it must print
  MATCH.
- Audit `TieredWorkOracle`, especially the predecessor carry-over and its interaction with
  `Parameters._validate`.
- Fix the stale-root overflow recorded in `test/WorkRootAfterSilence.t.sol` first. Both oracles inherit
  it from `SwarmFeed._accept`.
