// The wallet for /build/: browser wallets announced through EIP-6963 (each with its own name and icon), else
// window.ethereum. Reads go to public Ethereum RPCs named in BUILD_RPCS, which the page's
// Content-Security-Policy admits (vite.config.ts) and nothing else of the chain. Loaded only when a visitor
// starts building, so the rest of imdusd.com still ships no chain code.
import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  http,
  type Address,
  type EIP1193Provider,
} from "viem";
import { mainnet } from "viem/chains";

export type Provider = EIP1193Provider;
export type WalletOption = { id: string; name: string; icon?: string; provider: Provider };

/** Public mainnet RPCs the page reads from; the CSP lists exactly these origins (vite.config.ts BUILD_CONNECT). */
export const BUILD_RPCS = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"];

let read: ReturnType<typeof makeRead> | null = null;
const makeRead = () =>
  createPublicClient({ chain: mainnet, transport: fallback(BUILD_RPCS.map((u) => http(u, { timeout: 10_000, retryCount: 1 }))) });
export const readClient = () => (read ??= makeRead());

/** Every wallet that answers within `ms`, else window.ethereum, else none. */
export function findWallets(ms = 300): Promise<WalletOption[]> {
  return new Promise((done) => {
    const found: WalletOption[] = [];
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent).detail as { info?: { uuid: string; name: string; icon?: string; rdns?: string }; provider?: Provider };
      if (!d?.info || !d.provider) return;
      const id = d.info.rdns || d.info.uuid;
      if (!found.some((x) => x.id === id))
        found.push({ id, name: d.info.name, icon: d.info.icon?.startsWith("data:image/") ? d.info.icon : undefined, provider: d.provider });
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const injected = (window as unknown as { ethereum?: Provider }).ethereum;
      done(found.length ? found : injected ? [{ id: "injected", name: "Browser wallet", provider: injected }] : []);
    }, ms);
  });
}

export async function connectAccount(p: Provider): Promise<Address> {
  const [a] = (await p.request({ method: "eth_requestAccounts" })) as Address[];
  if (!a) throw new Error("The wallet shared no account.");
  return a;
}

export async function personalSign(p: Provider, account: Address, message: string): Promise<`0x${string}`> {
  return (await p.request({ method: "personal_sign", params: [message as `0x${string}`, account] })) as `0x${string}`;
}

/** A wallet client on Ethereum, asking the wallet to switch first if it's on another chain. */
export async function walletClient(p: Provider, account: Address) {
  const id = Number(await p.request({ method: "eth_chainId" }));
  if (id !== mainnet.id) {
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] });
    } catch {
      throw new Error("Switch your wallet to Ethereum to pay.");
    }
  }
  return createWalletClient({ account, chain: mainnet, transport: custom(p) });
}
