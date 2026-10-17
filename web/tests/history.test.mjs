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
  history,
  historyGroup,
  alignedWindows,
  limited,
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

test("windows are aligned to 5,000 blocks (so /rpc can cache closed ones), and the open one reaches back 2,000", async () => {
  const ranges = [];
  const r = runtime({
    getLogs: async (params) => {
      ranges.push(params);
      return [{ ...depositLogs[0], blockNumber: params.fromBlock }];
    },
  });
  const result = await rangeLogs(r, t, 16n, 10020n);
  assert.equal(result.source, "RPC");
  assert.deepEqual(
    ranges.map((p) => [p.fromBlock, p.toBlock]),
    [
      [0n, 4999n],
      [5000n, 9999n],
      [8021n, 10020n],
    ],
  );
  // A range inside the open window is one read; a long open window is not extended.
  assert.deepEqual(alignedWindows(9990n, 10020n), [[8021n, 10020n]]);
  assert.deepEqual(alignedWindows(9000n, 13000n), [[5000n, 9999n], [10000n, 13000n]]);
  assert.deepEqual(alignedWindows(5n, 300n), [[0n, 300n]]);
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

// Several contracts read together: one request per window names them all (sorted, lowercase), the answer is split per
// contract, concurrent readers share it, and an empty answer is unverified for every contract in it.
const vaultT = t;
const tokenT = { address: addresses.compToken, abi: abi.CompToken };
const groupRuntime = (getLogs) => {
  const r = runtime({ getCode: async ({ blockNumber }) => (blockNumber >= 16n ? "0x01" : "0x"), getLogs });
  historyGroup(r, [vaultT.address, feed.address, tokenT.address]);
  return r;
};
const inRange = (logs, p) => logs.filter((l) => BigInt(l.blockNumber) >= p.fromBlock && BigInt(l.blockNumber) <= p.toBlock);
const allLogs = () => [vaultT, feed, tokenT].flatMap((x) => fixtureLogs(state, x.address));
test("a group reads each window once for every contract and splits the answer per contract", async () => {
  global.fetch = async () => {
    throw Error("no network in this test");
  };
  const asked = [];
  const r = groupRuntime(async (p) => {
    asked.push(p);
    return inRange(allLogs(), p);
  });
  try {
    const [v, f, k] = await Promise.all([history(r, vaultT, 256n), history(r, feed, 256n), history(r, tokenT, 256n)]);
    assert.equal(asked.length, 1, "one eth_getLogs for three contracts");
    assert.deepEqual(asked[0].address, [vaultT.address, feed.address, tokenT.address].map((a) => a.toLowerCase()).sort());
    assert.equal(v.logs.length, fixtureLogs(state, vaultT.address).length);
    assert.equal(f.logs.length, fixtureLogs(state, feed.address).length);
    assert.equal(k.logs.length, fixtureLogs(state, tokenT.address).length);
    assert.ok(v.logs.every((l) => l.address.toLowerCase() === vaultT.address.toLowerCase()));
    assert.ok(f.logs.every((l) => l.address.toLowerCase() === feed.address.toLowerCase()));
    assert.equal(v.source, "RPC");
    // The same head again (another panel of the same refresh): the open window is shared, nothing is read.
    await history(r, feed, 256n);
    assert.equal(asked.length, 1);
    // A new snapshot is a new refresh: the open window is read again, once for everyone.
    historyGroup(r, [vaultT.address, feed.address, tokenT.address]);
    await Promise.all([history(r, vaultT, 256n), history(r, feed, 256n)]);
    assert.equal(asked.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
test("closed windows are kept for the runtime; a contract quiet in a verified window is believed", async () => {
  global.fetch = async () => {
    throw Error("no network in this test");
  };
  const asked = [];
  // Logs far apart: the vault's in the first window, the token's in the second, the feed's in the open one.
  const shift = (logs, by) => logs.map((l) => ({ ...l, blockNumber: "0x" + (BigInt(l.blockNumber) + by).toString(16) }));
  const logs = [...fixtureLogs(state, vaultT.address), ...shift(fixtureLogs(state, tokenT.address), 6000n), ...shift(fixtureLogs(state, feed.address), 12000n)];
  const r = groupRuntime(async (p) => {
    asked.push([p.fromBlock, p.toBlock]);
    return inRange(logs, p);
  });
  try {
    const v = await history(r, vaultT, 12200n);
    // Nothing of the vault's after block 4,999, in windows other contracts' logs verified: believed, not refused.
    assert.equal(v.source, "RPC");
    assert.equal(v.logs.length, fixtureLogs(state, vaultT.address).length);
    assert.deepEqual(asked, [
      [0n, 4999n],
      [5000n, 9999n],
      [10000n, 12200n],
    ]);
    // Another contract later: closed windows come from memory, only the open window is read again (new snapshot).
    historyGroup(r, [vaultT.address, feed.address, tokenT.address]);
    const f = await history(r, feed, 12200n);
    assert.equal(f.logs.length, fixtureLogs(state, feed.address).length);
    assert.equal(asked.length, 4);
  } finally {
    global.fetch = originalFetch;
  }
});
test("an empty group window is unverified: each contract falls back to Blockscout on its own", async () => {
  const urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    const address = String(url).split("/")[6];
    return { ok: true, json: async () => ({ items: fixtureLogs(state, address), next_page_params: null }) };
  };
  try {
    const r = groupRuntime(async () => []);
    const [v, f] = await Promise.all([history(r, vaultT, 256n), history(r, feed, 256n)]);
    assert.equal(v.source, "Blockscout");
    assert.equal(f.source, "Blockscout");
    assert.equal(v.logs.length, fixtureLogs(state, vaultT.address).length);
    assert.equal(f.logs.length, fixtureLogs(state, feed.address).length);
    assert.equal(urls.filter((u) => u.includes(vaultT.address)).length, 1);
    assert.equal(urls.filter((u) => u.includes(feed.address)).length, 1);
    // A log for a contract outside the group cannot certify anything either.
    const stray = groupRuntime(async (p) => inRange([...allLogs(), { ...depositLogs[0], address: addresses.treasury }], p));
    assert.equal((await history(stray, vaultT, 256n)).source, "Blockscout");
  } finally {
    global.fetch = originalFetch;
  }
});
test("a contract with no log in its whole history is confirmed with Blockscout, never shown as empty", async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ items: [], next_page_params: null }) });
  try {
    const r = groupRuntime(async (p) => inRange(fixtureLogs(state, vaultT.address), p));
    await assert.rejects(history(r, tokenT, 256n), /Could not read history/);
    assert.equal((await history(r, vaultT, 256n)).source, "RPC");
  } finally {
    global.fetch = originalFetch;
  }
});
test("log reads share one limit per runtime, whoever asks", async () => {
  const r = runtime({});
  let busy = 0,
    peak = 0;
  const job = () =>
    limited(r, async () => {
      peak = Math.max(peak, ++busy);
      await new Promise((go) => setTimeout(go, 2));
      busy--;
    });
  await Promise.all(Array.from({ length: 20 }, job));
  assert.equal(peak, 6);
  assert.equal(busy, 0);
});
