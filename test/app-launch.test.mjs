// The web app's launch transaction (app/launch.mjs) is one the v3.1 market's
// policy (chain/policy-v31.wasm, the module the market runs) accepts, at one
// host or several, and is judged owed from the block it lands in.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { context, validate } from "../policy/test/host.mjs";
import { chosenTerms, heldCheck, launchAttempt, launchBody, launchCheck, offersFor } from "../app/launch.mjs";
import { formatOffer, parseOffer, parseOrderKey } from "../client/records.mjs";
import { judge } from "../client/verdict.mjs";
import { mint } from "./minted.mjs";

const market = new WebAssembly.Module(readFileSync(new URL("../chain/policy-v31.wasm", import.meta.url)));
const PATH = ["Nexus", "testnet", "hearth"];
const key = (n) => sdk.accountFromPrivateKey(new Uint8Array(32).fill(n)).address;
const BUYER = key(1), HOST_A = key(2), HOST_B = key(3);
const terms = (price, under = ["Nexus", "Nexus/testnet"]) => formatOffer({ hashrate: 1000n, price, period: 1440n, throughput: 200000n, storage: 1000000n, blocks: HOST_A, under });
const APP = "Nexus/testnet/my-app";
const VALUE = "{}";

const launch = (chosen, path = APP) => launchBody({ chosen, payer: BUYER, nonce: 4n, path, value: VALUE, periods: 7n, chainPath: PATH, fee: 1n });
const accepted = ({ body }) => validate(context(sdk.encodeTransactionBody(body).bytes, { path: PATH, height: 100n }), market);

test("the market accepts a launch at one host", () => {
  const launched = launch([{ host: HOST_A, id: "a1", terms: terms(10n) }]);
  assert.ok(accepted(launched));
  assert.equal(launched.paid, 10n * 7n, "the offer's price for each period, the ordered chain alone");
  assert.deepEqual(parseOrderKey(launched.keys[0]), { host: HOST_A, id: "a1", payer: BUYER, n: 4n, paid: launched.paid, path: APP });
});

test("the market accepts a launch at two hosts in one transaction, whichever order they were picked in", () => {
  const a = { host: HOST_A, id: "a1", terms: terms(10n) }, b = { host: HOST_B, id: "b1", terms: terms(20n) };
  for (const chosen of [[a, b], [b, a]]) {
    const launched = launch(chosen);
    assert.ok(accepted(launched));
    assert.equal(launched.keys.length, 2);
    assert.deepEqual(launched.body.accountActions.slice(1).map((x) => [x.owner, x.delta]).sort(), [[HOST_A, 70n], [HOST_B, 140n]].sort());
  }
});

test("the market refuses a launch whose payment is short of what its key says", () => {
  const { body } = launch([{ host: HOST_A, id: "a1", terms: terms(10n) }]);
  body.accountActions[1].delta -= 1n;
  body.accountActions[0].delta += 1n;
  assert.ok(!validate(context(sdk.encodeTransactionBody(body).bytes, { path: PATH, height: 100n }), market));
});

test("the market refuses a launch under a parent the offer does not sell under", () => {
  assert.ok(!accepted(launch([{ host: HOST_A, id: "a1", terms: terms(10n, ["Nexus"]) }])), "Nexus/testnet is not listed");
  assert.ok(accepted(launch([{ host: HOST_A, id: "a1", terms: terms(10n, ["Nexus"]) }], "Nexus/my-app")));
  assert.ok(!accepted(launch([{ host: HOST_A, id: "a1", terms: terms(10n) }], "Nexus/testnet/my-app/deeper")), "a grandchild");
});

test("the buyer is shown only offers selling under its chain's parent that take its spec, cheapest a market block first", () => {
  const offer = (price, period, more = {}) => ({ ...parseOffer(terms(price)), period, ...more });
  const all = new Map([
    [`${HOST_A}/cheap`, offer(10n, 100n)],
    [`${HOST_A}/dear`, offer(10n, 10n)],
    [`${HOST_B}/elsewhere`, offer(1n, 100n, { under: ["Nexus"] })],
    [`${HOST_B}/slow`, offer(1n, 100n, { throughput: 666n })],
    [`${HOST_B}/small`, offer(1n, 100n, { storage: 9999n })],
  ]);
  const spec = { maxBlockSize: 20000, targetBlockTime: 30000, maxStateGrowth: 10000 };  // 666.67 bytes a second
  assert.deepEqual(offersFor({ terms: all, parent: "Nexus/testnet", spec }).map((x) => [x.id, x.price]), [["cheap", 10n], ["dear", 10n]]);
  assert.deepEqual(offersFor({ terms: all, parent: "Nexus", spec }).map((x) => x.id), ["elsewhere", "cheap", "dear"]);
  assert.deepEqual(offersFor({ terms: new Map([["h/x", offer(1n, 1n, { throughput: 667n, storage: 10000n })]]), parent: "Nexus/testnet", spec }).map((x) => x.id), ["x"], "limits are inclusive, compared without rounding");
});

test("a launch takes one offer per host", () => {
  assert.throws(() => launch([{ host: HOST_A, id: "a1", terms: terms(10n) }, { host: HOST_A, id: "a2", terms: terms(9n) }]), /one offer per host/);
});

const K = `${HOST_A}/a1`;
const check = ({ offers = new Map([[K, terms(10n)]]), orders = [] } = {}) =>
  launchCheck({ chosen: [{ host: HOST_A, id: "a1", terms: terms(10n) }], offers, orders, payer: BUYER, path: APP });

test("a launch pays only the terms the buyer saw, while the offer stands", () => {
  assert.doesNotThrow(() => check());
  assert.throws(() => check({ offers: new Map([[K, terms(11n)]]) }), /changed its terms/);
  assert.throws(() => check({ offers: new Map() }), /has closed/);
});

test("a launch refuses to pay again once the buyer's order for that path at that host has landed", () => {
  const landed = { host: HOST_A, path: APP, payer: BUYER, value: VALUE };
  assert.throws(() => check({ orders: [landed] }), /already paid for Nexus\/testnet\/my-app/);
  // Someone else's order, another path, or a renewal is not this buyer's launch.
  assert.doesNotThrow(() => check({ orders: [{ ...landed, payer: HOST_B }, { ...landed, path: "Nexus/testnet/other" }, { ...landed, value: "renew" }] }));
});

test("a payment landing between an attempt's reads is never paid again with a fresh nonce", async () => {
  // A node whose first transaction lands right after the attempt's first
  // read: before it, nonce 4 and no order; after, nonce 5 and the order.
  const landed = { host: HOST_A, path: APP, payer: BUYER, value: VALUE };
  let reads = 0;
  const state = () => (reads++ === 0 ? { nonce: 4n, orders: [] } : { nonce: 5n, orders: [landed] });
  const reader = {
    async account() { return { nonce: state().nonce }; },
    async market() { return { offers: new Map([[K, terms(10n)]]), orders: state().orders }; },
  };
  const attempt = () => launchAttempt({ reader, market: PATH.join("/"), chosen: [{ host: HOST_A, id: "a1", terms: terms(10n) }], payer: BUYER, path: APP, value: VALUE, periods: 7n, chainPath: PATH, fee: async () => 1n });
  let signed;
  try { signed = await attempt(); } catch (e) { assert.match(e.message, /already paid/); }
  assert.ok(signed === undefined || signed.body.nonce === 4n, "never a fresh nonce");
});

test("a launch that lands is owed from that block for the periods it paid", () => {
  const { value } = mint(APP);
  const t = terms(10n);
  const { keys } = launchBody({ chosen: [{ host: HOST_A, id: "a1", terms: t }], payer: BUYER, nonce: 4n, path: APP, value, periods: 3n, chainPath: PATH, fee: 1n });
  const order = { key: keys[0], ...parseOrderKey(keys[0]), value, landed: 50n, terms: t };
  const [verdict] = judge({ sdk, height: 60n, orders: [order], market: PATH.join("/") }).values();
  assert.equal(verdict.kind, "owed");
  assert.equal(verdict.from, 50n);
  assert.equal(verdict.until, 50n + 3n * 1440n);
});

test("a launch signs exactly the offer text the buyer was shown, or stops", () => {
  const shownText = terms(10n), k = `${HOST_A}/a1`;
  const offers = [{ k, host: HOST_A, id: "a1" }];
  const shown = new Map([[k, shownText]]);
  assert.deepEqual(chosenTerms({ offers, shown, now: new Map([[k, shownText]]) }), [{ host: HOST_A, id: "a1", terms: shownText }]);
  // The same period and price, another hash rate or reward address: still new terms.
  const other = formatOffer({ ...parseOffer(shownText), hashrate: 999n, blocks: HOST_B });
  assert.throws(() => chosenTerms({ offers, shown, now: new Map([[k, other]]) }), /has new terms/);
  assert.throws(() => chosenTerms({ offers, shown, now: new Map() }), /has closed/);
});

test("a launch stops before paying a host whose offer holds the path for another genesis still paid for", () => {
  const holder = { key: "k", host: HOST_A, id: "a1", path: APP, payer: HOST_B };
  const chosen = [{ host: HOST_A, id: "a1" }];
  const owed = (active) => new Map([["k", { kind: "owed", active, until: 500n }]]);
  assert.throws(() => heldCheck({ chosen, orders: [holder], verdicts: owed(true), path: APP }), /hosts another genesis of Nexus\/testnet\/my-app until market block 500/);
  assert.doesNotThrow(() => heldCheck({ chosen, orders: [holder], verdicts: owed(false), path: APP }), "its paid time ended");
  assert.doesNotThrow(() => heldCheck({ chosen: [{ host: HOST_B, id: "a1" }], orders: [holder], verdicts: owed(true), path: APP }), "another host");
});
