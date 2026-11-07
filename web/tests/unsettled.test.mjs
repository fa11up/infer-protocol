// What a sent transaction can end as, and where a stopped leverage round stands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { settle } from "../src/unsettled.ts";
import { standing } from "../src/loopHalf.ts";

const A = "0xaa";
const B = "0xbb";
const client = (receipt, swap) => ({
  waitForTransactionReceipt: async ({ onReplaced }) => {
    if (swap) onReplaced({ reason: swap });
    if (receipt instanceof Error) throw receipt;
    return receipt;
  },
});

test("settle: a receipt says mined or reverted", async () => {
  assert.deepEqual(await settle(client({ status: "success", transactionHash: A }), A, 1), { kind: "mined", hash: A });
  assert.deepEqual(await settle(client({ status: "reverted", transactionHash: A }), A, 1), { kind: "reverted", hash: A });
});

test("settle: a timeout or failed lookup is unknown, never a failure", async () => {
  assert.deepEqual(await settle(client(Error("Timed out")), A, 1), { kind: "unknown", hash: A });
});

test("settle: a cancelled or replaced transaction did not run, even if the replacement succeeded", async () => {
  for (const reason of ["cancelled", "replaced"])
    assert.deepEqual(await settle(client({ status: "success", transactionHash: B }, reason), A, 1), { kind: "replaced", hash: B, reason });
});

test("settle: a copy at a new fee is the same action, under its new hash", async () => {
  assert.deepEqual(await settle(client({ status: "success", transactionHash: B }, "repriced"), A, 1), { kind: "mined", hash: B });
});

const swap = { at: "swap", amount: 5n };
const deposit = { at: "deposit", amount: 4n };
const round = [{ call: "draw", leaves: swap }, { call: "approve" }, { call: "swap", leaves: deposit }, { call: "lock" }];

test("standing: nothing landed leaves nothing to finish", () => {
  assert.equal(standing(round, 0), undefined);
});

test("standing: each landed step says what is left, and an approval changes nothing", () => {
  assert.deepEqual(standing(round, 1), swap);
  assert.deepEqual(standing(round, 2), swap);
  assert.deepEqual(standing(round, 3), deposit);
});

test("standing: a whole round leaves nothing, or what the next transactions need", () => {
  assert.equal(standing(round, 4), undefined);
  assert.deepEqual(standing([{ call: "free" }], 1, undefined, swap), swap);
});

test("standing: finishing a round keeps its place until a later step lands", () => {
  const rest = round.slice(1);
  assert.deepEqual(standing(rest, 0, swap), swap);
  assert.deepEqual(standing(rest, 1, swap), swap);
  assert.deepEqual(standing(rest, 2, swap), deposit);
});
