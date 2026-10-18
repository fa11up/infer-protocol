// The price feeds' age for the imdusd.com header: "Oracle 12m", the older of the PriceFeed and SpotFeed updates.
// Read as peg-price.tsx reads the peg: one JSON-RPC batch to the site's own /rpc (both feeds are deployment
// contracts, so on its allowlist), no viem, polled while the page is on screen. Nothing shows until a read succeeds;
// a build without /rpc (staging, local dev) shows nothing at all.
import { useEffect, useState } from "react";
import { everyVisible } from "./infer/visible";
import { contracts } from "../deployment-source.json";
import { HAS_RPC } from "./peg-price";

const FEEDS = ["PriceFeed", "SpotFeed"].map((name) => {
  const c = contracts.find((x) => x.name === name);
  if (!c) throw Error(`deployment-source.json names no ${name}`);
  return c.address;
});
const LATEST_VALUE = "0x4ab5cc82"; // latestValue() returns (uint256 value, uint64 updatedAt)
const MAX_AGE = "0x687043c5"; // maxAge() returns (uint256)
const POLL_MS = 60_000;
/** A failed read keeps the last good one this long, then the chip says the feeds are unreadable. */
const KEEP_MS = 180_000;
/** Stale past this many seconds reads red: hours without a price, not a missed update. */
const LONG_STALE = 6 * 3600;

export type FeedAges = { updated: number; maxAge: number };

/** The older feed's update time and the tighter of their maximum ages, in unix seconds. */
export async function readFeeds(): Promise<FeedAges> {
  if (!HAS_RPC) throw Error("no /rpc on this host");
  const calls = FEEDS.flatMap((to, i) => [
    { jsonrpc: "2.0", id: 2 * i, method: "eth_call", params: [{ to, data: LATEST_VALUE }, "latest"] },
    { jsonrpc: "2.0", id: 2 * i + 1, method: "eth_call", params: [{ to, data: MAX_AGE }, "latest"] },
  ]);
  const r = await fetch("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(calls) });
  const answers = (await r.json()) as { id: number; result?: string }[];
  const word = (id: number, n: number) => {
    const hex = answers.find((a) => a.id === id)?.result;
    if (!hex || hex.length < 2 + 64 * (n + 1)) throw Error("feed unreadable");
    return Number(BigInt("0x" + hex.slice(2 + 64 * n, 2 + 64 * (n + 1))));
  };
  const updated = Math.min(word(0, 1), word(2, 1));
  if (!updated) throw Error("feed never updated");
  return { updated, maxAge: Math.min(word(1, 0), word(3, 0)) };
}

/** "12m", "3h", "2d". */
export function ago(secs: number) {
  const m = Math.max(0, Math.floor(secs / 60));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
function spoken(secs: number) {
  const m = Math.max(0, Math.floor(secs / 60));
  if (m < 1) return "less than a minute";
  if (m < 120) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} hours` : `${Math.floor(h / 24)} days`;
}

/** Green while both feeds are fresh, yellow once either is stale (borrowing pauses), red past six hours stale or
 * when they cannot be read. */
export function oracleLevel(age: number, maxAge: number) {
  return age <= maxAge ? "peg-ok" : age <= LONG_STALE ? "peg-warn" : "peg-bad";
}

export function OracleChip({ href }: { href?: string }) {
  const [f, setF] = useState<{ v?: FeedAges; at: number }>();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    const tick = () => {
      setNow(Date.now());
      readFeeds()
        .then((v) => live && setF({ v, at: Date.now() }))
        // Before the first good read nothing shows; after it a failure keeps the last reading for a while.
        .catch(() => live && setF((old) => (old?.v && Date.now() - old.at >= KEEP_MS ? { at: old.at } : old)));
    };
    tick();
    const stop = everyVisible(tick, POLL_MS);
    return () => {
      live = false;
      stop();
    };
  }, []);
  if (!HAS_RPC) return null;
  // The chip's place is kept, empty, until the first read, so its arrival moves nothing.
  if (!f)
    return (
      <span className="chip peg-ticker peg-waiting oracle-chip" aria-hidden="true">
        Oracle <b>00m</b>
      </span>
    );
  const age = f.v ? Math.floor(now / 1000) - f.v.updated : 0;
  const level = f.v ? oracleLevel(age, f.v.maxAge) : "peg-bad";
  const limit = !f.v ? "" : f.v.maxAge % 3600 === 0 ? `${f.v.maxAge / 3600} hour${f.v.maxAge === 3600 ? "" : "s"}` : spoken(f.v.maxAge);
  const title = f.v
    ? `Price feeds last updated ${spoken(age)} ago; borrowing pauses when they are older than ${limit}`
    : "The price feeds could not be read";
  const body = (
    <>
      Oracle <b className={level}>{f.v ? ago(age) : "?"}</b>
    </>
  );
  return href ? (
    <a className="chip peg-ticker oracle-chip" href={href} title={title} aria-label={title}>
      {body}
    </a>
  ) : (
    <span className="chip peg-ticker oracle-chip" title={title}>
      {body}
      <span className="sr-only">: {title}</span>
    </span>
  );
}
