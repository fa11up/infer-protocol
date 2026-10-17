import { useEffect, useSyncExternalStore } from "react";
import { fallback, http, getAddress } from "viem";
import { createReadClient } from "./read-client";
import { mainnet } from "viem/chains";
import rpcUrls from "./ens-rpc.json";
import { positionName } from "./history";

// ENS names live on Ethereum mainnet whatever chain the protocol runs on, so reverse lookups use
// their own client. The universal resolver only returns a name whose forward record points back
// at the address, so a name shown here is one the address owner set and controls.
const client = createReadClient({
  chain: mainnet,
  transport: fallback(
    rpcUrls.map((url: string) => http(url, { timeout: 6000, retryCount: 0 })),
  ),
  batch: { multicall: false },
});
const names = new Map<string, string | null>();
const queue: string[] = [];
const listeners = new Set<() => void>();
let version = 0;
let running = 0;
const MAX_IN_FLIGHT = 3;
function pump() {
  while (running < MAX_IN_FLIGHT && queue.length) {
    const key = queue.shift()!;
    running++;
    client
      .getEnsName({ address: getAddress(key) })
      .catch(() => null) // an unreachable resolver means "no name", never a failed page
      .then((name) => {
        names.set(key, name || null);
        version++;
        listeners.forEach((fn) => fn());
      })
      .finally(() => {
        running--;
        pump();
      });
  }
}
function request(address: string) {
  const key = address.toLowerCase();
  if (names.has(key) || queue.includes(key)) return;
  names.set(key, null); // provisional, so a re-render cannot queue it twice
  queue.push(key);
  pump();
}
/** The verified ENS name for an address, once known; undefined until then or if it has none. */
export function ensName(address?: string) {
  return address ? (names.get(address.toLowerCase()) ?? undefined) : undefined;
}
/** Subscribes the caller to ENS results and requests every address it is given. */
export function useEns(addresses: (string | undefined)[]) {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => version,
  );
  const key = addresses.filter(Boolean).join(",");
  useEffect(() => {
    addresses.forEach((a) => a && request(a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
/** ENS name when one resolves, else the deterministic readable label. */
export function displayName(address: string) {
  return ensName(address) ?? positionName(address);
}
/** ENS name, else a shortened address. */
export function Who({ address }: { address?: string }) {
  useEns([address]);
  if (!address) return <>—</>;
  const name = ensName(address);
  return (
    <span className={name ? "ens-name" : undefined} title={address}>
      {name ?? `${address.slice(0, 6)}…${address.slice(-4)}`}
    </span>
  );
}
