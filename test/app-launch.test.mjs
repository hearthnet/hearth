// The web app's launch transaction (app/launch.mjs) is one the market chain's
// policy (chain/policy.wasm, the module the market runs) accepts, at one host
// or several.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { context, validate } from "../policy/test/host.mjs";
import { launchAttempt, launchBody, launchTerms } from "../app/launch.mjs";
import { formatOffer, offerText } from "../client/records.mjs";
import { accountFromPrivateKey, encodeTransactionBody } from "../vendor/lattice-sdk.js";

const market = new WebAssembly.Module(readFileSync(new URL("../chain/policy.wasm", import.meta.url)));
const PATH = ["Nexus", "testnet", "lodger-3129cc"];
const key = (n) => accountFromPrivateKey(new Uint8Array(32).fill(n)).address;
const BUYER = key(1), HOST_A = key(2), HOST_B = key(3);
const offer = (price) => ({ parent: "Nexus/testnet", price, period: 1440n });
const payload = { spec: { premine: 0n, wasmPolicies: [] }, premineTo: null, modules: {}, genesisTransactions: [] };

const launch = (offers) => launchBody({ offers, buyer: BUYER, path: "Nexus/testnet/my-app", payload, periods: 7n, height: 100n, nonce: 4n, chainPath: PATH, fee: 1n });
const accepted = ({ body }) => validate(context(encodeTransactionBody(body).bytes, { path: PATH, height: 100n }), market);

test("the market accepts a launch at one host", () => {
  assert.ok(accepted(launch([[`${HOST_A}/a1`, offer(100n)]])));
});

test("the market accepts a launch at two hosts in one transaction, whichever order they were picked in", () => {
  for (const offers of [[[`${HOST_A}/a1`, offer(100n)], [`${HOST_B}/b1`, offer(120n)]], [[`${HOST_B}/b1`, offer(120n)], [`${HOST_A}/a1`, offer(100n)]]]) {
    const launched = launch(offers);
    assert.ok(accepted(launched));
    assert.equal(launched.keys.length, 2);
    assert.deepEqual(launched.body.accountActions.map((a) => [a.owner, a.delta]).slice(1).sort(), [[HOST_A, 700n], [HOST_B, 840n]].sort());
  }
});

test("a launch takes one offer per host", () => {
  assert.throws(() => launch([[`${HOST_A}/a1`, offer(100n)], [`${HOST_A}/a2`, offer(90n)]]), /one offer per host/);
});

// What a launch pays at: the version the buyer chose, still in force at the
// height the payment names, and never twice for the same chain at a host.
const TERMS = { parent: "Nexus/testnet", price: 100n, period: 1440n, until: 900n, capacity: 50n, maxBlockSize: 1000000n, maxStateGrowth: 1000000n,
  minTargetBlockTime: 5000n, maxNumberOfTransactionsPerBlock: 1000n, modules: "any" };
const K = `${HOST_A}/a1`;
const v1 = offerText(80n, formatOffer(TERMS)), v2 = offerText(90n, formatOffer({ ...TERMS, price: 150n }));
const terms = (height, { versions = new Map([[K, [v1, v2]]]), orders = [] } = {}) =>
  launchTerms({ chosen: [[K, v1]], versions, orders, buyer: BUYER, path: "Nexus/testnet/my-app", height });

test("a launch pays at the version the buyer chose while it is in force", () => {
  const [[k, offer]] = terms(95n);
  assert.equal(k, K);
  assert.equal(offer.price, 100n);
});

test("a launch aborts when a new version comes into force between the read and the payment", () => {
  // Read at 95 (v1 in force); v2, created at 90, is in force from 100 on.
  assert.throws(() => terms(100n), /changed its terms; review again/);
});

test("a launch aborts when the chosen version's offer has closed", () => {
  const closed = offerText(85n, formatOffer({ ...TERMS, until: 85n }));
  assert.throws(() => terms(96n, { versions: new Map([[K, [v1, closed]]]) }), /changed its terms/);
  assert.throws(() => terms(901n, { versions: new Map([[K, [v1]]]) }), /has closed/);
});

test("a launch refuses to pay again once the buyer's order for that path at that host has landed", () => {
  const landed = { host: HOST_A, path: "Nexus/testnet/my-app", buyer: BUYER };
  assert.throws(() => terms(95n, { orders: [landed] }), /already paid for Nexus\/testnet\/my-app/);
  // Someone else's order, or another path, is not this buyer's payment.
  assert.ok(terms(95n, { orders: [{ ...landed, buyer: HOST_B }, { ...landed, path: "Nexus/testnet/other" }] }));
});

test("a payment landing between an attempt's reads is never paid again with a fresh nonce", async () => {
  // A node whose first transaction lands right after the attempt's first
  // read: before it, nonce 4 and no order; after, nonce 5 and the order.
  const landed = { host: HOST_A, path: "Nexus/testnet/my-app", buyer: BUYER };
  let reads = 0;
  const state = () => (reads++ === 0 ? { nonce: 4n, orders: [] } : { nonce: 5n, orders: [landed] });
  const reader = {
    async account() { return { nonce: state().nonce }; },
    async market() { return { height: 95n, versions: new Map([[K, [v1, v2]]]), orders: state().orders }; },
  };
  const attempt = () => launchAttempt({ reader, market: PATH.join("/"), chosen: [[K, v1]], buyer: BUYER, path: "Nexus/testnet/my-app", payload, periods: 7n, chainPath: PATH, fee: async () => 1n });
  let signed;
  try { signed = await attempt(); } catch (e) { assert.match(e.message, /already paid/); }
  assert.ok(signed === undefined || signed.body.nonce === 4n, "never a fresh nonce");
});
