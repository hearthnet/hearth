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

const TERMS = "hashrate 1000\nthroughput 2\nstorage 3\nperiod 1440";
const offerKey = (host = HOST, id = "o1") => `offer/${host}/${id}`;
const assertOffer = (host = HOST, id = "o1") => ({ key: offerKey(host, id), oldValue: TERMS, newValue: TERMS });
const orderKey = ({ host = HOST, id = "o1", payer = BUYER, n = 0, paid = 50, path = "Nexus/testnet/app" } = {}) => `order/${host}/${id}/${payer}/${n}/${paid}/${path}`;
const create = (k = {}, value = "{}") => [assertOffer(k.host, k.id), { key: orderKey(k), newValue: value }];

test("an offer: the host writes, changes and deletes it", () => {
  assert.ok(accepts([{ key: offerKey(), newValue: TERMS }], { signers: [HOST] }));
  assert.ok(accepts([{ key: offerKey(), newValue: "anything at all" }], { signers: [HOST] }), "the value is not read");
  assert.ok(accepts([{ key: offerKey(), oldValue: TERMS, newValue: TERMS + "\n" }], { signers: [HOST] }), "changed");
  assert.ok(accepts([{ key: offerKey(), oldValue: TERMS }], { signers: [HOST] }), "deleted");
  assert.ok(!accepts([{ key: offerKey(), newValue: TERMS }], { signers: [BUYER] }), "not the host");
  assert.ok(!accepts([{ key: offerKey(), oldValue: TERMS, newValue: "x" }], { signers: [BUYER] }), "changed by someone else");
  assert.ok(!accepts([{ key: offerKey(), oldValue: TERMS }], { signers: [BUYER] }), "deleted by someone else");
  assert.ok(!accepts([{ key: `${offerKey()}/100`, newValue: TERMS }], { signers: [HOST] }), "extra segment");
  assert.ok(!accepts([{ key: `offer/${HOST}/`, newValue: TERMS }], { signers: [HOST] }), "empty id");
  assert.ok(!accepts([{ key: `offer/not-an-address/o1`, newValue: TERMS }], { signers: ["not-an-address"] }));
});

test("anyone may assert an offer unchanged", () => {
  assert.ok(accepts([assertOffer()], { signers: [BUYER] }));
  assert.ok(!accepts([{ key: offerKey(), newValue: TERMS }], { signers: [BUYER] }), "a write is not an assert");
});

test("an order: the payer writes it once, asserting the offer and crediting the host what its key says", () => {
  assert.ok(accepts(create(), { credits: [[HOST, 50n]] }));
  assert.ok(accepts(create({ paid: 120 }), { credits: [[HOST, 120n]] }));
  assert.ok(accepts(create(), { credits: [[HOST, 70n]] }), "overpaid");
  assert.ok(accepts(create({ n: 7 }), { credits: [[HOST, 50n]] }));
  assert.ok(accepts(create({ path: "Nexus/testnet/a/b" }), { credits: [[HOST, 50n]] }), "nested path");
  assert.ok(accepts(create({}, "renew"), { credits: [[HOST, 50n]] }), "the value is not read");
  assert.ok(accepts(create({ payer: OTHER }), { signers: [OTHER], credits: [[HOST, 50n]] }), "anyone can pay");
  assert.ok(accepts([{ key: orderKey(), newValue: "{}" }, assertOffer()], { credits: [[HOST, 50n]] }), "the assert may come after");
});

test("an order is refused when", () => {
  assert.ok(!accepts([{ key: orderKey(), newValue: "{}" }], { credits: [[HOST, 50n]] }), "the offer is not asserted");
  assert.ok(!accepts([assertOffer(HOST, "o2"), { key: orderKey(), newValue: "{}" }], { credits: [[HOST, 50n]] }), "another offer is asserted");
  assert.ok(!accepts([{ key: offerKey(), newValue: TERMS }, { key: orderKey(), newValue: "{}" }], { signers: [BUYER, HOST], credits: [[HOST, 50n]] }), "the offer is written, not asserted");
  assert.ok(!accepts(create(), { credits: [[HOST, 49n]] }), "the host is paid less");
  assert.ok(!accepts(create(), { credits: [[OTHER, 50n]] }), "someone else is paid");
  assert.ok(!accepts(create(), {}), "nobody is paid");
  assert.ok(!accepts(create({ paid: 0 }), {}), "nothing paid");
  assert.ok(!accepts(create({ paid: "050" }), { credits: [[HOST, 50n]] }), "non-canonical paid");
  assert.ok(!accepts(create({ n: "07" }), { credits: [[HOST, 50n]] }), "non-canonical n");
  assert.ok(!accepts(create({ paid: "18446744073709551616" }), { credits: [[HOST, 50n]] }), "paid past u64");
  assert.ok(!accepts(create(), { signers: [OTHER], credits: [[HOST, 50n]] }), "someone else signs for the payer");
  assert.ok(!accepts([assertOffer(), { key: orderKey(), oldValue: "{}", newValue: "{ }" }], { credits: [[HOST, 50n]] }), "changed");
  assert.ok(!accepts([assertOffer(), { key: orderKey(), oldValue: "{}" }], {}), "deleted");
  assert.ok(!accepts([assertOffer(), { key: `order/${HOST}/o1/${BUYER}/0/50`, newValue: "{}" }], { credits: [[HOST, 50n]] }), "no path");
  assert.ok(!accepts(create({ path: "Nexus//x" }), { credits: [[HOST, 50n]] }), "empty segment");
  assert.ok(!accepts(create({ path: "Nexus/x/" }), { credits: [[HOST, 50n]] }), "trailing slash");
  assert.ok(!accepts(create({ payer: "not-an-address" }), { signers: ["not-an-address"], credits: [[HOST, 50n]] }));
  assert.ok(!accepts([...create(), { key: "payload/x", newValue: "1" }], { credits: [[HOST, 50n]] }), "another key");
  assert.ok(!accepts([...create(), { key: `url/${HOST}`, newValue: "https://h" }], { signers: [BUYER, HOST], credits: [[HOST, 50n]] }), "url records are gone");
});

test("several orders in one transaction: each host's runs are credited in order", () => {
  const two = [...create(), { key: orderKey({ path: "Nexus/testnet/app2" }), newValue: "{}" }];
  assert.ok(accepts(two, { credits: [[HOST, 100n]] }), "two orders at one offer: one assert, one credit covers both");
  assert.ok(!accepts(two, { credits: [[HOST, 99n]] }));
  const hosts = [...create(), ...create({ host: HOST2, path: "Nexus/testnet/app2" })];
  assert.ok(accepts(hosts, { credits: [[HOST, 50n], [HOST2, 50n]] }), "two hosts, credited in order");
  assert.ok(!accepts(hosts, { credits: [[HOST2, 50n], [HOST, 50n]] }), "credits out of order");
  assert.ok(!accepts(hosts, { credits: [[HOST, 100n]] }), "one host paid for both");
});

test("coin, deposits and withdrawals pass", () => {
  assert.ok(accepts([], { credits: [[OTHER, 5n]] }));
});
