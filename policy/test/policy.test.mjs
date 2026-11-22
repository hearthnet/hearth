// Runs the built policy module the way the Lattice host does (host.mjs).
//
//   cargo build --release --target wasm32-unknown-unknown
//   node --test test/policy.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { context, validate } from "./host.mjs";
import { accountFromPrivateKey, encodeTransactionBody } from "../../vendor/lattice-sdk.js";

const key = (n) => accountFromPrivateKey(new Uint8Array(32).fill(n)).address;
const HOST = key(1);
const BUYER = key(2);
const OTHER = key(3);
const HOST2 = key(4);
const PATH = ["Nexus", "testnet", "hosts"];
const HEIGHT = 100n;

function accepts(actions, { signers = [BUYER], credits = [], debits, height = HEIGHT } = {}) {
  const total = credits.reduce((sum, [, amount]) => sum + amount, 0n);
  const accountActions = [
    ...(debits ?? (total ? [[signers[0], -total]] : [])).map(([owner, delta]) => ({ owner, delta })),
    ...credits.map(([owner, delta]) => ({ owner, delta })),
  ];
  const { bytes } = encodeTransactionBody({
    accountActions, actions, depositActions: [], receiptActions: [], withdrawalActions: [],
    signers, nonce: 1n, chainPath: PATH,
  });
  return validate(context(bytes, { path: PATH, height }));
}

const offerKey = (host = HOST, at = 100) => `offer/${host}/o1/${at}`;
const orderKey = ({ host = HOST, payer = BUYER, at = 100, paid = 50, path = "Nexus/testnet/app" } = {}) => `order/${host}/o1/${payer}/${at}/${paid}/${path}`;
const create = (k = {}, value = "{}") => [{ key: orderKey(k), newValue: value }];

test("an offer: the host writes it once, its height within the last 10 blocks", () => {
  const terms = "parent Nexus/testnet\nprice 50";
  assert.ok(accepts([{ key: offerKey(), newValue: terms }], { signers: [HOST] }));
  assert.ok(accepts([{ key: offerKey(HOST, 90), newValue: terms }], { signers: [HOST] }));
  assert.ok(accepts([{ key: offerKey(), newValue: "anything at all" }], { signers: [HOST] }), "the value is not read");
  assert.ok(!accepts([{ key: offerKey(HOST, 89), newValue: terms }], { signers: [HOST] }), "too old");
  assert.ok(!accepts([{ key: offerKey(HOST, 101), newValue: terms }], { signers: [HOST] }), "in the future");
  assert.ok(!accepts([{ key: `offer/${HOST}/o1/0100`, newValue: terms }], { signers: [HOST] }), "non-canonical height");
  assert.ok(!accepts([{ key: offerKey(), newValue: terms }], { signers: [BUYER] }), "not the host");
  assert.ok(!accepts([{ key: offerKey(), oldValue: terms, newValue: terms + "\n" }], { signers: [HOST] }), "changed");
  assert.ok(!accepts([{ key: offerKey(), oldValue: terms }], { signers: [HOST] }), "deleted");
  assert.ok(!accepts([{ key: `${offerKey()}/x`, newValue: terms }], { signers: [HOST] }), "extra segment");
  assert.ok(!accepts([{ key: `offer/${HOST}/o1`, newValue: terms }], { signers: [HOST] }), "no height");
  assert.ok(!accepts([{ key: `offer/${HOST}//100`, newValue: terms }], { signers: [HOST] }), "empty id");
  assert.ok(!accepts([{ key: `offer/not-an-address/o1/100`, newValue: terms }], { signers: ["not-an-address"] }));
  assert.ok(accepts([{ key: offerKey(HOST, 5), newValue: terms }], { signers: [HOST], height: 5n }), "early chain");
});

test("a url: the host writes, changes and removes it", () => {
  assert.ok(accepts([{ key: `url/${HOST}`, newValue: "https://h.example" }], { signers: [HOST] }));
  assert.ok(accepts([{ key: `url/${HOST}`, oldValue: "https://a", newValue: "https://b" }], { signers: [HOST] }));
  assert.ok(accepts([{ key: `url/${HOST}`, oldValue: "https://a" }], { signers: [HOST] }));
  assert.ok(!accepts([{ key: `url/${HOST}`, newValue: "https://evil" }], { signers: [BUYER] }));
  assert.ok(!accepts([{ key: `url/${HOST}/x`, newValue: "https://h" }], { signers: [HOST] }));
});

test("an order: the payer writes it once, crediting the host what its key says", () => {
  assert.ok(accepts(create(), { credits: [[HOST, 50n]] }));
  assert.ok(accepts(create({ paid: 120 }), { credits: [[HOST, 120n]] }));
  assert.ok(accepts(create(), { credits: [[HOST, 70n]] }), "overpaid");
  assert.ok(accepts(create({ at: 90 }), { credits: [[HOST, 50n]] }));
  assert.ok(accepts(create({ path: "Nexus/testnet/a/b" }), { credits: [[HOST, 50n]] }), "nested path");
  assert.ok(accepts(create({}, "renew"), { credits: [[HOST, 50n]] }), "the value is not read");
  assert.ok(accepts(create({ payer: OTHER }), { signers: [OTHER], credits: [[HOST, 50n]] }), "anyone can pay");
});

test("an order is refused when", () => {
  assert.ok(!accepts(create(), { credits: [[HOST, 49n]] }), "the host is paid less");
  assert.ok(!accepts(create(), { credits: [[OTHER, 50n]] }), "someone else is paid");
  assert.ok(!accepts(create(), {}), "nobody is paid");
  assert.ok(!accepts(create({ paid: 0 }), {}), "nothing paid");
  assert.ok(!accepts(create({ paid: "050" }), { credits: [[HOST, 50n]] }), "non-canonical paid");
  assert.ok(!accepts(create({ paid: "18446744073709551616" }), { credits: [[HOST, 50n]] }), "paid past u64");
  assert.ok(!accepts(create({ at: 89 }), { credits: [[HOST, 50n]] }), "too old");
  assert.ok(!accepts(create({ at: 101 }), { credits: [[HOST, 50n]] }), "in the future");
  assert.ok(!accepts(create(), { signers: [OTHER], credits: [[HOST, 50n]] }), "someone else signs for the payer");
  assert.ok(!accepts([{ key: orderKey(), oldValue: "{}", newValue: "{ }" }], { credits: [[HOST, 50n]] }), "changed");
  assert.ok(!accepts([{ key: orderKey(), oldValue: "{}" }], {}), "deleted");
  assert.ok(!accepts([{ key: `order/${HOST}/o1/${BUYER}/100/50`, newValue: "{}" }], { credits: [[HOST, 50n]] }), "no path");
  assert.ok(!accepts(create({ path: "Nexus//x" }), { credits: [[HOST, 50n]] }), "empty segment");
  assert.ok(!accepts(create({ path: "Nexus/x/" }), { credits: [[HOST, 50n]] }), "trailing slash");
  assert.ok(!accepts(create({ payer: "not-an-address" }), { signers: ["not-an-address"], credits: [[HOST, 50n]] }));
  assert.ok(!accepts([...create(), { key: "payload/x", newValue: "1" }], { credits: [[HOST, 50n]] }), "another key");
});

test("several orders in one transaction: each host's runs are credited in order", () => {
  const two = [...create(), ...create({ path: "Nexus/testnet/app2" })];
  assert.ok(accepts(two, { credits: [[HOST, 100n]] }), "two orders from one host: one credit covers both");
  assert.ok(!accepts(two, { credits: [[HOST, 99n]] }));
  const hosts = [...create(), ...create({ host: HOST2, path: "Nexus/testnet/app2" })];
  assert.ok(accepts(hosts, { credits: [[HOST, 50n], [HOST2, 50n]] }), "two hosts, credited in order");
  assert.ok(!accepts(hosts, { credits: [[HOST2, 50n], [HOST, 50n]] }), "credits out of order");
  assert.ok(!accepts(hosts, { credits: [[HOST, 100n]] }), "one host paid for both");
});

test("coin, deposits and withdrawals pass", () => {
  assert.ok(accepts([], { credits: [[OTHER, 5n]] }));
});
