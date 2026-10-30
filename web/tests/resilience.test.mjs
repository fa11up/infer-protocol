// The stats page's resilience figures (src/resilience.ts) and the pages for builders and partners: their numbers, their
// event list, their addresses against the docs, and their place in every header, footer, route and sitemap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { bandShare, pegBreaks, pegHours } from "../src/resilience.ts";
import { STRESS_EVENTS, eventTime } from "../src/resilience-events.ts";
import { BUILD_CONTRACTS, PEG_POOL_ID } from "../src/build-addresses.ts";

const H = 3600;
const at = (h, price) => ({ t: h * H, price, block: h });

test("pegHours: each whole hour's time-weighted average and low", () => {
  // $1 for the first half of hour 1, $0.90 for the second; $0.90 all of hour 2; back to $1 at the start of hour 3.
  const points = [at(0, 1), { t: 1.5 * H, price: 0.9, block: 2 }, at(3, 1)];
  const hours = pegHours(points, 1 * H, 4 * H);
  assert.deepEqual(
    hours.map((h) => h.t / H),
    [1, 2, 3],
  );
  assert.ok(Math.abs(hours[0].avg - 0.95) < 1e-12, `hour 1 averages $0.95, got ${hours[0].avg}`);
  assert.equal(hours[0].low, 0.9);
  assert.equal(hours[1].avg, 0.9);
  assert.equal(hours[2].avg, 1);
  // The last partial hour is left out, and an empty history has no hours.
  assert.equal(pegHours(points, 1 * H, 3.5 * H).length, 2);
  assert.deepEqual(pegHours([], 0, 10 * H), []);
});

test("pegBreaks: each stretch under the band, its low, and an open one without an end", () => {
  const points = [at(0, 1), at(1, 0.98), at(2, 0.95), at(3, 0.991), at(4, 0.97), at(5, 0.96)];
  const breaks = pegBreaks(points);
  assert.equal(breaks.length, 2);
  assert.deepEqual(breaks[0], { start: 1 * H, end: 3 * H, low: 0.95, lowAt: 2 * H });
  assert.equal(breaks[1].end, undefined, "still under the band");
  assert.equal(breaks[1].low, 0.96);
  assert.deepEqual(pegBreaks([at(0, 1), at(1, 1.005)]), []);
});

test("bandShare: hours inside $0.99-$1.01 and the worst one", () => {
  const hours = [
    { t: 0, avg: 1, low: 1 },
    { t: H, avg: 0.95, low: 0.9 },
    { t: 2 * H, avg: 1.02, low: 1 },
    { t: 3 * H, avg: 0.995, low: 0.99 },
  ];
  const b = bandShare(hours);
  assert.equal(b.inside, 2);
  assert.equal(b.total, 4);
  assert.equal(b.share, 0.5);
  assert.equal(b.worst.t, H);
  assert.equal(bandShare([]).share, undefined);
});

test("stress events: dated, in order, spans that end after they start, neutral and with no addresses", () => {
  let last = 0;
  for (const e of STRESS_EVENTS) {
    const t0 = eventTime(e.from);
    assert.ok(Number.isFinite(t0) && e.from.endsWith("Z"), `${e.title}: a UTC date`);
    assert.ok(t0 >= last, `${e.title}: in order`);
    last = t0;
    if (e.to) assert.ok(eventTime(e.to) > t0, `${e.title}: ends after it starts`);
    for (const text of [e.title, e.text]) {
      assert.doesNotMatch(text, /0x[0-9a-f]{6,}/i, `${e.title}: no addresses`);
      assert.doesNotMatch(text, /\.eth\b/i, `${e.title}: no names`);
    }
    assert.ok(e.text.length <= 220, `${e.title}: one line`);
  }
});

test("/build/ lists only addresses the docs' contracts page lists", async () => {
  const docs = (await readFile(new URL("../content/docs/reference/contracts-and-addresses.md", import.meta.url), "utf8")).toLowerCase();
  for (const c of BUILD_CONTRACTS) {
    assert.match(c.address, /^0x[0-9a-fA-F]{40}$/, c.name);
    assert.ok(docs.includes(c.address.toLowerCase()), `${c.name} ${c.address} is on the docs' contracts page`);
  }
  const pool = await readFile(new URL("../content/docs/overview/the-peg-pool.md", import.meta.url), "utf8");
  assert.ok(pool.includes(PEG_POOL_ID), "the peg pool id matches the docs");
});

test("/build/ and /partners/ are in the header, every footer, the routes, the build inputs and the sitemap", async () => {
  const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
  const [site, routes, vite, docsPages, blogPages] = await Promise.all([
    read("../src/site.tsx"),
    read("../src/routes-imdusd.ts"),
    read("../vite.config.ts"),
    read("../scripts/docs-pages.mjs"),
    read("../scripts/blog-pages.mjs"),
  ]);
  const header = site.slice(site.indexOf("export function SiteHeader"), site.indexOf("export function SiteFooter"));
  const footer = site.slice(site.indexOf("export function SiteFooter"));
  for (const [path, label] of [
    ["build/", "Build"],
    ["partners/", "Partners"],
  ]) {
    assert.ok(header.includes(`"${path}", "${label}"`), `header links ${label}`);
    assert.ok(footer.includes(`siteHref("${path}")`), `footer links ${label}`);
    assert.ok(routes.includes(`path: "${path}"`), `soft route for ${path}`);
    assert.ok(vite.includes(`"${path.slice(0, -1)}/index.html"`), `build input for ${path}`);
    assert.ok(docsPages.includes(`\${root}/${path}">${label}</a>`), `docs footer links ${label}`);
    assert.ok(blogPages.includes(`https://imdusd.com/${path}">${label}</a>`), `blog footer links ${label}`);
    assert.ok(docsPages.includes(`"${path}"`), `sitemap lists ${path}`);
  }
});
