// A read-only viem client with only the actions the imdusd.com pages call. createPublicClient attaches every public
// action, and with them code no page here runs (signature, SIWE and typed-data verification, with their elliptic-curve
// libraries): about a third of viem's weight in the first load. Each action is viem's own, bound as
// createPublicClient binds it, so a call behaves exactly as before; a page that needs another action adds it here.
import { createClient, type Chain, type Client, type ClientConfig, type PublicActions, type Transport } from "viem";
import {
  call,
  getBalance,
  getBlock,
  getBlockNumber,
  getChainId,
  getCode,
  getEnsName,
  getLogs,
  getStorageAt,
  multicall,
  readContract,
  simulateContract,
  waitForTransactionReceipt,
} from "viem/actions";

const ACTIONS = {
  call,
  getBalance,
  getBlock,
  getBlockNumber,
  getChainId,
  getCode,
  getEnsName,
  getLogs,
  getStorageAt,
  multicall,
  readContract,
  simulateContract,
  waitForTransactionReceipt,
};
export type ReadClient<C extends Chain = Chain> = Client<Transport, C> &
  Pick<PublicActions<Transport, C>, keyof typeof ACTIONS>;

export function createReadClient<C extends Chain>(config: ClientConfig<Transport, C>): ReadClient<C> {
  const client = createClient(config);
  return client.extend((c) =>
    Object.fromEntries(
      Object.entries(ACTIONS).map(([name, action]) => [
        name,
        (args: unknown) => (action as (c: unknown, a: unknown) => unknown)(c, args),
      ]),
    ),
  ) as unknown as ReadClient<C>;
}
