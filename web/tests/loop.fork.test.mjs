// The leverage loop, for real against a mainnet fork: one round up (borrow imdUSD, swap it through the peg pool,
// ETH/USDC and ETH/IMD to IMD, deposit it) and one round down (withdraw sIMD, unstake, swap back, repay), through
// the deployed vault, the real Universal Router and the real pools. Skipped when no anvil fork answers on
// LOOP_RPC (default http://127.0.0.1:8545; `anvil --fork-url <mainnet rpc>`). The feeds must be fresh at the fork.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { encodeSwap, minimumOut, NATIVE, PERMIT2, QUOTER, UNIVERSAL_ROUTER } from "../src/infer/swap.ts";
import {
  DOWN_PATH,
  ERC20,
  ETH_IMD_KEY,
  IMD,
  IMDUSD,
  PEG_POOL_CHECK,
  PEG_POOL_ID,
  QUOTER_PATH,
  SHARE,
  STATE_VIEW,
  UNISWAP,
  UP_PATH,
  downRound,
  encodePathSwap,
  maxDown,
  maxUp,
  PEG_FLOOR_USD,
  pegMarginalSell,
  pegQuoter,
  pegSellCap,
  upRound,
  usdAtSqrt,
} from "../src/leverage.ts";

const RPC = process.env.LOOP_RPC ?? "http://127.0.0.1:8545";
const forked = await fetch(RPC, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
})
  .then((r) => r.json())
  .then((j) => j.result === "0x1")
  .catch(() => false);

const VAULT = "0x0b69F8DA8D8cE521d74Ea69a7A3475B77302EF82";
const SIMD = "0x9Efa934D9fAd4AE28c998a40195646b965a97247";
const COLLATERAL_FEED = "0xF065C8b65AA9Ac6fd9cBAd15301738e91389d9e1";
const USD_FEED = "0x297b85afc6bbF9d9cCa636F7ED74c56DA79287A0";
const VAULT_ABI = parseAbi([
  "function lockIMD(uint256 assets)",
  "function draw(uint256 amount)",
  "function free(uint256 amount)",
  "function wipe(uint256 amount)",
  "function positions(address) view returns (uint256 collateral, uint256 debt)",
  "function debtOf(address) view returns (uint256)",
  "function collateralRatio(address) view returns (uint256)",
  "function mat() view returns (uint256)",
]);
const FEED = parseAbi(["function latestValue() view returns (uint256 value, uint256 updated)"]);

test("the peg pool key derives the live pool id", () => {
  assert.ok(PEG_POOL_CHECK(), `PEG_KEY does not hash to ${PEG_POOL_ID}`);
});

test("one round up and one round down through the deployed vault", { skip: !forked && `no mainnet fork at ${RPC}` }, async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const pub = createPublicClient({ chain: mainnet, transport: http(RPC, { timeout: 120_000 }) });
  const wal = createWalletClient({ account, chain: mainnet, transport: http(RPC, { timeout: 120_000 }) });
  await pub.request({ method: "anvil_setBalance", params: [account.address, "0x" + parseEther("10").toString(16)] });
  const send = async (req) => {
    const hash = await wal.writeContract(req);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", `${req.functionName} reverted`);
    // A new block between transactions, as on chain (sIMD refuses an unstake in the block it arrived).
    await pub.request({ method: "evm_mine", params: [] });
    return receipt;
  };
  const block = async () => (await pub.getBlock()).timestamp;
  // The live feeds go stale an hour after their last purchase; re-date them at their current values (slot 2 value,
  // slot 3 hasValue << 64 | updatedAt) so the round tests the loop, not the time since the last update.
  {
    const now = await block();
    const hex = (n) => "0x" + n.toString(16).padStart(64, "0");
    for (const feed of ["0x070e0603737242B01aBC1D223f7C92D63E86EC97", "0x77E1684402869Bf2B7c70B8bf21E1C7Ca7104951", "0x014DabF6F940c9C383D9ef48636F70D842F65D7A"]) {
      const [value] = await pub.readContract({ address: feed, abi: FEED, functionName: "latestValue" });
      await pub.request({ method: "anvil_setStorageAt", params: [feed, "0x2", hex(value)] });
      await pub.request({ method: "anvil_setStorageAt", params: [feed, "0x3", hex((1n << 64n) + now)] });
    }
    await pub.request({ method: "evm_mine", params: [] });
  }

  // IMD to start with: 0.3 ETH of it from the ETH/IMD pool.
  const ethIn = parseEther("0.3");
  const [q] = await pub.readContract({
    address: UNISWAP.quoter,
    abi: QUOTER,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: ETH_IMD_KEY, zeroForOne: true, exactAmount: ethIn, hookData: "0x" }],
  });
  const buy = encodeSwap({ key: ETH_IMD_KEY, tokenIn: NATIVE, amountIn: ethIn, minOut: minimumOut(q, 300) });
  await send({
    address: UNISWAP.universalRouter,
    abi: UNIVERSAL_ROUTER,
    functionName: "execute",
    args: [buy.commands, buy.inputs, (await block()) + 1200n],
    value: buy.value,
  });
  const imd = await pub.readContract({ address: IMD, abi: ERC20, functionName: "balanceOf", args: [account.address] });
  assert.ok(imd > 0n);

  // Deposit it all and open a small loan, as a borrower would before looping.
  await send({ address: IMD, abi: ERC20, functionName: "approve", args: [VAULT, imd] });
  await send({ address: VAULT, abi: VAULT_ABI, functionName: "lockIMD", args: [imd] });
  const read = async () => {
    const [[held], debt, [price], [imdUsd], rate, mat] = await Promise.all([
      pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "positions", args: [account.address] }),
      pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "debtOf", args: [account.address] }),
      pub.readContract({ address: COLLATERAL_FEED, abi: FEED, functionName: "latestValue" }),
      pub.readContract({ address: USD_FEED, abi: FEED, functionName: "latestValue" }),
      pub.readContract({ address: SIMD, abi: SHARE, functionName: "previewRedeem", args: [10n ** 18n] }),
      pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "mat" }),
    ]);
    return { held, debt, price, imdUsd, rate, mat };
  };
  let p = await read();
  assert.ok(p.held > 0n && p.debt === 0n);

  // ---- Round up --------------------------------------------------------------------------------------------
  const [sqrt] = await pub.readContract({ address: UNISWAP.stateView, abi: STATE_VIEW, functionName: "getSlot0", args: [PEG_POOL_ID] });
  const pegCap = await pegSellCap(pegQuoter(pub));
  console.log(`peg $${Number(usdAtSqrt(sqrt)) / 1e18}, sell cap ${Number(pegCap) / 1e18} imdUSD`);
  const borrow = maxUp({ held: p.held, debt: p.debt, price: p.price, floorBetween: p.mat + 10n, target: 220n, costBps: 300n, pegCap });
  assert.ok(borrow > 0n, "no room to borrow");
  const [imdOut] = await pub.readContract({
    address: UNISWAP.quoter,
    abi: QUOTER_PATH,
    functionName: "quoteExactInput",
    args: [{ exactCurrency: IMDUSD, path: UP_PATH, exactAmount: borrow }],
  });
  const pegAfter = await pegMarginalSell(pegQuoter(pub), borrow);
  assert.ok(pegAfter >= PEG_FLOOR_USD, `the round's last imdUSD sells at ${pegAfter}`);
  const up = upRound({ borrow, imdOut, slippageBps: 100n, ...p, pegAfter });
  console.log(
    `up: borrow ${Number(borrow) / 1e18} imdUSD -> ${Number(imdOut) / 1e18} IMD, cost ${Number(up.costBps) / 100}%, ` +
      `CR between ${up.crBetween}% after ${up.crAfter}%, peg after ~$${Number(up.pegAfter) / 1e18}`,
  );
  assert.ok(up.crBetween >= p.mat + 10n);
  assert.ok(up.crAfter >= 215n, `crAfter ${up.crAfter}`);

  const swapUp = encodePathSwap({ currencyIn: IMDUSD, path: UP_PATH, amountIn: borrow, minOut: up.minImd });
  const deadline = (await block()) + 1800n;
  await send({ address: VAULT, abi: VAULT_ABI, functionName: "draw", args: [borrow] });
  await send({ address: IMDUSD, abi: ERC20, functionName: "approve", args: [UNISWAP.permit2, borrow] });
  await send({ address: UNISWAP.permit2, abi: PERMIT2, functionName: "approve", args: [IMDUSD, UNISWAP.universalRouter, borrow, Number(deadline)] });
  await send({
    address: UNISWAP.universalRouter,
    abi: UNIVERSAL_ROUTER,
    functionName: "execute",
    args: [swapUp.commands, swapUp.inputs, deadline],
  });
  await send({ address: IMD, abi: ERC20, functionName: "approve", args: [VAULT, up.minImd] });
  await send({ address: VAULT, abi: VAULT_ABI, functionName: "lockIMD", args: [up.minImd] });
  const afterUp = await read();
  const cr = await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "collateralRatio", args: [account.address] });
  console.log(`after up: CR ${cr}% (planned ${up.crAfter}%)`);
  assert.ok(afterUp.debt >= borrow);
  // Planned from the minimum; the swap delivers at least that, and the price did not move: at most a point apart.
  assert.ok(cr >= up.crAfter - 1n && cr <= up.crAfter + 2n, `CR ${cr} vs planned ${up.crAfter}`);
  const left = await pub.readContract({ address: IMDUSD, abi: ERC20, functionName: "balanceOf", args: [account.address] });
  assert.equal(left, 0n, "the whole borrow was swapped");

  // ---- Round down ------------------------------------------------------------------------------------------
  p = afterUp;
  const withdraw = maxDown({ held: p.held, debt: p.debt, price: p.price, floorBetween: p.mat + 10n, costBps: 300n });
  assert.ok(withdraw > 0n);
  await send({ address: VAULT, abi: VAULT_ABI, functionName: "free", args: [withdraw] });
  const imdIn = await pub.readContract({ address: SIMD, abi: SHARE, functionName: "previewRedeem", args: [withdraw] });
  const [imdusdOut] = await pub.readContract({
    address: UNISWAP.quoter,
    abi: QUOTER_PATH,
    functionName: "quoteExactInput",
    args: [{ exactCurrency: IMD, path: DOWN_PATH, exactAmount: imdIn }],
  });
  const down = downRound({ withdraw, imdIn, imdusdOut, slippageBps: 100n, ...p });
  console.log(
    `down: withdraw ${withdraw} sIMD = ${Number(imdIn) / 1e18} IMD -> ${Number(imdusdOut) / 1e18} imdUSD, ` +
      `cost ${Number(down.costBps) / 100}%, repay ${Number(down.repay) / 1e18}, CR between ${down.crBetween}%`,
  );
  await send({ address: SIMD, abi: SHARE, functionName: "redeem", args: [withdraw, account.address, account.address] });
  const d2 = (await block()) + 1800n;
  const swapDown = encodePathSwap({ currencyIn: IMD, path: DOWN_PATH, amountIn: imdIn, minOut: down.minImdusd });
  await send({ address: IMD, abi: ERC20, functionName: "approve", args: [UNISWAP.permit2, imdIn] });
  await send({ address: UNISWAP.permit2, abi: PERMIT2, functionName: "approve", args: [IMD, UNISWAP.universalRouter, imdIn, Number(d2)] });
  await send({
    address: UNISWAP.universalRouter,
    abi: UNIVERSAL_ROUTER,
    functionName: "execute",
    args: [swapDown.commands, swapDown.inputs, d2],
  });
  const have = await pub.readContract({ address: IMDUSD, abi: ERC20, functionName: "balanceOf", args: [account.address] });
  assert.ok(have >= down.repay, `received ${have}, repaying ${down.repay}`);
  await send({ address: VAULT, abi: VAULT_ABI, functionName: "wipe", args: [down.repay] });
  const afterDown = await read();
  console.log(`after down: debt ${Number(afterDown.debt) / 1e18} imdUSD (was ${Number(p.debt) / 1e18})`);
  assert.ok(afterDown.debt < p.debt);
});
