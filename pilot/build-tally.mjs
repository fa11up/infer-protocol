#!/usr/bin/env node
// Rebuild one PaidOraclePilot epoch from public inputs only:
//   chain:  Intake `Requested` (payer, asset, amount) + `Completed` (status, uri -> oracle request id)
//   plane:  the daily oracle receipt anchored by WorkRegistry.latest(jobId(day)), and each job's frozen
//           document listed in it (IPFS-pinned; fetched from api.imd.fun/work-records, hash-checked here)
// Every document is checked against its on-chain or receipt hash before it is used. The plane's live API
// is used ONLY to find which job answered a request; the answer itself is read from the frozen document.
//
//   node build-tally.mjs --epoch 0 --from <block> --to <block> [--rpc <url>] [--out <dir>]
//
// Exits non-zero, posting nothing, if any request in the window cannot be proven (e.g. its day's receipt
// is not on chain yet): the window then waits, and no paid work is lost.
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http, parseAbiItem, keccak256, toBytes, hexToString, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

const BONUS_PER_REQUEST = 1_500_000_000_000_000_000n; // 1.5 imdUSD, mirrors PaidOraclePilot.BONUS_PER_REQUEST
const EPOCH_CAP = 350_000_000_000_000_000_000n;
const INTAKES = ["0xa43e6F75ee006411F79Ac1C84120606C2330DE82", "0x1397434cd35e8a9c8ac312a61d3a285eb31dea56"];
const IMD = "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";
// The Intake writes the action as a bytes32 string, "<action>@<body version>", e.g. "oracle.request@oracle-1".
const actionOf = (b32) => hexToString(b32, { size: 32 }).replace(/\0+$/, "");
const REGISTRY = "0xb6d0a187b050fa5bb0b87033a203f37becf4a775";
const RECORDS = "https://api.imd.fun/work-records/";
const API = "https://api.imd.fun";
const LOOKBACK = BigInt(process.env.LOOKBACK ?? 100_000); // ~2 weeks; a request it misses REFUSES the run
// Intake v2 Completed status: 0 answered, 1 refused, 2 ended without a result (fees are not refunded on 1/2).
const ANSWERED = 0;
const REVISION_DAYS = Number(process.env.REVISION_DAYS ?? 3);
const CHUNK = BigInt(process.env.CHUNK ?? 5_000);

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []),
);
if (args.to === undefined) throw new Error("--to is required");
// Logs come from TWO providers and must agree chunk by chunk: some public RPCs answer an old range with an
// empty list instead of an error, which would silently drop paid work.
const RPCS = (args.rpc ?? "https://rpc.mevblocker.io,https://gateway.tenderly.co/public/mainnet").split(",");
const clients = RPCS.map((url) => createPublicClient({ chain: mainnet, transport: http(url, { retryCount: 2 }) }));
const client = clients[0];

// The epoch number and the window's first block come FROM THE PILOT (audit 3d5324e9: a mistyped --epoch made
// a root no share could be paid against, and a mistyped --from left a hole of paid work no epoch could count).
// --epoch/--from are accepted only to cross-check, or without --pilot for a labelled dry run before deployment.
const pilotAbi = parseAbi(["function epochCount() view returns (uint256)", "function nextFromBlock() view returns (uint64)"]);
let epoch, fromBlock, dryRun = false;
if (args.pilot) {
  epoch = await client.readContract({ address: args.pilot, abi: pilotAbi, functionName: "epochCount" });
  fromBlock = BigInt(await client.readContract({ address: args.pilot, abi: pilotAbi, functionName: "nextFromBlock" }));
  if (args.epoch !== undefined && BigInt(args.epoch) !== epoch) throw new Error(`--epoch ${args.epoch} but the pilot is at ${epoch}`);
  if (args.from !== undefined && BigInt(args.from) !== fromBlock) throw new Error(`--from ${args.from} but the pilot expects ${fromBlock}`);
} else {
  if (args.epoch === undefined || args.from === undefined) throw new Error("--pilot <address>, or --epoch and --from for a dry run");
  epoch = BigInt(args.epoch);
  fromBlock = BigInt(args.from);
  dryRun = true;
  console.error("DRY RUN: epoch and window start not read from a pilot; do not post this root.");
}
const toBlock = BigInt(args.to);
const head = await client.getBlockNumber();
if (toBlock >= head) throw new Error(`--to ${toBlock} must be before the current block ${head}`);
if (toBlock < fromBlock) throw new Error(`--to ${toBlock} is before the window start ${fromBlock}`);
const out = args.out ?? `epoch-${epoch}`;

const REQUESTED = parseAbiItem(
  "event Requested(bytes32 indexed requestId, address indexed payer, bytes32 indexed action, bytes body, address callbackTarget, bytes4 callbackSelector, address asset, uint256 amount)",
);
const COMPLETED = parseAbiItem(
  "event Completed(bytes32 indexed requestId, uint8 status, bytes32 resultHash, string uri, bool delivered)",
);
const registryAbi = parseAbi(["function latest(bytes16 jobId) view returns (bytes32)"]);

// ---------------------------------------------------------------- helpers

async function logs(address, event, from, to, args) {
  const all = [];
  for (let a = from; a <= to; a += CHUNK) {
    const b = a + CHUNK - 1n < to ? a + CHUNK - 1n : to;
    for (let tries = 0; ; tries++) {
      try {
        const got = await Promise.all(clients.map((c) => c.getLogs({ address, event, fromBlock: a, toBlock: b, args, strict: false })));
        const keys = got.map((g) => g.map((l) => `${l.transactionHash}:${l.logIndex}`).join(","));
        if (keys.some((k) => k !== keys[0])) throw new Error(`providers disagree on ${address} ${a}-${b}`);
        all.push(...got[0]);
        break;
      } catch (e) {
        if (tries > 5) throw e;
        await new Promise((r) => setTimeout(r, 2000 * (tries + 1)));
      }
    }
  }
  return all;
}

async function getJson(url) {
  for (let tries = 0; ; tries++) {
    const r = await fetch(url, { headers: { "user-agent": "paid-oracle-pilot" } }).catch(() => null);
    if (r?.ok) return r.json();
    if (r && r.status === 404) return null;
    if (tries > 5) throw new Error(`${url}: ${r?.status ?? "network"}`);
    await new Promise((res) => setTimeout(res, 2000 * (tries + 1)));
  }
}

// RFC 8785 subset, as the plane canonicalizes: sorted keys, no whitespace, JSON's own number/string forms.
function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}

const docCache = new Map();
async function frozenDoc(hash) {
  const h = hash.replace(/^0x/, "").toLowerCase();
  if (docCache.has(h)) return docCache.get(h);
  const doc = await getJson(RECORDS + h + ".json");
  if (!doc) throw new Error(`work record ${h} not found`);
  const got = keccak256(toBytes(canonical(doc))).slice(2);
  if (got !== h) throw new Error(`work record ${h} does not hash to itself (got ${got})`);
  docCache.set(h, doc);
  return doc;
}

function dayJobId(day) {
  const hex = keccak256(toBytes(`identitymd-oracle-batch:${day}`)).slice(2, 34).split("");
  hex[12] = "8";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return "0x" + hex.join("");
}

const receiptCache = new Map();
async function receipt(day) {
  if (receiptCache.has(day)) return receiptCache.get(day);
  const hash = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: "latest", args: [dayJobId(day)] });
  const r = /^0x0+$/.test(hash) ? null : { hash, doc: await frozenDoc(hash) };
  if (r && r.doc.schema !== "identitymd-oracle-batch-v2") throw new Error(`${day}: unexpected schema ${r.doc.schema}`);
  receiptCache.set(day, r);
  return r;
}

const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
const uuidToBytes32 = (u) => ("0x" + u.replace(/-/g, "")).padEnd(66, "0");

// ---------------------------------------------------------------- 1. paid, completed requests in the window

const requests = [];
const unproven = [];
for (const intake of INTAKES) {
  const completed = await logs(intake, COMPLETED, fromBlock, toBlock);
  if (!completed.length) continue;
  const ids = [...new Set(completed.map((l) => l.args.requestId))];
  const requested = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    for (const l of await logs(intake, REQUESTED, fromBlock > LOOKBACK ? fromBlock - LOOKBACK : 0n, toBlock, {
      requestId: ids.slice(i, i + 50),
    }))
      requested.set(l.args.requestId, l);
  }
  for (const c of completed) {
    const r = requested.get(c.args.requestId);
    const oracleId = c.args.uri?.match(/\/oracle\/requests\/([0-9a-f-]{36})/)?.[1];
    const base = { intake, intakeRequestId: c.args.requestId, oracleId, completedTx: c.transactionHash, status: c.args.status };
    // A skip is a DEFINITE exclusion (not paid oracle work, or not answered). Anything uncertain refuses the run.
    const skip = (why) => requests.push({ ...base, skipped: why });
    const refuse = (why) => unproven.push({ ...base, why });
    if (!r) { refuse(`no Requested event within ${LOOKBACK} blocks (raise LOOKBACK)`); continue; }
    if (!actionOf(r.args.action).startsWith("oracle.request@")) continue; // not an oracle request: out of the pilot
    if (r.args.asset.toLowerCase() !== IMD || r.args.amount === 0n) { skip("not paid in IMD"); continue; }
    if (c.args.status !== ANSWERED) { skip(`intake status ${c.args.status} (refused or ended without a result)`); continue; }
    if (!oracleId) { refuse("answered, but the uri names no oracle request"); continue; }
    requests.push({
      intake, intakeRequestId: c.args.requestId, oracleId, payer: r.args.payer, amount: r.args.amount.toString(),
      requestedTx: r.transactionHash, completedTx: c.transactionHash, completedBlock: c.blockNumber.toString(),
      status: c.args.status, delivered: c.args.delivered,
    });
  }
}

{
  const why = {};
  for (const q of requests) why[q.skipped ?? "candidate"] = (why[q.skipped ?? "candidate"] ?? 0) + 1;
  console.error("stage 1:", JSON.stringify(why));
}

// ---------------------------------------------------------------- 2. credited agents, from frozen documents

const seen = new Set();
for (const q of requests) {
  if (q.skipped) continue;
  // One bonus per oracle request, however many Intake requests name it.
  if (seen.has(q.oracleId)) { q.skipped = "duplicate: another Intake request names the same oracle request"; continue; }
  seen.add(q.oracleId);
  const refuse = (why) => { unproven.push({ oracleId: q.oracleId, intakeRequestId: q.intakeRequestId, jobId: q.jobId, why }); q.unproven = true; };
  const live = await getJson(`${API}/oracle/requests/${q.oracleId}`); // lookup only: which job answered
  if (!live?.jobId) { refuse("the plane names no job for it (yet)"); continue; }
  if (live.status !== "attested") { refuse(`answered on chain but the plane reads ${live.status}`); continue; }
  q.jobId = live.jobId;
  const day = (live.attestedAt ?? live.createdAt).slice(0, 10);
  // A job can appear again in a later day's receipt when the plane revises its credit (split panels have been
  // credited late since plane PR #630). Take the LATEST frozen version within REVISION_DAYS of the answer.
  let found = null;
  for (let k = -1; k <= REVISION_DAYS; k++) {
    const d = addDays(day, k);
    const rc = await receipt(d);
    const leaf = rc?.doc.leaves.find((l) => l.jobId === live.jobId);
    if (leaf) found = { day: d, receiptHash: rc.hash, documentHash: leaf.documentHash };
  }
  if (!found) { refuse(`job not in the receipts around ${day} (receipt missing?)`); continue; }
  const doc = await frozenDoc(found.documentHash);
  const entries = doc.oracleAcceptance ?? [];
  // EVERY credited entry must answer this request, not just the first (audit 3d5324e9, info).
  const want = uuidToBytes32(q.oracleId);
  if (!entries.length || entries.some((a) => a.document?.oracle?.attestation?.requestId?.toLowerCase() !== want)) {
    refuse("the frozen document's acceptance entries do not all answer this request");
    continue;
  }
  q.receiptDay = found.day;
  q.receiptHash = found.receiptHash;
  q.documentHash = found.documentHash;
  q.agents = [...new Set(doc.oracleAcceptance.map((a) => String(a.agentId)))].sort((a, b) => Number(a) - Number(b));
}

{
  const why = {};
  for (const q of requests) why[q.skipped ?? (q.agents ? "credited" : "?")] = (why[q.skipped ?? (q.agents ? "credited" : "?")] ?? 0) + 1;
  console.error("stage 2:", JSON.stringify(why), "unproven", unproven.length);
}
if (unproven.length) {
  console.error(`${unproven.length} paid request(s) in the window cannot be proven:`);
  for (const u of unproven.slice(0, 20)) console.error("  ", u.oracleId ?? u.intakeRequestId, u.why);
  console.error("Nothing written. Post when those receipts are on chain, or end the window earlier.");
  process.exit(2);
}

// ---------------------------------------------------------------- 3. shares and the tree

const paid = requests.filter((q) => !q.skipped && !q.unproven && q.agents?.length);
const shares = new Map();
for (const q of paid) {
  const each = BONUS_PER_REQUEST / BigInt(q.agents.length);
  for (const a of q.agents) shares.set(a, (shares.get(a) ?? 0n) + each);
}
let total = [...shares.values()].reduce((a, b) => a + b, 0n);
let scaled = false;
if (total > EPOCH_CAP) {
  scaled = true;
  for (const [a, v] of shares) shares.set(a, (v * EPOCH_CAP) / total);
  total = [...shares.values()].reduce((a, b) => a + b, 0n);
}
if (total === 0n) { console.error("No paid oracle work in the window."); process.exit(3); }

const values = [...shares.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([a, v]) => [epoch.toString(), a, v.toString()]);
const tree = StandardMerkleTree.of(values, ["uint256", "uint256", "uint256"]);

fs.mkdirSync(out, { recursive: true });
const proofs = {};
for (const [i, v] of tree.entries()) proofs[v[1]] = { amount: v[2], proof: tree.getProof(i) };
const summary = {
  dryRun, pilot: args.pilot ?? null,
  epoch: epoch.toString(), fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), root: tree.root,
  total: total.toString(), scaledToCap: scaled, bonusPerRequest: BONUS_PER_REQUEST.toString(),
  paidRequests: paid.length, agents: shares.size,
  skipped: requests.filter((q) => q.skipped).map(({ oracleId, intakeRequestId, skipped }) => ({ oracleId, intakeRequestId, skipped })),
  script: "pilot/build-tally.mjs",
};
fs.writeFileSync(path.join(out, "tally.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(out, "requests.json"), JSON.stringify(paid, null, 2));
fs.writeFileSync(path.join(out, "proofs.json"), JSON.stringify(proofs, null, 2));
fs.writeFileSync(path.join(out, "tree.json"), JSON.stringify(tree.dump()));
console.log(JSON.stringify({ ...summary, skipped: summary.skipped.length }, null, 2));
