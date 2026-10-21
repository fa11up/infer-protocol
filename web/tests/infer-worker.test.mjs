// infer.imdusd.com's Worker mounts the same 0x proxy as imdusd.com: /swap/price and /swap/quote go to
// worker/swap.js (503 "unconfigured" until the ZEROX_API_KEY secret is set), everything else is an asset.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/infer.js";

const env = () => ({
  ASSETS: { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`, { status: 200 }) },
});
const get = (path) => new Request(`https://infer.imdusd.com${path}`, { headers: { "sec-fetch-site": "same-origin" } });

test("/swap/price is answered by the swap proxy, not the assets", async () => {
  const res = await worker.fetch(
    get("/swap/price?chainId=1&sellToken=0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7&buyToken=0x53d0eA0A685220718Dc6a0a6e4617194C6F37921&sellAmount=1000"),
    env(),
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "Swaps are temporarily unavailable.", reason: "unconfigured" });
});

test("an unknown /swap route is a 404 from the proxy", async () => {
  const res = await worker.fetch(get("/swap/other"), env());
  assert.equal(res.status, 404);
});

test("a cross-site /swap request is refused", async () => {
  const req = new Request("https://infer.imdusd.com/swap/price?chainId=1", { headers: { origin: "https://evil.example" } });
  assert.equal((await worker.fetch(req, env())).status, 403);
});

test("other paths still come from the assets", async () => {
  const res = await worker.fetch(get("/buy/"), env());
  assert.equal(await res.text(), "asset /buy/");
});
