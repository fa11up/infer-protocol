import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  fixture,
  fixtureLogs,
  addresses,
  abi,
  account,
  candidate,
  closedOwner,
  extraOwner,
} from "./fixture.mjs";
// history.ts now reaches site.tsx and BuyUpdate.tsx through config and state, so Node's type
// stripping can no longer load it by rewriting import paths. Vite bundles it for Node instead, with
// every dependency left external; the delivered source's behavior is exercised unchanged.
const scratch = new URL(
  "../../test/scratch/history-module.mjs",
  import.meta.url,
);
await mkdir(new URL(".", scratch), { recursive: true });
const { build } = await import("vite");
// site.tsx pulls in the theme toggle, which reads `window` when loaded; config.ts only calls its
// appRoot() lazily, so the test stands in a root for it and leaves the rest of the graph as shipped.
const siteStub = new URL(
  "../../test/scratch/history-site-stub.mjs",
  import.meta.url,
);
await writeFile(
  siteStub,
  'export const appRoot = () => new URL("http://localhost/");\nexport const href = (p = "") => new URL(p, appRoot()).href;\nexport const TERMINAL = true;\nexport const WHITEPAPER = "";\nexport const SiteHeader = () => null;\n',
);
// The entry re-exports the interface switch beside history: the fixture is the legacy Sepolia
// deployment (deployment-source.json), whose events carry the old names.
const entry = new URL("../../test/scratch/history-entry.ts", import.meta.url);
await writeFile(
  entry,
  `export * from ${JSON.stringify(new URL("../src/history.ts", import.meta.url).pathname)};\n` +
    `export { setInterface } from ${JSON.stringify(new URL("../src/names.ts", import.meta.url).pathname)};\n`,
);
await build({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  mode: "test",
  resolve: { alias: [{ find: /^\.\/site$/, replacement: siteStub.pathname }] },
  // Everything bundled in, so the module runs from the scratch directory outside web/.
  ssr: { noExternal: true, target: "node" },
  build: {
    ssr: entry.pathname,
    outDir: new URL(".", scratch).pathname,
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    rolldownOptions: { output: { entryFileNames: "history-module.mjs" } },
  },
});
const {
  rangeLogs,
  explorerLogs,
  loanBook,
  acceptedPoints,
  positionName,
  setInterface,
} = await import(scratch.href);
setInterface("legacy");
const t = {
  address: addresses.ParameterizedVault,
  abi: abi.ParameterizedVault,
};
const feed = { address: addresses.PriceFeed, abi: abi.PriceFeed };
const originalFetch = global.fetch;
const state = fixture();
const depositLogs = fixtureLogs(state, t.address);
const normalized = (logs) =>
  logs.map((l) => ({
    ...l,
    blockNumber: BigInt(l.blockNumber),
    logIndex: Number(BigInt(l.logIndex)),
  }));
const runtime = (client) => ({ config: { chainId: 11155111 }, client });

test("historical ranges cover the range, end on multiples of 2,000 (so /rpc can cache them), and the first and last span a full chunk", async () => {
  const ranges = [];
  const r = runtime({
    getLogs: async (params) => {
      ranges.push(params);
      return [{ ...depositLogs[0], blockNumber: params.fromBlock }];
    },
  });
  const result = await rangeLogs(r, t, 16n, 5020n);
  assert.equal(result.source, "RPC");
  assert.deepEqual(
    ranges.map((p) => [p.fromBlock, p.toBlock]),
    [
      [16n, 3999n],
      [3021n, 5020n],
    ],
  );
});
test("silent empty RPC falls back to every Blockscout page, and both empty is unknown", async () => {
  let urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    const second = String(url).includes("block_number=100");
    const selected = second ? depositLogs.slice(0, 2) : depositLogs.slice(2);
    return {
      ok: true,
      json: async () => ({
        items: selected,
        next_page_params: second
          ? null
          : { block_number: 100, index: 2, items_count: 3 },
      }),
    };
  };
  try {
    const result = await rangeLogs(
      runtime({ getLogs: async () => [] }),
      t,
      16n,
      256n,
    );
    assert.equal(result.source, "Blockscout");
    // Both pages together are the fixture's whole vault history.
    assert.equal(result.logs.length, depositLogs.length);
    assert.equal(urls.length, 2);
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ items: [], next_page_params: null }),
    });
    await assert.rejects(
      rangeLogs(runtime({ getLogs: async () => [] }), t, 16n, 256n),
      /Could not read history/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});
test("pagination loops, missing cursor schema and wrong-address logs cannot certify coverage", async () => {
  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        items: depositLogs,
        next_page_params: { index: 1 },
      }),
    });
    await assert.rejects(
      explorerLogs(runtime({}), t, 16n, 256n),
      /did not advance/,
    );
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ items: depositLogs }),
    });
    await assert.rejects(explorerLogs(runtime({}), t, 16n, 256n), /Incomplete/);
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        items: [{ ...depositLogs[0], address: feed.address }],
        next_page_params: null,
      }),
    });
    await assert.rejects(
      explorerLogs(runtime({}), t, 16n, 256n),
      /address mismatch/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});
test("book discovers distinct deposit owners, reads the same block, drops zero debt, fails on partial reads", async () => {
  const calls = [];
  // The RPC honours the range it is asked for: a refresh re-reads only the reorg overlap, and the
  // reader refuses logs from outside the range (so a mock returning everything would fall through to
  // Blockscout). Blockscout itself is unreachable here; a fall-through fails fast instead of fetching.
  global.fetch = async () => {
    throw Error("no network in this test");
  };
  const r = runtime({
    getCode: async ({ blockNumber }) => (blockNumber >= 16n ? "0x01" : "0x"),
    getLogs: async ({ fromBlock, toBlock }) =>
      depositLogs.filter(
        (l) =>
          BigInt(l.blockNumber) >= fromBlock &&
          BigInt(l.blockNumber) <= toBlock,
      ),
    readContract: async ({ functionName, args, blockNumber }) => {
      calls.push({ functionName, args, blockNumber });
      if (functionName === "collateralRatio") return 180n;
      return [
        100n,
        args[0].toLowerCase() === closedOwner.toLowerCase() ? 0n : 50n,
      ];
    },
  });
  const s = { targets: { ParameterizedVault: t }, block: 256n };
  const book = await loanBook(r, s);
  assert.equal(book.history.from, 16n);
  assert.equal(book.positions.length, 3);
  assert.equal(calls.filter((c) => c.functionName === "positions").length, 4);
  assert.ok(calls.every((c) => c.blockNumber === 256n));
  try {
    r.client.readContract = async () => {
      throw Error("owner unavailable");
    };
    await assert.rejects(loanBook(r, s), /owner unavailable/);
  } finally {
    global.fetch = originalFetch;
  }
});
test("a fresh vault with verified logs but no deposit is an empty book, not an error", async () => {
  global.fetch = async () => {
    throw Error("no network in this test");
  };
  // Real logs in range (the constructor's events), none of them a Lock.
  const other = depositLogs.map((l) => ({
    ...l,
    topics: [`0x${"ab".repeat(32)}`, ...l.topics.slice(1)],
  }));
  const r = runtime({
    getCode: async ({ blockNumber }) => (blockNumber >= 16n ? "0x01" : "0x"),
    getLogs: async ({ fromBlock, toBlock }) =>
      other.filter(
        (l) =>
          BigInt(l.blockNumber) >= fromBlock &&
          BigInt(l.blockNumber) <= toBlock,
      ),
    readContract: async () => {
      throw Error("no owner should be read");
    },
  });
  try {
    const book = await loanBook(r, {
      targets: { ParameterizedVault: t },
      block: 256n,
    });
    assert.equal(book.positions.length, 0);
    assert.ok(book.history.logs.length > 0);
  } finally {
    global.fetch = originalFetch;
  }
});
test("accepted points pair the preceding value within the same transaction; reporter values excluded", () => {
  const logs = normalized(fixtureLogs(state, feed.address));
  const points = acceptedPoints(feed, logs);
  assert.equal(points.length, 4);
  assert.deepEqual(
    points.map((p) => Number(state.now) - p.time),
    [7200, 7000, 2400, 120],
  );
  assert.equal(points[0].value, 10n ** 15n);
  assert.equal(
    acceptedPoints(
      feed,
      logs.filter((l) => l.logIndex === 0),
    ).length,
    0,
  );
  assert.throws(() => acceptedPoints(feed, [logs[1]]), /missing its value/);
});
test("address names use the complete address and stable case-independent vocabulary", () => {
  assert.equal(positionName(account), positionName(account.toUpperCase()));
  assert.equal(positionName(account), "Copper Penny");
  assert.notEqual(positionName(account), positionName(candidate));
  assert.match(positionName(extraOwner), /^\w+ \w+$/);
});
