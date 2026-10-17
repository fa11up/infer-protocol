// Fails the public build if the export would serve or link to the terminal. imdusd.com serves the
// homepage and docs only; a link to a page that is not served is a broken site.
//
// `--launch` checks the launch build (npm run build:launch) instead: the terminal IS served, against a
// mainnet deployment, and the page may connect to exactly the hosts the terminal reads from and no others.
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const dir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../dist-public",
);
const files = [];
async function walk(d, prefix = "") {
  for (const n of await readdir(d)) {
    const s = await stat(`${d}/${n}`);
    if (s.isDirectory()) await walk(`${d}/${n}`, `${prefix}${n}/`);
    else files.push(`${prefix}${n}`);
  }
}
await walk(dir);
const LAUNCH = process.argv.includes("--launch");
const fail = (m) => {
  console.error(`public-check: ${m}`);
  process.exit(1);
};
for (const need of [
  ...(LAUNCH ? ["terminal/index.html", "analytics/index.html", "imd-deployment.json"] : ["_redirects"]),
  "index.html",
  "docs/index.html",
  "docs/overview/what-is-imdusd/index.html",
  "404.html",
  "_headers",
  "manifest.webmanifest",
  "robots.txt",
  "sitemap.xml",
  "llms.txt",
  "llms-full.txt",
])
  if (!files.includes(need)) fail(`missing ${need}`);
// The not-found page is served at any unknown path, so every URL in it must be absolute.
if (/["'(]\.{1,2}\//.test(await readFile(`${dir}/404.html`, "utf8")))
  fail("404.html has a relative URL");
// The security headers the Worker's assets serve: a Content-Security-Policy with a hash for the one
// inline script (the theme bootstrap), and nothing that lets the page talk to a chain: the one connection
// allowed is Cloudflare Web Analytics' report, and the one script origin its beacon.
const headers = await readFile(`${dir}/_headers`, "utf8");
if (!/Content-Security-Policy: .*'sha256-[A-Za-z0-9+/=]+'/.test(headers))
  fail("_headers has no hashed Content-Security-Policy");
const connect = headers.match(/connect-src ([^;]*);/)?.[1].trim();
let deployment;
if (LAUNCH) {
  deployment = JSON.parse(await readFile(`${dir}/imd-deployment.json`, "utf8"));
  if (deployment.chainId !== 1 || deployment.network?.testnet !== false || deployment.interface !== "maker")
    fail(`the terminal's deployment is not the mainnet one (chain ${deployment.chainId}, ${deployment.interface})`);
  if (!deployment.oracleAsker?.address) fail("the deployment names no OracleAsker");
  const ens = JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "../src/ens-rpc.json"), "utf8"));
  const want = [
    "'self'",
    "https://cloudflareinsights.com",
    ...new Set([...deployment.network.rpcUrls, ...ens].map((u) => new URL(u).origin).concat("https://eth.blockscout.com", "https://api.imd.fun")),
  ].join(" ");
  if (connect !== want) fail(`connect-src is "${connect}", expected "${want}"`);
  // imdusd.com/rpc (worker/rpc.js) serves only the contracts in rpc-allow.json: every contract the deployment
  // names must be in it, and Multicall3, which bundles the terminal's reads.
  const rpcAllow = JSON.parse(await readFile(`${dir}/rpc-allow.json`, "utf8").catch(() => "null"));
  if (!Array.isArray(rpcAllow)) fail("rpc-allow.json is missing");
  else
    for (const a of [
      ...deployment.contracts.map((c) => c.address),
      deployment.oracleAsker.address,
      "0xca11bde05977b3631167028862be2a173976ca11",
    ])
      if (!rpcAllow.includes(a.toLowerCase())) fail(`rpc-allow.json lacks ${a}`);
  if (/terminal/.test(await readFile(`${dir}/_redirects`, "utf8").catch(() => "")))
    fail("_redirects still sends /terminal home");
} else if (connect !== "'self' https://cloudflareinsights.com")
  fail(`the Content-Security-Policy allows network connections beyond Cloudflare Web Analytics: ${connect}`);
const scripts = headers.match(/script-src ([^;]*);/)?.[1].split(/\s+/).filter((s) => !s.startsWith("'")) ?? [];
if (scripts.join(" ") !== "https://static.cloudflareinsights.com")
  fail(`the Content-Security-Policy admits script origins beyond Cloudflare Web Analytics: ${scripts.join(" ")}`);
// Soft navigation (src/soft.tsx) moves between pages of one build only: every page names the same build.
const builds = new Set();
for (const f of files.filter((f) => f.endsWith(".html")))
  builds.add((await readFile(`${dir}/${f}`, "utf8")).match(/<meta name="build" content="([^"]+)"/)?.[1]);
if (builds.size !== 1 || builds.has(undefined)) fail(`pages disagree on <meta name="build">: ${[...builds]}`);
if (!LAUNCH && files.some((f) => f.startsWith("terminal/")))
  fail("the terminal was built into the public site");
if (!LAUNCH && files.includes("rpc-allow.json")) fail("the public site ships rpc-allow.json, but it has no terminal");
// The public site connects to no chain: no deployment file, no ABIs.
for (const f of LAUNCH ? [] : files)
  if (f === "imd-deployment.json" || f.startsWith("abi/"))
    fail(`${f} ships a chain deployment`);
// At launch the terminal's code legitimately reads chains (and keeps its testnet branches for other
// deployments); its pages and every non-script file are still held to the rule.
for (const f of files.filter((f) => /\.(html|js|css|webmanifest|txt)$/.test(f) && !(LAUNCH && f.endsWith(".js")))) {
  const text = await readFile(`${dir}/${f}`, "utf8");
  // A link to the terminal, in any of the forms the site writes one.
  if (!LAUNCH && /["'`(]\.{0,2}\/?terminal\//.test(text))
    fail(`${f} still links to the terminal`);
  // Nothing about the testnet, and no way to reach a chain: no explorer, no RPC endpoint.
  // Nothing about the testnet anywhere; and no way to reach a chain from the site's code (docs prose
  // may name RPC methods for integrators, the JavaScript may not call them).
  const leak =
    text.match(/sepolia|testnet/i) ??
    (f.endsWith(".js")
      ? text.match(
          /blockscout|etherscan|publicnode|infura|alchemy|eth_call|eth_getLogs/i,
        )
      : null);
  if (leak) fail(`${f} mentions "${leak[0]}"`);
}
// The favicon is drawn twice: public/favicon.svg (follows the OS theme) and theme.tsx (follows the
// in-page toggle). Both must be the same mark.
// The mark is pixel art: the <rect>s inside the favicon's ink group.
const mark = (await readFile(`${dir}/favicon.svg`, "utf8")).match(
  /<g style="fill:var\(--text\)">(.*?)<\/g>/,
)?.[1];
const bundle = (
  await Promise.all(
    files
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFile(`${dir}/${f}`, "utf8")),
  )
).join("");
if (!mark || !bundle.includes(mark))
  fail("favicon.svg and the theme toggle's favicon are different marks");
// The terminal is not public yet: in every docs page, the content and the title must not name it
// (the docs build redacts it). The page shell is exempt: it carries a theme storage key.
for (const f of files.filter(
  (f) => !LAUNCH && f.startsWith("docs/") && f.endsWith(".html"),
)) {
  const html = await readFile(`${dir}/${f}`, "utf8");
  const main = html.match(/<main[\s\S]*?<\/main>/)?.[0] ?? "";
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
  const description =
    html.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1] ?? "";
  if (/terminal/i.test(main + title + description))
    fail(`${f} still names the terminal`);
}
const manifest = JSON.parse(
  await readFile(`${dir}/manifest.webmanifest`, "utf8"),
);
if (manifest.start_url !== "./")
  fail(`manifest start_url is ${manifest.start_url}`);
console.log(
  LAUNCH
    ? `public-check --launch: ${files.length} files; homepage, docs and the terminal on chain 1; connect-src ${connect}.`
    : `public-check: ${files.length} files; homepage and docs only; no terminal links, no testnet, no chain connection.`,
);
