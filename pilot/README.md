# Paid-oracle work-minting pilot

A small, capped live test of minting imdUSD for swarm work on the v1 vault. Every oracle request **paid through the
on-chain Intake** pays a **1.5 imdUSD bonus**, split equally among the agents the plane's frozen record credits for
it, pushed to each agent's controller with no action on their part. Contract: `src/PaidOraclePilot.sol`.

| Bound (enforced on chain) | Value |
|---|---|
| Per epoch | 350 imdUSD |
| Lifetime | 3,000 imdUSD |
| Epoch spacing | at least 6 days |
| Veto window | 24 h after posting; the protocol governor (the Safe, read live from Parameters) can strike it, and its window is handed back to be recounted |
| Windows | contiguous (`fromBlock == nextFromBlock()`), ending before the current block |
| Retire | 30 days after posting, the governor can release an epoch's unpaid remainder from the lifetime cap |
| Vault ceiling | `earnLine()` still applies to everything minted from work |

## Why only Intake-paid oracle requests

It is the only paid work that anyone can rebuild from public, frozen inputs:

1. Intake `Requested` (payer, asset IMD, amount) and `Completed` (uri -> oracle request id), on chain.
2. The plane's daily oracle receipt, anchored by `WorkRegistry.latest(jobId(day))` and pinned to IPFS, lists every
   oracle job of the day with its document hash.
3. Each job's frozen document names the agents its acceptance credited (`oracleAcceptance[].agentId`) and the
   request it answered (`attestation.requestId`).

Paid premium jobs and x402-paid oracle requests are out: their payer exists only in the plane's live API.
The live API is used for one thing, finding which job answered a request; the builder then checks the frozen
document says the same.

"Credited" is the plane's frozen acceptance, which is occasionally one or two agents more than the live `agreed`
count (grants survive later re-scoring). The pilot pays what the plane itself credits.

## Building an epoch

```bash
cd pilot && npm install
node build-tally.mjs --pilot <PaidOraclePilot> --to <block before head> --out epoch-<n>
```

- The epoch number and the window's first block are read from the pilot (`epochCount()`, `nextFromBlock()`).
  `--epoch`/`--from` only cross-check; without `--pilot` they make a dry run, labelled `dryRun: true`, never to post.
- Logs are read from two RPCs (mevblocker + Tenderly public by default, `--rpc a,b` to override) and must agree
  chunk by chunk. Every document is re-hashed (RFC 8785 subset) against its anchored hash before use.
- Counted: Intake `Completed` with status 0 (answered) of an `oracle.request@…` paid in IMD, once per oracle
  request. Excluded by definition, and listed in `skipped`: not an oracle request, not paid in IMD, status 1
  (refused) or 2 (ended without a result), a second Intake request naming the same oracle request.
- REFUSED, writing nothing and exiting 2, whenever a request in the window cannot be proven: no `Requested`
  within `LOOKBACK` blocks, an answered request with no oracle uri, the plane naming no job or a status other than
  attested, the job missing from the receipts (a day's receipt not on chain yet), or any acceptance entry in the
  frozen document answering a different request. Wait, or end the window earlier; nothing is lost.
- Output: `tally.json` (root, total, counts, skips), `requests.json` (every input: Intake txs, receipt and document
  hashes, credited agents), `proofs.json`, `tree.json` (OpenZeppelin StandardMerkleTree dump). Publish the
  directory (IPFS) and pass its uri to `propose`.

Dry run 2026-10-15..17 (blocks 26194146-26215746): 103 completed oracle requests, 98 paid + attested, 210 agents,
147.0 imdUSD. 76 of the 98 were paid by our OracleAsker, 22 by outside payers.

## Paying

After the veto window, while the feeds are fresh and agree (`earn` refuses otherwise; right after a price update),
anyone calls `pay(epoch, agentIds, amounts, proofs)` in batches. Shares already paid are skipped; an agent whose
controller cannot be resolved (unbound, not ERC-721) is skipped with `Unpayable` and stays payable.

## Installing (Safe, 96 h)

1. Deploy `new PaidOraclePilot(vault, poster, firstFromBlock)`.
2. `Parameters.proposeWorkOracle(pilot)` -> 48 h -> `applyPending()`.
3. `Parameters.proposeWage(1)` -> 48 h -> `applyPending()`. The wage is only the vault's on switch.

## Who holds what power

- **The Safe (governor)** is the only vetoer and can appoint itself poster, so it alone could direct up to 3,000
  imdUSD, 350 at a time. It can also veto every honest epoch (denial of service, not theft).
- **The poster** alone gets an epoch paid only if the Safe misses its 24 h window; bounded by the caps.
- **The plane's adapter** (`0xde15…D336`, an upgradeable proxy owned by the plane) decides who controls each agent,
  so its upgrader decides every recipient. A malformed answer skips that share, never the batch.

## Ending it

Shares are payable only while this is the vault's work oracle and the wage is nonzero: at wage 0 `earn` refuses,
and after a successor is installed the vault reads the successor's rights. So **pay every posted epoch out before
turning the pilot off.** `setPoster(0)` stops new epochs; `retire` releases an epoch that cannot be paid. Replacing
the oracle needs the wage back at 0 first, and the successor must name this pilot as `predecessor()` (Parameters
enforces both once anything has been minted).

Audit: job 3d5324e9 (`audit/work-pilot-3d5324e9/`), 0 high/medium, 7 low, 3 info, all addressed; each contract
finding has a regression test in the fork suite.

Fork test against the live vault, Parameters and adapter:
`forge test --match-path test/fork/PaidOraclePilot.t.sol --fork-url <mainnet rpc>` (15/15). Gas: 3.96M for a batch of 64
real agents, ~62k per agent, so a ~300-agent epoch is 2-3 batches of ~120 (each under the 16.7M transaction cap).
