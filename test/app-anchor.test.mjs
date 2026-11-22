// Which block the buyer's page pins, and how the app names hosts that did not answer (app/anchor.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { uniqueNodes, chooseAnchor, disagreeMessage, CHECKPOINT_AFTER } from "../app/anchor.mjs";

test("node URLs are compared as the SDK compares them: case, default port, trailing and repeated slashes", () => {
  assert.deepEqual(uniqueNodes(sdk, ["https://A.example/", "https://a.example:443", "https://a.example//rpc//", "https://a.example/rpc", "not a url", "http://b.example"]),
    ["https://a.example", "https://a.example/rpc"]);
});

// A fake set of nodes: each `blocks` maps height → hash; missing nodes throw.
const fakeFetch = (nodes) => async (url) => {
  const u = new URL(url);
  const blocks = nodes[u.origin];
  if (!blocks) throw new Error("down");
  const at = u.pathname.split("/").pop();
  const height = at === "latest" ? BigInt(Math.max(...Object.keys(blocks).map(Number))) : BigInt(at);
  return { ok: true, json: async () => ({ height: String(height), hash: blocks[height] }) };
};
const chain = (top, tag = "") => Object.fromEntries(Array.from({ length: 10 }, (_, i) => [top - BigInt(i), `h${top - BigInt(i)}${tag}`]));

test("under CHECKPOINT_AFTER blocks the page pins genesis", async () => {
  const now = [{ node: "https://a.example", height: CHECKPOINT_AFTER - 1n, hash: "x" }];
  assert.deepEqual(await chooseAnchor({ now, chain: "C", genesis: "g", fetchImpl: fakeFetch({}) }), { genesis: "g" });
});

test("past it, the page pins the block most answering nodes report a few blocks below the lowest tip", async () => {
  const fetchImpl = fakeFetch({ "https://a.example": chain(2000n), "https://b.example": chain(1998n), "https://c.example": chain(2000n, "x") });
  const now = [{ node: "https://a.example", height: 2000n }, { node: "https://b.example", height: 1998n }, { node: "https://c.example", height: 2000n }, { node: "https://d.example", error: "down" }];
  assert.deepEqual(await chooseAnchor({ now, chain: "C", genesis: "g", fetchImpl }), { checkpoint: "h1992", height: 1992n });
});

test("a disagree names the hosts that did not answer and the minAgree: 1 trade-off", () => {
  const msg = disagreeMessage([{ node: "https://a.example", height: 5n }, { node: "https://b.example", error: "down" }]);
  assert.equal(msg, "Only 1 of 2 hosts answered (https://b.example didn't); reads need two to agree. Try again later, or use minAgree: 1 to trust https://a.example alone.");
  assert.match(disagreeMessage([{ node: "https://a.example", height: 5n }, { node: "https://b.example", height: 6n }]), /different tips/);
});
