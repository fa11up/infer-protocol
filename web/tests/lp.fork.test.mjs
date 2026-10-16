// The LP window for real against a mainnet fork: approve through Permit2, mint a peg-pool position over the band,
// read it back as the window does (owner, pool, liquidity, amounts, fees), take half out, then burn the rest, through
// the real PositionManager and the live imdUSD/USDC pool. Skipped when no anvil fork answers on LP_RPC
// (default http://127.0.0.1:8545; `anvil --fork-url <mainnet rpc>`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, parseAbi, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { ERC20, IMDUSD, PEG_POOL_ID, STATE_VIEW, UNISWAP, USDC } from "../src/leverage.ts";
import {
  BAND,
  POSITION_MANAGER,
  POSITION_MANAGER_ABI,
  STATE_VIEW_LP,
  TICK_LOWER,
  TICK_UPPER,
  amountsForLiquidity,
  decodeInfo,
  encodeMint,
  encodeRemove,
  feesOwed,
  inPegPool,
  planAdd,
  saltOf,
} from "../src/lp.ts";

const RPC = process.env.LP_RPC ?? "http://127.0.0.1:8545";
const forked = await fetch(RPC, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
})
  .then((r) => r.json())
  .then((j) => j.result === "0x1")
  .catch(() => false);

const PERMIT2_ABI = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);

test("mint, read, take half, burn: a peg-pool position through the PositionManager", { skip: !forked && `no mainnet fork at ${RPC}` }, async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const me = account.address;
  const pub = createPublicClient({ chain: mainnet, transport: http(RPC, { timeout: 120_000 }) });
  const wal = createWalletClient({ account, chain: mainnet, transport: http(RPC, { timeout: 120_000 }) });
  await pub.request({ method: "anvil_setBalance", params: [me, "0x" + parseEther("10").toString(16)] });
  const send = async (req) => {
    const hash = await wal.writeContract(req);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", `${req.functionName} reverted`);
    return receipt;
  };
  const balance = (token) => pub.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [me] });
  // Give the account tokens by writing its balance slot: find the mapping's slot by trying the usual ones.
  const fund = async (token, amount) => {
    const hex = (n) => "0x" + n.toString(16).padStart(64, "0");
    for (let slot = 0n; slot < 12n; slot++) {
      const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [me, slot]));
      const before = await pub.request({ method: "eth_getStorageAt", params: [token, key, "latest"] });
      await pub.request({ method: "anvil_setStorageAt", params: [token, key, hex(amount)] });
      if ((await balance(token)) === amount) return;
      await pub.request({ method: "anvil_setStorageAt", params: [token, key, before] });
    }
    throw Error(`no balance slot found for ${token}`);
  };
  await fund(IMDUSD, 1_000n * 10n ** 18n);
  await fund(USDC, 1_000n * 10n ** 6n);

  const [sqrtP, tick] = await pub.readContract({ address: UNISWAP.stateView, abi: STATE_VIEW, functionName: "getSlot0", args: [PEG_POOL_ID] });
  console.log(`peg pool tick ${tick}, band ${TICK_LOWER}..${TICK_UPPER}`);
  const plan = planAdd(sqrtP, "imdusd", 100n * 10n ** 18n);
  assert.ok(plan, "no plan");

  // Approvals as the window sends them: token -> Permit2 (exact max), Permit2 -> PositionManager (30 min).
  const { timestamp } = await pub.getBlock();
  for (const [token, max] of [[IMDUSD, plan.imdusdMax], [USDC, plan.usdcMax]]) {
    await send({ address: token, abi: ERC20, functionName: "approve", args: [UNISWAP.permit2, max] });
    await send({ address: UNISWAP.permit2, abi: PERMIT2_ABI, functionName: "approve", args: [token, POSITION_MANAGER, max, Number(timestamp + 1800n)] });
  }
  const id = await pub.readContract({ address: POSITION_MANAGER, abi: POSITION_MANAGER_ABI, functionName: "nextTokenId" });
  const [s0, u0] = await Promise.all([balance(IMDUSD), balance(USDC)]);
  await send({ address: POSITION_MANAGER, abi: POSITION_MANAGER_ABI, functionName: "modifyLiquidities", args: [encodeMint(plan, me), timestamp + 1800n] });
  const [s1, u1] = await Promise.all([balance(IMDUSD), balance(USDC)]);
  console.log(`minted #${id}: ${Number(s0 - s1) / 1e18} imdUSD + ${Number(u0 - u1) / 1e6} USDC (planned ${Number(plan.imdusd) / 1e18} + ${Number(plan.usdc) / 1e6})`);
  // What the mint took is what the plan said, to the wei the pool rounds by.
  assert.ok(s0 - s1 <= plan.imdusd + 1n && s0 - s1 >= plan.imdusd - 1n);
  assert.ok(u0 - u1 <= plan.usdc + 1n && u0 - u1 >= plan.usdc - 1n);

  // Read back as the window does.
  const [owner, [, info], liquidity] = await Promise.all([
    pub.readContract({ address: POSITION_MANAGER, abi: POSITION_MANAGER_ABI, functionName: "ownerOf", args: [id] }),
    pub.readContract({ address: POSITION_MANAGER, abi: POSITION_MANAGER_ABI, functionName: "getPoolAndPositionInfo", args: [id] }),
    pub.readContract({ address: POSITION_MANAGER, abi: POSITION_MANAGER_ABI, functionName: "getPositionLiquidity", args: [id] }),
  ]);
  assert.equal(owner, me);
  assert.ok(inPegPool(info));
  assert.deepEqual([decodeInfo(info).tickLower, decodeInfo(info).tickUpper], [TICK_LOWER, TICK_UPPER]);
  assert.equal(liquidity, plan.liquidity);
  const [inside, [, last0, last1]] = await Promise.all([
    pub.readContract({ address: UNISWAP.stateView, abi: STATE_VIEW_LP, functionName: "getFeeGrowthInside", args: [PEG_POOL_ID, TICK_LOWER, TICK_UPPER] }),
    pub.readContract({ address: UNISWAP.stateView, abi: STATE_VIEW_LP, functionName: "getPositionInfo", args: [PEG_POOL_ID, POSITION_MANAGER, TICK_LOWER, TICK_UPPER, saltOf(id)] }),
  ]);
  assert.deepEqual(feesOwed(liquidity, inside, [last0, last1]), { imdusd: 0n, usdc: 0n });

  // Take half out.
  const { sqrtA, sqrtB } = BAND();
  const half = liquidity / 2n;
  const held = amountsForLiquidity(sqrtP, sqrtA, sqrtB, half);
  await send({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: "modifyLiquidities",
    args: [encodeRemove({ id, liquidity: half, all: false, min0: held.amount0, min1: held.amount1, to: me }), timestamp + 1800n],
  });
  const [s2, u2] = await Promise.all([balance(IMDUSD), balance(USDC)]);
  assert.ok(s2 - s1 >= held.amount0 - 1n && u2 - u1 >= held.amount1 - 1n);
  assert.equal(await pub.readContract({ address: POSITION_MANAGER, abi: POSITION_MANAGER_ABI, functionName: "getPositionLiquidity", args: [id] }), liquidity - half);

  // Collect only (a decrease of zero) goes through.
  await send({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: "modifyLiquidities",
    args: [encodeRemove({ id, liquidity: 0n, all: false, min0: 0n, min1: 0n, to: me }), timestamp + 1800n],
  });

  // Burn the rest: the NFT is gone and the tokens are back, less the pool's rounding.
  const rest = amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity - half);
  await send({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: "modifyLiquidities",
    args: [encodeRemove({ id, liquidity: liquidity - half, all: true, min0: rest.amount0, min1: rest.amount1, to: me }), timestamp + 1800n],
  });
  await assert.rejects(pub.readContract({ address: POSITION_MANAGER, abi: POSITION_MANAGER_ABI, functionName: "ownerOf", args: [id] }));
  const [s3, u3] = await Promise.all([balance(IMDUSD), balance(USDC)]);
  assert.ok(s0 - s3 <= 3n && u0 - u3 <= 3n, `lost ${s0 - s3} imdUSD wei, ${u0 - u3} USDC wei`);
});
