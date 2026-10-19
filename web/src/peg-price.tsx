// imdUSD's market price for the imdusd.com header: the imdUSD/USDC peg pool's slot0, read through the site's
// own /rpc (worker/rpc.js; the PoolManager is on its allowlist). One eth_call, no viem, so the homepage and the
// docs stay light. Display only: a pool can be pushed within a block. Nothing is shown until a read succeeds,
// and a build without /rpc (staging, local dev) simply shows nothing.
import { useEffect, useState } from "react";
import { everyVisible } from "./infer/visible";

const POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";
/** extsload(keccak256(abi.encode(poolId, 6))): slot0 of pool 0x3cb8cc9c…2992035 (imdUSD/USDC, PegFeeHook). */
const SLOT0_CALL =
  "0x1e2eaeaf1dbccba4aec74400b6ea5e6bb1c3e931232ad7d9664e083f9178059dfc726192";
const POLL_MS = 30_000;
/** Only imdusd.com's Workers serve /rpc (worker/index.js, worker/infer.js). */
export const HAS_RPC = typeof location !== "undefined" && /(^|\.)imdusd\.com$/.test(location.hostname);
const KEEP_MS = 120_000;

/** USDC per imdUSD. currency0 is imdUSD (18 decimals), currency1 USDC (6): price = sqrtP² / 2^192 × 10^12. */
export async function readPeg(): Promise<number> {
  // Only imdusd.com's Workers serve /rpc (worker/index.js, worker/infer.js); elsewhere (staging, local dev, the test
  // server) the request would only 404 into the console every poll, so it is not sent.
  if (!HAS_RPC) throw Error("no /rpc on this host");
  const r = await fetch("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: POOL_MANAGER, data: SLOT0_CALL }, "latest"] }),
  });
  const d = (await r.json()) as { result?: string };
  if (!d.result) throw Error("no slot0");
  const sqrt = BigInt(d.result) & ((1n << 160n) - 1n);
  if (sqrt === 0n) throw Error("pool not initialised");
  // In 1e12 fixed point before the float conversion, so the division keeps its digits.
  return Number((sqrt * sqrt * 10n ** 24n) >> 192n) / 1e12;
}

export function usePegPrice(): number | undefined {
  const [p, setP] = useState<{ v: number; at: number }>();
  useEffect(() => {
    let live = true;
    const tick = () =>
      readPeg()
        .then((v) => live && setP({ v, at: Date.now() }))
        .catch(() => live && setP((old) => (old && Date.now() - old.at < KEEP_MS ? old : undefined)));
    tick();
    const stop = everyVisible(tick, POLL_MS);
    return () => {
      live = false;
      stop();
    };
  }, []);
  return p?.v;
}

/** "imdUSD $1.0084" beside the network chips: green inside the $0.99–$1.01 peg band, yellow out to 2%, red beyond
 * (the Stats page's peg tile, user 2026-10-19). With `href` (where the terminal exists) it opens the liquidity window's
 * Trade tab; without, it links to Matcha. */
export function PegTicker({ href }: { href?: string }) {
  const v = usePegPrice();
  // On imdusd.com the chip's place is kept, empty, until the first read: it arriving used to push the chips beside
  // it along (and on a narrow phone wrap them onto a second row). Elsewhere there is no /rpc, so no chip at all.
  if (v === undefined)
    return HAS_RPC ? (
      <span className="chip peg-ticker peg-waiting" aria-hidden="true">
        imdUSD <b>$&nbsp;1.0000</b>
      </span>
    ) : null;
  const off = Math.abs(v - 1);
  const level = off <= 0.01 ? "peg-ok" : off <= 0.02 ? "peg-warn" : "peg-bad";
  const body = (
    <>
      imdUSD <b className={level}>$&nbsp;{v.toFixed(4)}</b>
    </>
  );
  return href ? (
    <a className="chip peg-ticker" href={href} title="imdUSD's price in its imdUSD/USDC pool; trade it in the terminal">
      {body}
    </a>
  ) : (
    <a
      className="chip peg-ticker"
      href="https://matcha.xyz/tokens/ethereum/0x61aaf8a992a3143e2b0c9cb0030b9fe702854a25"
      target="_blank"
      rel="noreferrer"
      title="imdUSD's price in its imdUSD/USDC pool; trade it on Matcha"
    >
      {body}
    </a>
  );
}
