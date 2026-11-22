// Storage offers and the checks that an offer's address is the host's.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { formatHostURL, formatOffer, formatStorageOffer, offerText, orderKey, parseHostURL, parseStorageOffer, storageOrderValue, SETTLE } from "../client/records.mjs";
import { judge, judgeStorage } from "../client/verdict.mjs";
import { storageOrderWrite } from "../client/tx.mjs";
import { hostVouches, storageVouches } from "../client/vouch.mjs";

const key = (n) => sdk.accountFromPrivateKey(new Uint8Array(32).fill(n)).address;
const HOST = key(1), A = key(2), IMPOSTOR = key(9);
const ROOT = (n) => sdk.cidV1DagCbor(sdk.encodeDagCbor({ n }));
const STORAGE = { created: 100n, sponsor: "https://host.example:8650/sponsor", bytesPerCoin: 1000n, capacity: 5000n, until: 100000n };
const HOSTING = { created: 100n, parent: "Nexus/testnet", price: 50n, period: 1440n, until: 100000n, capacity: 2n,
  maxBlockSize: 100000n, maxStateGrowth: 100000n, minTargetBlockTime: 1000n, maxNumberOfTransactionsPerBlock: 100n, modules: "any" };
const offers = new Map([
  [`${HOST}/s`, offerText(STORAGE.created, formatStorageOffer(STORAGE))],
  [`${HOST}/h`, offerText(HOSTING.created, formatOffer(HOSTING))],
]);
const order = ({ root = ROOT(1), bytes = 2000n, paid = 2n, created = 200n, id = "s", value = storageOrderValue(bytes) } = {}) =>
  ({ key: orderKey({ host: HOST, id, payer: A, height: created, paid, path: root }), host: HOST, id, payer: A, buyer: A, created, paid, path: root, payloadText: value });
const kinds = (orders, height = 1000n) => { const v = judgeStorage({ height, offers, orders }); return orders.map((o) => v.get(o.key)?.kind); };

test("a storage offer round-trips and parses strictly", () => {
  const text = offerText(STORAGE.created, formatStorageOffer(STORAGE));
  assert.deepEqual(parseStorageOffer(text), { ...STORAGE, kind: "storage" });
  assert.equal(parseStorageOffer(text.replace("https://", "http://")), undefined, "a sponsor off https");
  assert.equal(parseStorageOffer(text.replace("bytesPerCoin 1000", "bytesPerCoin 0")), undefined);
  assert.equal(parseStorageOffer(text + "\n"), undefined);
  assert.equal(parseStorageOffer(offers.get(`${HOST}/h`)), undefined, "a hosting offer is not a storage offer");
});

test("a paid storage order is owed for good; underpaid, malformed or late ones are void", () => {
  assert.deepEqual(kinds([order()]), ["owed"]);
  assert.deepEqual(kinds([order({ paid: 1n })]), ["void"], "1 coin buys 1000 of the 2000 bytes");
  assert.deepEqual(kinds([order({ root: "Nexus/x" })]), ["void"]);
  assert.deepEqual(kinds([order({ value: "2000" })]), ["void"]);
  assert.deepEqual(kinds([order({ created: 100001n })], 200000n), ["void"]);
  assert.deepEqual(kinds([order()], 200n + SETTLE - 1n), ["pending"]);
  assert.equal(judgeStorage({ height: 10n ** 9n, offers, orders: [order()] }).get(order().key).active, true, "never ends");
});

test("an offer sells its capacity in bytes; a root ordered again counts once", () => {
  const first = order({ root: ROOT(1), bytes: 3000n, paid: 3n, created: 200n });
  const again = order({ root: ROOT(1), bytes: 3000n, paid: 3n, created: 201n });
  const over = order({ root: ROOT(2), bytes: 3000n, paid: 3n, created: 202n });
  const fits = order({ root: ROOT(3), bytes: 2000n, paid: 2n, created: 203n });
  assert.deepEqual(kinds([over, fits, first, again]), ["full", "owed", "owed", "owed"]);
});

test("hosting verdicts leave storage orders alone, and the payment covers the bytes", () => {
  assert.equal(judge({ sdk, height: 1000n, versions: new Map([...offers].map(([k, t]) => [k, [t]])), orders: [order()] }).size, 0);
  const w = storageOrderWrite({ host: HOST, id: "s", offer: STORAGE, payer: A, root: ROOT(1), bytes: 2001n, height: 200n });
  assert.deepEqual(w.payments, [{ to: HOST, amount: 3n }]);
  assert.deepEqual(kinds([{ ...order(), key: w.actions[0].key, paid: 3n, payloadText: w.actions[0].newValue }]), ["owed"]);
});

// A stand-in for the web: URL → JSON.
const web = (pages) => async (url) => (url in pages ? { ok: true, json: async () => pages[url] } : { ok: false, status: 404 });
const READ = "https://host.example", WELL_KNOWN = "https://host.example/.well-known/lattice.json";

test("an offer counts only when the host's domain lists its address", async () => {
  const listed = web({ [WELL_KNOWN]: { sellers: [HOST] } });
  assert.deepEqual(await hostVouches({ host: HOST, urlValue: READ, fetchImpl: listed }), { ok: true });
  assert.equal((await hostVouches({ host: IMPOSTOR, urlValue: READ, fetchImpl: listed })).ok, false, "someone else's URL");
  assert.equal((await hostVouches({ host: HOST, urlValue: READ, fetchImpl: web({}) })).ok, false, "no list");
  assert.equal((await hostVouches({ host: HOST, urlValue: undefined, fetchImpl: listed })).ok, false, "no url record");
  const proof = "https://host.example:8650/.well-known/lattice.json";
  assert.equal((await hostVouches({ host: HOST, urlValue: formatHostURL(READ, proof), fetchImpl: web({ [proof]: { sellers: [HOST] } }) })).ok, true, "a proof on another port of the hostname");
  assert.equal(parseHostURL(formatHostURL(READ, "https://elsewhere.example/.well-known/lattice.json")), undefined, "a proof on another hostname");
  assert.equal(parseHostURL(formatHostURL(READ, "https://host.example/api/anything")), undefined, "a proof at another path");
});

test("a storage offer counts only when its sponsor is paid to the host at the offer's rate", async () => {
  const M = "Nexus/testnet/lodger";
  const pages = (terms) => web({ [WELL_KNOWN]: { sellers: [HOST] }, "https://host.example:8650/sponsor/terms": terms });
  const vouches = (host, terms) => storageVouches({ host, urlValue: READ, offer: STORAGE, market: M, fetchImpl: pages(terms) });
  assert.deepEqual(await vouches(HOST, { payTo: HOST, storageRates: { [M]: 1000 } }), { ok: true });
  assert.equal((await vouches(HOST, { payTo: IMPOSTOR, storageRates: { [M]: 1000 } })).ok, false, "a sponsor paid to someone else");
  assert.equal((await vouches(HOST, { payTo: HOST, storageRates: { [M]: 999 } })).ok, false, "another rate");
  assert.equal((await vouches(IMPOSTOR, { payTo: IMPOSTOR, storageRates: { [M]: 1000 } })).ok, false, "a domain that does not list it");
});
