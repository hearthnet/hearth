// The v3 market's records and verdicts, judged from genesis blocks minted
// as the web app mints them (test/minted.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { RENEW, chainPrice, formatOffer, formatOrderValue, orderKey, parseGenesis, parseOffer, parseOrderKey, parseOrderValue, pathPrice } from "../client/records.mjs";
import { judge } from "../client/verdict.mjs";
import { earnings, judgeOwn } from "../host/status.mjs";
import { unpin } from "../host/launch.mjs";
import { base64 } from "../app/genesis.mjs";
import { MODULE_CID, SIZES, mint, respec } from "./minted.mjs";

const PATH = "Nexus/testnet/app";
const MARKET = "Nexus/testnet/hearth";
const { cid: GENESIS, value: VALUE } = mint(PATH);
const key = (n) => sdk.accountFromPrivateKey(new Uint8Array(32).fill(n)).address;
const HOST = key(1), BUYER = key(2), OTHER = key(3);
const OFFER = { hashrate: 1000000n, throughput: 3n, storage: 1n, period: 100n, blocks: HOST };
const TERMS = formatOffer(OFFER);
// Every spec here: 1 MB blocks every 60 s, 1 MB state growth: 50 + 1000 per chain at OFFER.
const SPEC = { maxBlockSize: 1000000, targetBlockTime: 60000, maxStateGrowth: 1000000 };
const SPECS = new Map([["Nexus", SPEC], ["Nexus/testnet", SPEC]]);
const PRICE = 3n * 1050n;

const order = ({ n = 0, paid = PRICE, path = PATH, value = VALUE, landed = 10n, terms = TERMS, payer = BUYER, id = "o1" } = {}) => {
  const k = orderKey({ host: HOST, id, payer, n, paid, path });
  return { key: k, ...parseOrderKey(k), value, landed, terms };
};
const judged = (orders, { height = 50n, specs = SPECS } = {}) => judge({ sdk, height, orders, market: MARKET, specs });
const one = (o, opts) => judged([o], opts).get(o.key);

test("an offer is exactly its five lines", () => {
  assert.deepEqual(parseOffer(TERMS), OFFER);
  assert.equal(parseOffer(TERMS + "\nmore"), undefined);
  assert.equal(parseOffer(TERMS.replace("period 100", "period 0")), undefined, "a period of no blocks");
  assert.equal(parseOffer(TERMS.replace("storage 1", "storage 01")), undefined, "non-canonical");
  assert.equal(parseOffer(TERMS.replace(`blocks ${HOST}`, "blocks nobody")), undefined);
});

test("a chain's price: kB/s of block capacity and kB of state growth; a path sums its chains", () => {
  assert.equal(chainPrice(OFFER, SPEC), 50n + 1000n);
  assert.equal(chainPrice(OFFER, { ...SPEC, targetBlockTime: 30000 }), 100n + 1000n, "faster blocks cost more");
  assert.equal(chainPrice({ ...OFFER, throughput: 1n }, { maxBlockSize: 1, targetBlockTime: 60000, maxStateGrowth: 1 }), 2n, "each part rounds up");
  assert.equal(pathPrice(OFFER, [SPEC, SPEC, SPEC]), PRICE);
  assert.equal(pathPrice({ ...OFFER, throughput: 0n, storage: 0n }, [SPEC]), 1n, "at least 1");
});

test("an order carries a genesis that checks out against its CIDs", () => {
  const g = parseGenesis(sdk, parseOrderValue(VALUE), PATH);
  assert.equal(g.error, undefined);
  assert.equal(g.cid, GENESIS);
  assert.equal(BigInt(g.spec.maxBlockSize), 1000000n);
  const v = parseOrderValue(VALUE);
  const other = Object.keys(v.volumes).find((c) => c !== GENESIS);
  const swapped = { ...v.volumes, [GENESIS]: v.volumes[other] };
  assert.match(parseGenesis(sdk, parseOrderValue(formatOrderValue({ ...v, volumes: swapped }))).error, /does not match its CID/);
  assert.match(parseGenesis(sdk, parseOrderValue(formatOrderValue({ ...v, modules: {} })), PATH).error, /not exactly the spec's/);
  assert.match(parseOrderValue("{}").error, /keys/);
});

test("an order is owed from the block it landed in, for the periods it paid", () => {
  const v = judge({ sdk, height: 50n, orders: [order({ paid: 2n * PRICE + 1n })], market: MARKET, specs: SPECS });
  const [verdict] = v.values();
  assert.equal(verdict.kind, "owed");
  assert.equal(verdict.from, 10n);
  assert.equal(verdict.until, 10n + 200n);
  assert.equal(verdict.active, true);
  assert.equal(verdict.genesis, GENESIS);
});

test("an order is void when it pays less than a period for the whole path, or its genesis does not check out", () => {
  const short = judge({ sdk, height: 50n, orders: [order({ paid: PRICE - 1n })], market: MARKET, specs: SPECS });
  assert.match([...short.values()][0].reason, /less than one period for the whole path/);
  const shallow = judge({ sdk, height: 50n, orders: [order({ paid: 2n * 1050n, path: "Nexus/app", value: mint("Nexus/app").value })], market: MARKET, specs: SPECS });
  assert.equal([...shallow.values()][0].kind, "owed", "a shorter path costs less");
  const bad = judge({ sdk, height: 50n, orders: [order({ value: "{}" })], market: MARKET, specs: SPECS });
  assert.equal([...bad.values()][0].kind, "void");
  const noTerms = judge({ sdk, height: 50n, orders: [order({ terms: null })], market: MARKET, specs: SPECS });
  assert.match([...noTerms.values()][0].reason, /terms/);
});

test("an order waits for the specs above its path", () => {
  const v = judge({ sdk, height: 50n, orders: [order()], market: MARKET, specs: new Map([["Nexus", SPEC]]) });
  assert.equal([...v.values()][0].kind, "unpriced");
});

test("renewals extend paid time at the terms each landed on; one that ran out restarts where it landed", () => {
  const first = order();
  const renew = order({ n: 1, payer: OTHER, landed: 60n, value: RENEW, paid: PRICE });
  const late = order({ n: 2, landed: 500n, value: RENEW, paid: PRICE, terms: formatOffer({ ...OFFER, period: 10n }) });
  const v = judge({ sdk, height: 600n, orders: [late, renew, first], market: MARKET, specs: SPECS });
  assert.equal(v.get(first.key).until, 500n + 10n);
  assert.equal(v.get(renew.key).kind, "renewal");
  const early = order({ n: 3, landed: 5n, value: RENEW });
  assert.equal(judge({ sdk, height: 600n, orders: [early, first], market: MARKET, specs: SPECS }).get(early.key).kind, "void", "a renewal before any order");
});

const BASE_SPEC = { ...SIZES, premine: 0, initialReward: 100, halvingInterval: 1000000, halfLife: 100, wasmPolicies: [] };

test("judging never throws on what an order carries: a malformed spec, a renewal on terms that do not parse, an order that cannot be priced", () => {
  for (const [bad, why] of [[{ maxBlockSize: "x" }, /maxBlockSize is out of range/], [{ wasmPolicies: "x" }, /wasmPolicies/], [{ wasmPolicies: [null] }, /wasmPolicies/]]) {
    const value = respec(VALUE, { ...BASE_SPEC, ...bad });
    assert.match(parseGenesis(sdk, parseOrderValue(value), PATH).error, why);
    assert.equal(one(order({ n: 1, value })).kind, "void");
  }
  const first = order();
  const renewal = order({ n: 2, landed: 20n, value: RENEW, terms: "not terms" });
  assert.match(judged([first, renewal]).get(renewal.key).reason, /terms do not parse/);
  // A chain above whose spec does not price: that order is void, the others judged.
  const odd = order({ n: 3, path: "Nexus/odd/app" });
  const v = judged([first, odd], { specs: new Map([...SPECS, ["Nexus/odd", { ...SPEC, maxBlockSize: "x" }]]) });
  assert.match(v.get(odd.key).reason, /could not be judged/);
  assert.equal(v.get(first.key).kind, "owed");
});

test("one genesis per path at an offer: the first owed order to land fixes it; another genesis there later is void; the seller hosts the first", async () => {
  const other = mint(PATH, { timestamp: 1_900_000_000_000 });
  const first = order({ landed: 10n });
  const rival = order({ n: 1, landed: 20n, value: other.value });
  const more = order({ n: 2, landed: 30n });
  const v = judged([more, rival, first]);
  assert.match(v.get(rival.key).reason, /another genesis holds this path at this host/);
  assert.equal(v.get(more.key).kind, "owed");
  assert.equal(v.get(first.key).until, 10n + 200n, "the same genesis extends paid time");
  // Two offers of one host, each with its own genesis for the path: it hosts the one that landed first, whatever the keys' order.
  const early = order({ id: "o2", landed: 10n }), late = order({ id: "o1", landed: 30n, value: other.value });
  assert.ok(late.key < early.key);
  const own = await judgeOwn({ sdk, m: { height: 50n, orders: [late, early] }, self: HOST, market: MARKET, chains: { specsDownTo: async () => SPECS } });
  assert.equal(own.owed.get(PATH).cid, GENESIS);
});

test("owed must be runnable: proofs of this genesis at this path, its children index and spec in its volumes, a path under Nexus apart from the market", () => {
  const v = parseOrderValue(VALUE);
  assert.match(one(order({ n: 1, value: formatOrderValue({ ...v, proofs: ["AAAA"] }) })).reason, /proof/);
  assert.match(one(order({ n: 2, path: "Nexus/testnet/elsewhere" })).reason, /does not prove this genesis at Nexus\/testnet\/elsewhere/);
  const volume = sdk.decodeVolumeArchive(GENESIS, Buffer.from(v.volumes[GENESIS], "base64"));
  const { childrenCID } = sdk.decodeCanonicalBlock(volume.entries.find((e) => e.cid === GENESIS).bytes);
  const noChildren = base64(sdk.encodeVolumeArchive({ rootCID: GENESIS, entries: volume.entries.filter((e) => e.cid !== childrenCID) }));
  assert.match(one(order({ n: 3, value: formatOrderValue({ ...v, volumes: { ...v.volumes, [GENESIS]: noChildren } }) })).reason, /children index/);
  for (const path of ["Nexus", "Other/app", MARKET, "Nexus/testnet"]) {
    assert.match(one(order({ n: 4, path, paid: 10n * PRICE })).reason, /not a chain under Nexus apart from the market/, path);
  }
  assert.equal(one(order({ n: 5, path: `${MARKET}/app`, paid: 4n * 1050n, value: mint(`${MARKET}/app`).value }), { specs: new Map([...SPECS, [MARKET, SPEC]]) }).kind, "owed", "a chain under the market");
});

test("the seller reads a spec its node does not hold through the nodes its node lists, as the web app does", async () => {
  // Every chain here runs the minted genesis (its spec is SPEC); the seller's node holds Nexus, another node Nexus/p.
  const v = parseOrderValue(mint("Nexus/p").value);
  const volumes = v.volumes;
  const answer = (body, type = "application/json") => new Response(type === "application/json" ? JSON.stringify(body) : body, { headers: { "content-type": type } });
  const serving = { "http://127.0.0.1:1": ["Nexus"], "https://other.test": ["Nexus/p"] };
  const fetchImpl = async (input) => {
    const url = new URL(input), chain = url.searchParams.get("chainPath");
    if (url.pathname.startsWith("/volumes/")) { const cid = url.pathname.slice(9); return volumes[cid] ? answer(Buffer.from(volumes[cid], "base64"), sdk.VOLUME_ARCHIVE_MEDIA_TYPE) : new Response("", { status: 404 }); }
    if (url.pathname === "/api/chain/genesis") return answer({ genesisHash: "nexus" });
    if (url.pathname === "/api/chain/endpoints" && url.origin === "http://127.0.0.1:1") return answer({ chainPath: chain.split("/"), endpoints: ["https://other.test"], submitEndpoints: [] });
    if (!serving[url.origin].includes(chain)) return new Response("", { status: 404 });
    if (url.pathname === "/api/chain/info") return answer({ chain: chain.split("/"), height: "3" });
    if (url.pathname === "/api/block/latest") return answer({ hash: v.genesis, height: "0" });
    return new Response("", { status: 404 });
  };
  const n = (await import("../client/market.mjs")).reader(sdk, "http://127.0.0.1:1", { fetchImpl });
  const { chainReaders } = await import("../client/chains.mjs");
  const o = order({ path: "Nexus/p/app", value: mint("Nexus/p/app").value });
  const own = await judgeOwn({ sdk, n, m: { height: 50n, orders: [o] }, self: HOST, market: MARKET, chains: chainReaders(sdk, n, { fetchImpl }) });
  assert.equal(own.verdicts.get(o.key).kind, "owed", own.verdicts.get(o.key).reason);
});

test("volumes are exactly the genesis's own, its sizes at least 1; the seller unpins what a chain no longer owed pinned and no owed chain needs", async () => {
  const v = parseOrderValue(VALUE);
  const stranger = parseOrderValue(mint(PATH, { timestamp: 1_700_000_000_000 }).value);
  const extra = formatOrderValue({ ...v, volumes: { ...v.volumes, [stranger.genesis]: stranger.volumes[stranger.genesis] } });
  assert.match(one(order({ n: 1, value: extra })).reason, /is not the genesis's own/);
  for (const name of ["maxBlockSize", "maxStateGrowth"]) assert.match(parseGenesis(sdk, parseOrderValue(respec(VALUE, { ...BASE_SPEC, [name]: 0 })), PATH).error, new RegExp(`${name} is zero`));
  // One chain ran out at block 10 + 100; another is owed now.
  const ended = order({ landed: 10n, paid: PRICE });
  const now = order({ n: 1, path: "Nexus/testnet/now", landed: 200n, value: mint("Nexus/testnet/now", { timestamp: 1_900_000_000_000 }).value });
  const own = await judgeOwn({ sdk, m: { height: 250n, orders: [ended, now] }, self: HOST, market: MARKET, chains: { specsDownTo: async () => SPECS } });
  const pins = (o) => [...Object.keys(parseOrderValue(o.value).volumes), ...Object.keys(parseOrderValue(o.value).modules)];
  assert.deepEqual(own.released.sort(), pins(ended).filter((c) => !pins(now).includes(c)).sort(), "what only the ended chain needs");
  assert.ok(own.released.includes(GENESIS) && !own.released.includes(MODULE_CID), "the shared module stays");
  const calls = [];
  const rpc = async (route, body, method = "GET") => { calls.push(`${method} ${route}`); return { body: { pins: [GENESIS, "bafyreisomethingelse"] } }; };
  assert.deepEqual(await unpin({ rpc, released: own.released }), [GENESIS]);
  assert.deepEqual(calls, ["GET /pins", `DELETE /pins/${GENESIS}`], "only what the node still pins");
});

test("cost: an order short of the chains above is void before its genesis is decoded, and an order's genesis is decoded once", () => {
  let decoded = 0;
  const counting = { ...sdk, decodeVolumeArchive: (...a) => { decoded++; return sdk.decodeVolumeArchive(...a); } };
  const short = order({ n: 7, paid: 2n * 1050n - 1n, value: "not even JSON" });
  assert.match(judge({ sdk: counting, height: 50n, orders: [short], market: MARKET, specs: SPECS }).get(short.key).reason, /less than one period/);
  const o = order({ n: 8 });
  judge({ sdk: counting, height: 50n, orders: [o], market: MARKET, specs: SPECS });
  const first = decoded;
  assert.ok(first > 0);
  assert.equal(judge({ sdk: counting, height: 50n, orders: [{ ...o }], market: MARKET, specs: SPECS }).get(o.key).kind, "owed");
  assert.equal(decoded, first, "not decoded again");
});

test("an underpaid renewal is void, and not counted in earnings", () => {
  const first = order();
  const renewal = order({ n: 1, payer: OTHER, landed: 20n, value: RENEW, paid: PRICE - 1n });
  const verdicts = judged([first, renewal]);
  assert.match(verdicts.get(renewal.key).reason, /less than one period/);
  assert.equal(verdicts.get(first.key).until, 10n + 100n);
  assert.equal(earnings({ self: HOST, mine: [first, renewal], verdicts }), PRICE);
});
