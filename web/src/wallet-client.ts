// The terminal's wallet client, in its own chunk (config.ts wallet() imports it on first use).
import { createWalletClient, custom, type Chain, type EIP1193Provider } from "viem";

export const walletClient = (chain: Chain, p: EIP1193Provider) => createWalletClient({ chain, transport: custom(p) });
