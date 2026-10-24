import { http, type Transport } from "viem";

/** Hosts whose Worker serves /rpc for mainnet (worker/index.js). */
export const OWN_RPC_HOSTS = ["imdusd.com"];

/** On imdusd.com, the site's own /rpc first (cached for every visitor, JSON-RPC batches of at most 20 calls, the
 * Worker's limit), then the given public RPCs; elsewhere (local dev, previews) the public RPCs alone. A mainnet client
 * only: /rpc serves the mainnet deployment. Every contract such a client calls must appear in the site's source, or
 * /rpc refuses it (the build allowlists every address in src/). */
export function ownRpcFirst(urls: string[], timeout: number): Transport[] {
  const own = typeof location !== "undefined" && OWN_RPC_HOSTS.includes(location.hostname)
    ? [http(new URL("/rpc", location.origin).href, { timeout, retryCount: 0, batch: { batchSize: 20, wait: 16 } })]
    : [];
  return [...own, ...urls.map((url) => http(url, { timeout, retryCount: 0 }))];
}
