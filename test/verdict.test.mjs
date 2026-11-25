// The v3.1 market's records and verdicts, judged from genesis blocks minted
// as the web app mints them (test/minted.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { RENEW, renewValue, formatOffer, formatOrderValue, orderKey, overLimits, parseGenesis, parseOffer, parseOrderKey, parseOrderValue, sellsUnder } from "../client/records.mjs";
import { holderOf, judge } from "../client/verdict.mjs";
import { renewWrite } from "../client/tx.mjs";
import { earnings, hostingList, judgeOwn } from "../host/status.mjs";
import { launch, launchOwed, launchPins, launchPinsFile, unpin } from "../host/launch.mjs";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { heldCheck } from "../app/launch.mjs";
import { base64 } from "../app/genesis.mjs";
import { MODULE_CID, SIZES, mint, respec } from "./minted.mjs";

const PATH = "Nexus/testnet/app";
const MARKET = "Nexus/testnet/hearth";
const { cid: GENESIS, value: VALUE } = mint(PATH);
const key = (n) => sdk.accountFromPrivateKey(new Uint8Array(32).fill(n)).address;
const HOST = key(1), BUYER = key(2), OTHER = key(3);
// The minted chains: 1 MB blocks every 60 s (16,666.67 bytes a second), 1 MB state growth.
const OFFER = { hashrate: 1000000n, price: 1000n, period: 100n, throughput: 16667n, storage: 1000000n, blocks: HOST, under: ["Nexus", "Nexus/testnet"] };
const TERMS = formatOffer(OFFER);
const PRICE = OFFER.price;

const order = ({ n = 0, paid = PRICE, path = PATH, value = VALUE, landed = 10n, terms = TERMS, payer = BUYER, id = "o1" } = {}) => {
  const k = orderKey({ host: HOST, id, payer, n, paid, path });
  return { key: k, ...parseOrderKey(k), value, landed, terms };
};
const judged = (orders, { height = 50n } = {}) => judge({ sdk, height, orders, market: MARKET });
const RENEW_G = renewValue(GENESIS);
const one = (o, opts) => judged([o], opts).get(o.key);

test("an offer is exactly its lines: six terms, then the parents it sells under, sorted, each once", () => {
  assert.equal(TERMS, `hashrate 1000000\nprice 1000\nperiod 100\nthroughput 16667\nstorage 1000000\nblocks ${HOST}\nunder Nexus\nunder Nexus/testnet`);
  assert.deepEqual(parseOffer(TERMS), OFFER);
  assert.equal(formatOffer({ ...OFFER, under: ["Nexus/testnet", "Nexus", "Nexus/testnet"] }), TERMS, "written sorted, each once");
  // U+FF5A before U+1F600 by UTF-8 bytes (EF.. < F0..), though not by UTF-16 code units (FF5A > D83D).
  const bytewise = formatOffer({ ...OFFER, under: ["Nexus/\u{1F600}", "Nexus/\uFF5A"] });
  assert.equal(bytewise.split("\n").slice(6).join(), "under Nexus/\uFF5A,under Nexus/\u{1F600}", "sorted by bytes, as the policy reads them");
  assert.deepEqual(parseOffer(bytewise).under, ["Nexus/\uFF5A", "Nexus/\u{1F600}"]);
  for (const [why, bad] of [["more", `${TERMS}\nmore`], ["a trailing newline", `${TERMS}\n`], ["no under", TERMS.split("\nunder")[0]],
    ["a period of no blocks", TERMS.replace("period 100", "period 0")], ["a price of nothing", TERMS.replace("price 1000", "price 0")],
    ["non-canonical", TERMS.replace("storage 1000000", "storage 01000000")], ["past 2^64 - 1", TERMS.replace("price 1000", "price 18446744073709551616")],
    ["not an address", TERMS.replace(`blocks ${HOST}`, "blocks nobody")], ["unsorted", TERMS.replace("under Nexus\nunder Nexus/testnet", "under Nexus/testnet\nunder Nexus")],
    ["twice", TERMS.replace("under Nexus/testnet", "under Nexus")], ["an empty segment", TERMS.replace("Nexus/testnet", "Nexus//testnet")],
    ["out of order", TERMS.replace("price 1000\nperiod 100", "period 100\nprice 1000")], ["a v3 offer", `hashrate 1\nthroughput 3\nstorage 1\nperiod 100\nblocks ${HOST}`]]) {
    assert.equal(parseOffer(bad), undefined, why);
  }
  assert.ok(sellsUnder(OFFER, "Nexus/testnet/app") && sellsUnder(OFFER, "Nexus/app"));
  assert.ok(!sellsUnder(OFFER, "Nexus/testnet/a/app") && !sellsUnder(OFFER, "Nexus") && !sellsUnder(OFFER, "Nexus/other/app"));
});

test("an offer's limits: block rate in bytes a second, state growth in bytes a block, compared without rounding", () => {
  const spec = { maxBlockSize: 1000000, targetBlockTime: 60000, maxStateGrowth: 1000000 };
  assert.equal(overLimits(OFFER, spec), undefined, "16,666.67 bytes a second under 16,667");
  assert.match(overLimits({ ...OFFER, throughput: 16666n }, spec), /throughput/, "above 16,666");
  assert.equal(overLimits({ ...OFFER, throughput: 1n }, { ...spec, maxBlockSize: 60, targetBlockTime: 60000 }), undefined, "exactly 1 byte a second");
  assert.match(overLimits(OFFER, { ...spec, maxStateGrowth: 1000001 }), /storage/);
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

test("an order is owed from the block it landed in, for the periods it paid: the price of the ordered chain alone", () => {
  const v = judged([order({ paid: 2n * PRICE + 1n })]);
  const [verdict] = v.values();
  assert.equal(verdict.kind, "owed");
  assert.equal(verdict.from, 10n);
  assert.equal(verdict.until, 10n + 200n);
  assert.equal(verdict.active, true);
  assert.equal(verdict.genesis, GENESIS);
});

test("an order is void when its genesis does not check out, or its spec is above the offer's throughput or storage", () => {
  assert.equal(one(order({ path: "Nexus/app", value: mint("Nexus/app").value })).until, 10n + 100n, "any depth costs the same");
  assert.equal(one(order({ value: "{}" })).kind, "void");
  assert.match(one(order({ terms: null })).reason, /terms/);
  assert.match(one(order({ terms: formatOffer({ ...OFFER, throughput: 16666n }) })).reason, /block rate .* above the offer's throughput/);
  assert.match(one(order({ terms: formatOffer({ ...OFFER, storage: 999999n }) })).reason, /maxStateGrowth is above the offer's storage/);
  assert.equal(one(order({ terms: formatOffer({ ...OFFER, storage: 1000000n }) })).kind, "owed", "at the limit");
});

test("renewals extend paid time at the terms each landed on; one that ran out restarts where it landed", () => {
  const first = order();
  const renew = order({ n: 1, payer: OTHER, landed: 60n, value: RENEW_G, paid: PRICE });
  const late = order({ n: 2, landed: 500n, value: RENEW_G, paid: PRICE, terms: formatOffer({ ...OFFER, period: 10n }) });
  const v = judged([late, renew, first], { height: 600n });
  assert.equal(v.get(first.key).until, 500n + 10n);
  assert.equal(v.get(renew.key).kind, "renewal");
  const early = order({ n: 3, landed: 5n, value: RENEW_G });
  assert.equal(judged([early, first], { height: 600n }).get(early.key).kind, "void", "a renewal before any order");
});

const BASE_SPEC = { ...SIZES, premine: 0, initialReward: 100, halvingInterval: 1000000, halfLife: 100, wasmPolicies: [] };

test("judging never throws on what an order carries: a malformed spec, a renewal on terms that do not parse", () => {
  for (const [bad, why] of [[{ maxBlockSize: "x" }, /maxBlockSize is out of range/], [{ wasmPolicies: "x" }, /wasmPolicies/], [{ wasmPolicies: [null] }, /wasmPolicies/]]) {
    const value = respec(VALUE, { ...BASE_SPEC, ...bad });
    assert.match(parseGenesis(sdk, parseOrderValue(value), PATH).error, why);
    assert.equal(one(order({ n: 1, value })).kind, "void");
  }
  const first = order();
  const renewal = order({ n: 2, landed: 20n, value: RENEW_G, terms: "not terms" });
  assert.match(judged([first, renewal]).get(renewal.key).reason, /terms do not parse/);
  // An order that throws while judged is void, the others judged.
  const odd = { ...order({ n: 3 }), path: undefined };
  const v = judged([first, odd]);
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
  const own = await judgeOwn({ sdk, m: { height: 50n, orders: [late, early] }, self: HOST, market: MARKET });
  assert.equal(own.owed.get(PATH).cid, GENESIS);
});

test("a host holds a path for one genesis across all its offers; a renewal at any of them pays for it", async () => {
  const other = mint(PATH, { timestamp: 1_900_000_000_000 });
  const first = order({ id: "o2", landed: 10n }), rival = order({ id: "o1", landed: 30n, value: other.value });
  const renewal = order({ id: "o1", n: 1, payer: OTHER, landed: 40n, value: RENEW_G });
  const v = judged([rival, first, renewal]);
  assert.match(v.get(rival.key).reason, /another genesis holds this path at this host while it is paid/);
  assert.equal(v.get(first.key).until, 10n + 200n, "the renewal at the host's other offer pays for the holder");
  assert.equal(holderOf({ orders: [rival, first, renewal], verdicts: v, host: HOST, path: PATH }), GENESIS);
  assert.throws(() => heldCheck({ chosen: [{ host: HOST, id: "o9" }], orders: [first], verdicts: v, path: PATH }), /hosts another genesis/, "any of the host's offers");
});

test("the page renews only the genesis holding the path at that host: not one another genesis took over", () => {
  const other = mint(PATH, { timestamp: 1_900_000_000_000 });
  const first = order({ landed: 10n }), after = order({ n: 1, landed: 120n, value: other.value });
  const v = judged([first, after], { height: 150n });
  assert.equal(holderOf({ orders: [first, after], verdicts: v, host: HOST, path: PATH }), other.cid);
  assert.equal(holderOf({ orders: [first], verdicts: judged([first], { height: 150n }), host: HOST, path: PATH }), GENESIS, "lapsed, but nobody took over: it may renew");
});

test("a takeover is pushed once, the path staying hosted: fork choice decides which chain runs it", async () => {
  const other = mint(PATH, { timestamp: 1_900_000_000_000 });
  const a = order({ landed: 10n }), b = order({ n: 1, landed: 120n, value: other.value });
  const judgeAt = (height, orders) => judgeOwn({ sdk, m: { height, orders }, self: HOST, market: MARKET, hosted: [PATH] });
  const pushed = [];
  const rpc = async (route, body) => {
    if (route === "/child-blocks") { pushed.push(sdk.cidV1DagCbor(Buffer.from(body.block, "base64"))); return { body: { status: "tree" } }; }
    return { body: { pins: [] } };
  };
  const launched = new Set();
  for (const [height, orders] of [[50n, [a]], [60n, [a]], [150n, [a, b]], [160n, [a, b]]]) {
    const own = await judgeAt(height, orders);
    assert.deepEqual(hostingList({ owed: own.owed, unsure: own.unsure, hosted: [PATH] }), [PATH], `hosted at ${height}`);
    await launchOwed({ rpc, owed: own.owed, launched });
  }
  assert.deepEqual(pushed, [GENESIS, other.cid], "each genesis once");
});

test("uncertainty never drops a chain: a hosted path with an order not judged yet stays listed", () => {
  assert.deepEqual(hostingList({ owed: new Map(), unsure: ["Nexus/a/app", "Nexus/b/app"], hosted: ["Nexus/a/app"] }), ["Nexus/a/app"], "hosted and unsure stays; never hosted is not added");
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
  assert.equal(one(order({ n: 5, path: `${MARKET}/app`, value: mint(`${MARKET}/app`).value })).kind, "owed", "a chain under the market");
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
  const own = await judgeOwn({ sdk, m: { height: 250n, orders: [ended, now] }, self: HOST, market: MARKET });
  const pins = (o) => [...Object.keys(parseOrderValue(o.value).volumes), ...Object.keys(parseOrderValue(o.value).modules)];
  assert.deepEqual(own.released.sort(), pins(ended).filter((c) => !pins(now).includes(c)).sort(), "what only the ended chain needs");
  assert.ok(own.released.includes(GENESIS) && !own.released.includes(MODULE_CID), "the shared module stays");
  const calls = [];
  const rpc = async (route, body, method = "GET") => { calls.push(`${method} ${route}`); return { body: { pins: [GENESIS, "bafyreisomethingelse"] } }; };
  const file = join(mkdtempSync(join(tmpdir(), "hearth-pins-")), "launch-pins.json");
  launchPins(file).add([...own.released, "bafyreisomethingelse"]);
  const pinned = launchPins(file);
  assert.deepEqual(await unpin({ rpc, released: own.released, pinned }), [GENESIS]);
  assert.deepEqual(calls, ["GET /pins", `DELETE /pins/${GENESIS}`], "only what the node still pins");
  assert.equal(launchPins(file).has(GENESIS), false, "no longer recorded once unpinned");
});

test("the seller unpins only what its own launches pinned, and nothing in a pass where an order could not be judged", async () => {
  const ended = order({ landed: 10n, paid: PRICE });
  const now = order({ n: 1, path: "Nexus/testnet/now", landed: 200n, value: mint("Nexus/testnet/now", { timestamp: 1_900_000_000_000 }).value });
  // An order whose judging throws (here a paid amount that is no BigInt): it may be owed.
  const unjudged = { ...order({ n: 2, path: "Nexus/unread/app", landed: 200n, value: mint("Nexus/unread/app").value }), paid: 1 };
  const judgeAt = (orders) => judgeOwn({ sdk, m: { height: 250n, orders }, self: HOST, market: MARKET });
  assert.ok((await judgeAt([ended, now])).released.includes(GENESIS));
  assert.match((await judgeAt([unjudged])).verdicts.get(unjudged.key).reason, /could not be judged/);
  assert.ok((await judgeAt([ended, now, unjudged])).released.includes(GENESIS), "an order not judged for a path it never hosted holds nothing back");
  const judgeHosting = (orders) => judgeOwn({ sdk, m: { height: 250n, orders }, self: HOST, market: MARKET, hosted: ["Nexus/unread/app"] });
  assert.deepEqual((await judgeHosting([ended, now, unjudged])).released, [], "an order not judged for a path it hosts may be owed");
  const calls = [];
  const rpc = async (route, body, method = "GET") => { calls.push(`${method} ${route}`); return { body: { pins: [GENESIS] } }; };
  const file = join(mkdtempSync(join(tmpdir(), "hearth-pins-")), "launch-pins.json");
  assert.deepEqual(await unpin({ rpc, released: [GENESIS], pinned: launchPins(file) }), [], "pinned by someone else (its sponsor)");
  assert.deepEqual(calls, []);
});

test("launch records only what the node did not pin already, so what its sponsor pinned is never unpinned", async () => {
  const v = parseOrderValue(VALUE);
  const sponsors = Object.keys(v.volumes).find((c) => c !== GENESIS);
  const nodePins = new Set([sponsors]);
  const deleted = [];
  const rpc = async (route, body, method = body === undefined ? "GET" : "POST") => {
    if (route === "/pins" && method === "GET") return { body: { pins: [...nodePins] } };
    if (route === "/pins") { nodePins.add(body.cid); return { body: {} }; }
    if (method === "DELETE") { deleted.push(route.slice(6)); return { body: {} }; }
    return { body: { status: "tree" } };
  };
  const file = launchPinsFile(mkdtempSync(join(tmpdir(), "hearth-pins-")), MARKET);
  const pinned = launchPins(file);
  await launch({ rpc, path: PATH, genesis: { cid: GENESIS, volumes: v.volumes, modules: v.modules, proofs: v.proofs }, pinned });
  assert.equal(launchPins(file).has(sponsors), false, "already pinned: not recorded");
  assert.equal(launchPins(file).has(GENESIS), true);
  await unpin({ rpc, released: [sponsors, GENESIS], pinned });
  assert.deepEqual(deleted, [GENESIS], "the sponsor's pin stays");
});

test("launch-pins is one file per market, written whole, and a damaged one reads as empty with a warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-pins-"));
  assert.equal(launchPinsFile(dir, "Nexus/testnet/hearth"), join(dir, "launch-pins-Nexus_testnet_hearth.json"));
  const file = launchPinsFile(dir, MARKET);
  launchPins(file).add(["b", "a"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), ["a", "b"]);
  assert.deepEqual(readdirSync(dir), [basename(file)], "no temporary file left");
  for (const bad of ["{not json", '{"a":1}', "[1,2]"]) {
    writeFileSync(file, bad);
    const warnings = [];
    const pins = launchPins(file, (l) => warnings.push(l));
    assert.equal(pins.has("a"), false);
    assert.equal(warnings.length, 1, bad);
  }
});

test("cost: an order's genesis is decoded once", () => {
  let decoded = 0;
  const counting = { ...sdk, decodeVolumeArchive: (...a) => { decoded++; return sdk.decodeVolumeArchive(...a); } };
  const o = order({ n: 8 });
  judge({ sdk: counting, height: 50n, orders: [o], market: MARKET });
  const first = decoded;
  assert.ok(first > 0);
  assert.equal(judge({ sdk: counting, height: 50n, orders: [{ ...o }], market: MARKET }).get(o.key).kind, "owed");
  assert.equal(decoded, first, "not decoded again");
});

test("a renewal at an offer whose limits no longer take the genesis is void, and not counted in earnings", () => {
  const first = order();
  const renewal = order({ n: 1, payer: OTHER, landed: 20n, value: RENEW_G, terms: formatOffer({ ...OFFER, storage: 1n }) });
  const verdicts = judged([first, renewal]);
  assert.match(verdicts.get(renewal.key).reason, /above the offer's storage/);
  assert.equal(verdicts.get(first.key).until, 10n + 100n);
  assert.equal(earnings({ self: HOST, mine: [first, renewal], verdicts }), PRICE);
});

test("a genesis holds its path at an offer only while it is paid: another genesis landing after its paid time ends holds it from then", () => {
  const other = mint(PATH, { timestamp: 1_900_000_000_000 });
  const first = order({ landed: 10n });                                    // paid to 110
  const early = order({ n: 1, landed: 50n, value: other.value });
  const after = order({ n: 2, landed: 120n, value: other.value });         // paid to 220
  const renewal = order({ n: 3, payer: OTHER, landed: 130n, value: renewValue(other.cid) });
  const v = judged([renewal, after, early, first], { height: 150n });
  assert.match(v.get(early.key).reason, /another genesis holds this path at this host while it is paid/);
  assert.deepEqual([v.get(first.key).kind, v.get(first.key).until, v.get(first.key).active], ["owed", 110n, false]);
  assert.deepEqual([v.get(after.key).kind, v.get(after.key).until, v.get(after.key).active], ["owed", 320n, true], "the renewal pays for the genesis holding it now");
  assert.equal(v.get(after.key).genesis, other.cid);
});

test("a proof that is well formed but whose hash misses the genesis's target proves nothing", () => {
  const noWork = { ...sdk, verifyChildBlockProof: (...a) => ({ ...sdk.verifyChildBlockProof(...a), evidence: {} }) };
  assert.equal(parseGenesis(sdk, parseOrderValue(VALUE), PATH).error, undefined);
  assert.match(parseGenesis(noWork, parseOrderValue(VALUE), PATH).error, /does not prove this genesis/);
});

test("the genesis cache drops orders no longer on the market", () => {
  let decoded = 0;
  const counting = { ...sdk, decodeVolumeArchive: (...a) => { decoded++; return sdk.decodeVolumeArchive(...a); } };
  const a = order({ n: 11 }), b = order({ n: 12 });
  const run = (o) => judge({ sdk: counting, height: 50n, orders: [o], market: MARKET });
  run(a);
  const once = decoded;
  run(b);
  run(a);
  assert.equal(decoded, 3 * once, "a was dropped when b's market no longer held it, so it is decoded again");
});

test("a renewal names the genesis it pays for: one naming another, or none, is void, so a takeover cannot capture it", () => {
  const other = mint(PATH, { timestamp: 1_900_000_000_000 });
  const first = order({ landed: 10n });                                    // paid to 110
  const takeover = order({ n: 1, landed: 120n, value: other.value });      // holds from 120
  const late = order({ n: 2, payer: OTHER, landed: 130n, value: renewValue(GENESIS) });
  const bare = order({ n: 3, payer: OTHER, landed: 40n, value: RENEW });
  const garbage = order({ n: 4, payer: OTHER, landed: 41n, value: "renew x" });
  const v = judged([first, takeover, late, bare, garbage], { height: 150n });
  assert.match(v.get(late.key).reason, /names another genesis than the one holding this path/);
  assert.equal(v.get(takeover.key).until, 220n, "the takeover's time is not extended by it");
  assert.equal(v.get(first.key).until, 110n);
  assert.match(v.get(bare.key).reason, /names no genesis/);
  assert.match(v.get(garbage.key).reason, /names no genesis/);
  const w = renewWrite({ host: HOST, id: "o1", terms: TERMS, payer: OTHER, n: 5n, path: PATH, genesis: GENESIS, periods: 3n });
  assert.equal(w.actions[1].newValue, `renew ${GENESIS}`);
  assert.equal(w.paid, 3n * PRICE, "the price a period, the ordered chain alone");
});
