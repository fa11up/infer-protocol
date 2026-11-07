#!/usr/bin/env node
/**
 * Check an oracle.request payload against the live feed that will consume it, BEFORE paying.
 *
 *   node preflight-oracle.mjs <payload.json> <feedAddress> [--rpc URL]
 *
 * Every rule here is one the feed enforces on chain, read from the feed itself rather than
 * hardcoded. It exists because a 0.5 IMD request attested perfectly and still could not be relayed:
 * `consumer` was missing, so the signature was under the default domain, and the panel was smaller
 * than the feed's floor. Both were knowable before paying.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const ethers = createRequire(import.meta.url)("ethers");

const [payloadPath, feedAddr, ...rest] = process.argv.slice(2);
if (!payloadPath || !feedAddr) {
  console.error("usage: node preflight-oracle.mjs <payload.json> <feedAddress> [--rpc URL]");
  process.exit(2);
}
// Accept any casing: a mistyped checksum should not crash a safety check.
const feed_ = ethers.utils.getAddress(String(feedAddr).toLowerCase());
const rpc = rest.includes("--rpc") ? rest[rest.indexOf("--rpc") + 1]
                                   : "https://eth-sepolia-testnet.api.pocket.network";

const ABI = [
  "function attestationChainId() view returns (uint256)",
  "function attestationAnswerType() view returns (uint8)",
  "function MIN_PANEL_SIZE() view returns (uint16)",
  "function minAgreed() view returns (uint16)",
  "function maxAge() view returns (uint256)",
  "function maxDeviationBps() view returns (uint256)",
  "function latestValue() view returns (uint256,uint64)",
  "function relayer() view returns (address)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
];
const TYPE_IDS = { bool: 0, address: 1, bytes32: 2, uint256: 3 };
// Used when the feed has no minAgreed() (feeds older than the per-feed floor): the price and spot feeds' two thirds.
const DEFAULT_MIN_AGREED = 67;

const input = JSON.parse(readFileSync(payloadPath, "utf8")).input;
const provider = new ethers.providers.JsonRpcProvider(rpc);
const feed = new ethers.Contract(feed_, ABI, provider);

const problems = [];
const notes = [];

const [chainId, answerType, minPanel, minAgreed, maxAge, devBps, sep] = await Promise.all([
  feed.attestationChainId(), feed.attestationAnswerType(), feed.MIN_PANEL_SIZE(),
  // The floor submitAttestation applies is minAgreed() (67 price/spot, 51 NHI), not the base MIN_AGREED (51).
  feed.minAgreed().catch(() => (notes.push(`the feed has no minAgreed(); assuming ${DEFAULT_MIN_AGREED}`), DEFAULT_MIN_AGREED)),
  feed.maxAge(), feed.maxDeviationBps(), feed.DOMAIN_SEPARATOR(),
]);
const [curVal] = await feed.latestValue();
const net = await provider.getNetwork();

// 1. consumer — the one that cost us a request
const c = input.consumer;
if (!c) {
  problems.push(`consumer is missing. Without it the attestation is signed under the service's default domain (chainId 1, zero address) and this feed cannot verify it. Add: {"chainId": ${net.chainId}, "verifyingContract": "${feedAddr.toLowerCase()}"}`);
} else {
  if (Number(c.chainId) !== net.chainId)
    problems.push(`consumer.chainId is ${c.chainId}; the feed is deployed on ${net.chainId}`);
  if (String(c.verifyingContract || "").toLowerCase() !== feed_.toLowerCase())
    problems.push(`consumer.verifyingContract is ${c.verifyingContract}, not this feed ${feed_}`);
  if (c.verifyingContract && c.verifyingContract !== String(c.verifyingContract).toLowerCase())
    problems.push("consumer.verifyingContract must be lowercase; a checksummed address is rejected by /requests/quote with a bare 400");
  // the domain the feed will rebuild must match what the service will sign
  if (c.chainId && c.verifyingContract) {
    const expected = ethers.utils._TypedDataEncoder.hashDomain({
      name: "IdentityMD Oracle", version: "2",
      chainId: Number(c.chainId), verifyingContract: c.verifyingContract,
    });
    if (expected !== sep) problems.push(`the domain this consumer implies (${expected}) is not the feed's DOMAIN_SEPARATOR (${sep})`);
    else notes.push("consumer domain matches the feed's DOMAIN_SEPARATOR exactly");
  }
}

// 2. panel floors
if (Number(input.panelSize ?? 0) < Number(minPanel))
  problems.push(`panelSize ${input.panelSize} is below the feed's MIN_PANEL_SIZE ${minPanel}`);
if (Number(input.quorum ?? 0) < Number(minAgreed))
  problems.push(`quorum ${input.quorum} is below the feed's minAgreed ${minAgreed} — agreed can never exceed quorum, so this can never satisfy the feed`);

// 3. payload shape the feed pins
if (Number(input.chainId) !== Number(chainId))
  problems.push(`question chainId ${input.chainId} != the feed's attestationChainId ${chainId}`);
const want = Number(answerType);
const got = TYPE_IDS[input.answerType];
if (got === undefined) problems.push(`answerType ${input.answerType} is not one this checker knows`);
else if (got !== want) problems.push(`answerType ${input.answerType} encodes to ${got}; the feed pins ${want}`);

// 4. deviation band against the value already stored
if (!curVal.isZero() && input.guards) {
  const allowed = curVal.mul(devBps).div(10000);
  const lo = curVal.sub(allowed), hi = curVal.add(allowed);
  const gmin = input.guards.min ? ethers.BigNumber.from(input.guards.min) : null;
  const gmax = input.guards.max ? ethers.BigNumber.from(input.guards.max) : null;
  if (gmin && gmin.lt(lo) || gmax && gmax.gt(hi))
    notes.push(`guards [${input.guards.min}, ${input.guards.max}] reach outside the feed's deviation band [${lo}, ${hi}] around its current ${curVal} — an answer in that part of the range would be accepted by the plane and then rejected on chain`);
}
if (Number(input.validForSeconds ?? 0) > Number(maxAge))
  notes.push(`validForSeconds ${input.validForSeconds} exceeds the feed's maxAge ${maxAge}; an attestation can expire as fresh and still be refused as stale`);
if (input.evidence === "panel" && Number(input.toleranceBps ?? 0) === 0)
  notes.push("evidence is panel with toleranceBps 0 — live readings drift between agents, so exact agreement may be unreachable");

console.log(`payload   ${payloadPath}`);
console.log(`feed      ${feed_} on chain ${net.chainId}`);
console.log(`feed pins chainId ${chainId}, answerType ${want}, panel >= ${minPanel}, agreed >= ${minAgreed}\n`);
for (const n of notes) console.log(`  note     ${n}`);
if (!problems.length) { console.log("\nPASS — this payload can be relayed into that feed."); process.exit(0); }
for (const p of problems) console.log(`  BLOCKER  ${p}`);
console.log(`\nFAIL — ${problems.length} problem(s). Fix before paying.`);
process.exit(1);
