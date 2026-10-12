import { test } from "node:test";
import assert from "node:assert/strict";
import { computePoints } from "./engine.ts";
import { lpEvents, type TxTransfer } from "./lp.ts";

const WAD = 10n ** 18n;
const PM = "0x000000000004444c5dc75cb358380d2e3de08a90";
const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const DAY = 7_200;
let n = 0;
const t = (from: string, to: string, whole: number, block: number, tx: string): TxTransfer => ({ from, to, value: BigInt(whole) * WAD, block, logIndex: n++, tx });

test("deposits count as liquidity, withdrawals reduce it, swaps through the PoolManager do not", () => {
  const transfers = [
    t(A, PM, 100, 10, "0xadd"), // A provides 100
    t(B, PM, 50, 20, "0xswap"), // B swaps imdUSD in: not liquidity
    t(PM, A, 40, 30, "0xremove"), // A takes 40 out
    t(PM, A, 500, 40, "0xremove2"), // more than A put in: floors at zero
  ];
  const ev = lpEvents(transfers, new Set(["0xADD", "0xremove", "0xremove2"]), PM);
  assert.deepEqual(ev.map((e) => [e.owner, e.value / WAD, e.block]), [[A, 100n, 10], [A, 60n, 30], [A, 0n, 40]]);
});

test("a provider earns the LP rate on what it deposited, and nothing for holding it meanwhile", () => {
  const transfers = [t("0x0000000000000000000000000000000000000000", A, 100, 0, "0xmint"), t(A, PM, 100, 0, "0xadd")];
  const events = [
    ...transfers.map((x) => ({ kind: "transfer" as const, from: x.from, to: x.to, value: x.value, block: x.block, logIndex: x.logIndex })),
    ...lpEvents(transfers, new Set(["0xadd"]), PM),
  ];
  const r = computePoints(events, { startBlock: 0, endBlock: DAY, blocksPerDay: DAY, lpBps: 30_000, excluded: [PM] });
  const a = r.accounts.find((x) => x.owner === A)!;
  assert.equal(a.held, 0n);
  assert.equal(a.lp, 100n * WAD);
  assert.equal(a.holdPoints, 0n);
  assert.equal(a.lpPoints, 300n * WAD * BigInt(DAY));
});
