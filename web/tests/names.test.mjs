import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import {
  LEGACY_NAMES,
  LEGACY_ONLY,
  setInterface,
  onChain,
  ours,
  onChainArgs,
} from "../src/names.ts";

// Every row of the table is checked against real ABIs: the protocol's own names against the current
// contracts (docs/abi at HEAD), the legacy names against the Sepolia deployment's ABIs (tests/fixture-deployment/abi;
// public/abi has shipped mainnet's since 5ba2182). A typo here would otherwise surface as a
// "function not found" in a user's transaction.
const names = (dir) => {
  const out = new Set();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    out.add(f.slice(0, -5));
    for (const item of JSON.parse(readFileSync(`${dir}/${f}`)))
      if (item.name) {
        out.add(item.name);
        for (const c of item.inputs ?? []) for (const k of c.components ?? []) out.add(k.name);
      }
  }
  return out;
};
const current = names(new URL("../../docs/abi", import.meta.url).pathname);
const deployed = names(new URL("./fixture-deployment/abi", import.meta.url).pathname);

test("every protocol name in the table exists in the current contracts", () => {
  const missing = Object.keys(LEGACY_NAMES).filter((n) => !current.has(n));
  assert.deepEqual(missing, []);
});
test("every legacy name in the table exists in the deployed ABIs", () => {
  // The one exception: the Sepolia vault predates the redemption payout cap, so it has no
  // backingPerComp. The terminal reads it as an optional view and falls back to par.
  const missing = Object.values(LEGACY_NAMES).filter((n) => !deployed.has(n));
  assert.deepEqual(missing, ["backingPerComp"]);
});
test("translation is the identity on maker and round-trips on legacy", () => {
  setInterface("maker");
  assert.equal(onChain("draw"), "draw");
  setInterface("legacy");
  assert.equal(onChain("draw"), "mintCOMP");
  assert.equal(ours("Liquidated"), "Bite");
  assert.equal(onChain("totalSupply"), "totalSupply");
  assert.deepEqual(onChainArgs([{ line: 1n, duty: 2n }, 3n]), [{ debtCeiling: 1n, stabilityFeeBps: 2n }, 3n]);
  for (const [maker, legacy] of Object.entries(LEGACY_NAMES)) assert.equal(ours(onChain(maker)), maker, legacy);
  assert.throws(() => setInterface("makr"));
  setInterface(undefined);
  assert.equal(onChain("draw"), "draw");
});

// Every contract member the terminal names, under the protocol's names, must exist in the current
// contracts. Found by scanning the source for quoted identifiers that the DEPLOYED (legacy) ABIs
// recognise once translated: those are contract calls. A name the table forgot would pass on
// Sepolia (which spells it the old way) and fail on mainnet; this catches it before either.
test("every contract member the terminal uses exists in the current contracts", () => {
  setInterface("legacy");
  const srcDir = new URL("../src", import.meta.url).pathname;
  const used = new Set();
  for (const f of readdirSync(srcDir).filter((f) => /\.tsx?$/.test(f) && f !== "names.ts"))
    for (const [, q] of readFileSync(`${srcDir}/${f}`, "utf8").matchAll(/"([A-Za-z_][A-Za-z0-9_]{2,})"/g))
      if (deployed.has(onChain(q))) used.add(q);
  const missing = [...used].filter((q) => !current.has(q)).sort();
  setInterface(undefined);
  assert.ok(used.size > 60, `scan found only ${used.size} contract names`);
  // Only members of contracts replaced before mainnet may be missing, and only those on the list.
  assert.deepEqual(missing, [...LEGACY_ONLY].sort());
  assert.deepEqual(LEGACY_ONLY.filter((n) => current.has(n)), []);
});
