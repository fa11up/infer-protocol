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
const KEEP_MS = 120_000;

/** USDC per imdUSD. currency0 is imdUSD (18 decimals), currency1 USDC (6): price = sqrtP² / 2^192 × 10^12. */
export async function readPeg(): Promise<number> {
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

/** "imdUSD $1.0084" beside the network chips; in the danger ink once it is half a cent or more off its dollar. */
export function PegTicker() {
  const v = usePegPrice();
  if (v === undefined) return null;
  const off = Math.abs(v - 1) >= 0.005;
  return (
    <a
      className="chip ticker"
      href="https://app.uniswap.org/explore/pools/ethereum/0x3cb8cc9c22f7da5c3169d4059131ddba9e61f68230977797c03a2f1214992035"
      target="_blank"
      rel="noreferrer"
      title="imdUSD's price in its imdUSD/USDC pool on Uniswap"
    >
      imdUSD <b className={off ? "ticker-off" : undefined}>${v.toFixed(4)}</b>
    </a>
  );
}
