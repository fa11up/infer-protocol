// Fails when a stock-token or SGOV surface can render without the geofence (planned tokenized-stock collateral).
// Any source file that names a stock type, the stock auction or the stock-type readers must import src/stock-gate.ts
// and render through StockGate / useStockGate. Run by `npm test` (tests/geofence.test.mjs) and the launch build.
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const EXEMPT = new Set(["geofence.ts", "stock-gate.ts"]);
export const STOCK_SURFACE = /\bStockJoin\b|["'`]STOCK-|\bSGOV\b|\bisStockIlk\b|\breadStockIlks\b|\bstockSendRefusal\b/;
const GATE_IMPORT = /from\s+["'][^"']*stock-gate(\.ts)?["']/;
const GATE_USE = /\bStockGate\b|\buseStockGate\b/;

/** The problem with one file's source, or null. */
export function gateProblem(name, text) {
  if (EXEMPT.has(name.split("/").pop()) || !STOCK_SURFACE.test(text)) return null;
  if (!GATE_IMPORT.test(text)) return `${name} renders a stock surface but does not import stock-gate`;
  if (!GATE_USE.test(text)) return `${name} imports stock-gate but never renders through StockGate / useStockGate`;
  return null;
}

async function walk(d, out = []) {
  for (const n of await readdir(d)) {
    const p = `${d}/${n}`;
    if ((await stat(p)).isDirectory()) await walk(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(n)) out.push(p);
  }
  return out;
}

export async function checkGeofence(dir = SRC) {
  const problems = [];
  for (const f of await walk(dir)) {
    const p = gateProblem(relative(dir, f), await readFile(f, "utf8"));
    if (p) problems.push(p);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await checkGeofence();
  for (const p of problems) console.error(`geofence-check: ${p}`);
  if (problems.length) process.exit(1);
  console.log("geofence-check: every stock surface renders through the gate");
}
