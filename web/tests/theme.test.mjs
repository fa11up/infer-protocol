import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const css = await readFile(
  new URL("../src/style.css", import.meta.url),
  "utf8",
);
const blocks = [...css.matchAll(/:root[^{}]*\{([^}]+)\}/g)].map((m) => m[1]);
const colors = (block) =>
  Object.fromEntries(
    [...block.matchAll(/(--[a-z-]+):\s*(#[\da-f]+|transparent);/gi)].map(
      (m) => [m[1], m[2].toUpperCase()],
    ),
  );
const light = colors(blocks[0]),
  dark = colors(blocks[1]);
// One signal colour sits outside the seven: --live, the bright green of a live network's chip (the
// palette's own green, #2F5D50, read too dark at 10px; user's call, 2026-10-08). It is pinned here to
// that one role and that one value, so the palette cannot drift through it.
const SIGNAL = { "--live": "#15803D" };
test("both themes define identical color roles and light uses exactly the seven approved hexes", () => {
  assert.deepEqual(Object.keys(light).sort(), Object.keys(dark).sort());
  for (const [role, hex] of Object.entries(SIGNAL))
    assert.equal(light[role], hex);
  const palette = Object.entries(light)
    .filter(([role]) => !(role in SIGNAL))
    .map(([, v]) => v);
  assert.deepEqual(
    [...new Set(palette.filter((v) => v.startsWith("#")))].sort(),
    [
      "#F7F5EF",
      "#FFFDF8",
      "#16202E",
      "#5A6472",
      "#D8D3C7",
      "#2F5D50",
      "#8C2F2F",
    ].sort(),
  );
  assert.equal(dark["--bg"], "#111111");
  assert.equal(dark["--surface"], "#161616");
  assert.equal(dark["--text"], "#EEEEEE");
  assert.equal(dark["--muted"], "#A8A8A8");
  assert.equal(dark["--rule"], "#3A3A3A");
  assert.equal(dark["--raised"], "#202020");
});
test("component paint has no literal colors or missing custom properties", () => {
  const components = css.replace(/--[a-z-]+:\s*[^;]+;/g, "");
  assert.doesNotMatch(components, /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i);
  // `transparent` is the absence of paint, not a colour, so it may appear on its own and as a
  // gradient stop; every other stop in a gradient must be a token.
  for (const [, args] of components.matchAll(
    /gradient\(((?:[^()]|\([^()]*\))*)\)/g,
  )) {
    const stops = args.split(/,(?![^(]*\))/).map((s) => s.trim());
    if (
      /^(?:to\s|circle|ellipse|at\s|-?[\d.]+(?:deg|turn|rad)$)/.test(stops[0])
    )
      stops.shift();
    for (const stop of stops)
      assert.match(
        stop,
        /^(?:var\(--[a-z-]+\)|transparent)(?:\s+[\d.]+(?:%|px|em))?(?:\s+[\d.]+(?:%|px|em))?$/,
        `gradient stop ${stop}`,
      );
  }
  const defined = new Set([...css.matchAll(/(--[a-z-]+):/g)].map((m) => m[1]));
  for (const [, token] of css.matchAll(/var\((--[a-z-]+)/g))
    assert.ok(defined.has(token), token);
});
