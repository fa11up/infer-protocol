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
const LOOKBACK = 50_000n; // a request is completed well within a week of being made
const CHUNK = BigInt(process.env.CHUNK ?? 5_000);

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []),
);
for (const k of ["epoch", "from", "to"]) if (args[k] === undefined) throw new Error(`--${k} is required`);
const epoch = BigInt(args.epoch), fromBlock = BigInt(args.from), toBlock = BigInt(args.to);
const out = args.out ?? `epoch-${epoch}`;
// Logs come from TWO providers and must agree chunk by chunk: some public RPCs answer an old range with an
// empty list instead of an error, which would silently drop paid work.
const RPCS = (args.rpc ?? "https://rpc.mevblocker.io,https://gateway.tenderly.co/public/mainnet").split(",");
const clients = RPCS.map((url) => createPublicClient({ chain: mainnet, transport: http(url, { retryCount: 2 }) }));
const client = clients[0];

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
    const skip = (why) => requests.push({ intake, intakeRequestId: c.args.requestId, oracleId, completedTx: c.transactionHash, skipped: why });
    if (!r) { skip("no Requested event in lookback"); continue; }
    if (!actionOf(r.args.action).startsWith("oracle.request@")) continue; // not an oracle request: out of the pilot
    if (!oracleId) { skip("uri names no oracle request"); continue; }
    if (r.args.asset.toLowerCase() !== IMD || r.args.amount === 0n) { skip("not paid in IMD"); continue; }
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

const unproven = [];
for (const q of requests) {
  if (q.skipped) continue;
  const live = await getJson(`${API}/oracle/requests/${q.oracleId}`); // lookup only: which job answered
  if (!live?.jobId) { q.skipped = "plane names no job"; continue; }
  if (live.status !== "attested") { q.skipped = `not attested (${live.status})`; continue; }
  q.jobId = live.jobId;
  const day = (live.attestedAt ?? live.createdAt).slice(0, 10);
  let found = null;
  for (const d of [day, addDays(day, 1), addDays(day, -1), addDays(day, 2)]) {
    const rc = await receipt(d);
    const leaf = rc?.doc.leaves.find((l) => l.jobId === live.jobId);
    if (leaf) { found = { day: d, receiptHash: rc.hash, documentHash: leaf.documentHash }; break; }
  }
  if (!found) { unproven.push({ oracleId: q.oracleId, jobId: q.jobId, day }); continue; }
  const doc = await frozenDoc(found.documentHash);
  const att = (doc.oracleAcceptance ?? [])[0]?.document?.oracle?.attestation;
  if (!att || att.requestId.toLowerCase() !== uuidToBytes32(q.oracleId)) {
    q.skipped = "frozen document answers a different request";
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
  console.error(`${unproven.length} paid request(s) cannot be proven yet (receipt missing or job absent):`);
  for (const u of unproven.slice(0, 20)) console.error("  ", u.day, u.oracleId, u.jobId);
  console.error("Nothing written. Post when those receipts are on chain, or end the window earlier.");
  process.exit(2);
}

// ---------------------------------------------------------------- 3. shares and the tree

const paid = requests.filter((q) => !q.skipped && q.agents?.length);
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
