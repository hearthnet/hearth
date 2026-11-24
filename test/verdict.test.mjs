// The v3 market's records and verdicts, judged from a real genesis
// (Nexus/testnet/hearth's, minted by lattice-node 5.0.0).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { RENEW, chainPrice, formatOffer, formatOrderValue, orderKey, parseGenesis, parseOffer, parseOrderKey, parseOrderValue, pathPrice } from "../client/records.mjs";
import { judge } from "../client/verdict.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/genesis-testnet-hearth.json", import.meta.url), "utf8"));
const MODULE = readFileSync(new URL("../chain/policy-v3.wasm", import.meta.url)).toString("base64");
const VALUE = formatOrderValue({ genesis: fixture.genesis, volumes: fixture.volumes, modules: { bafyreidjwv6eawkoknszzpbbw5zurltzhrhpzdkj4g4hsdidj76a6sqfdi: MODULE } });
const key = (n) => sdk.accountFromPrivateKey(new Uint8Array(32).fill(n)).address;
const HOST = key(1), BUYER = key(2), OTHER = key(3);
const OFFER = { hashrate: 1000000n, throughput: 3n, storage: 1n, period: 100n, blocks: HOST };
const TERMS = formatOffer(OFFER);
// The fixture's spec: 1 MB blocks every 60 s, 1 MB state growth: 50 + 1000 per chain at OFFER.
const SPEC = { maxBlockSize: 1000000, targetBlockTime: 60000, maxStateGrowth: 1000000 };
const SPECS = new Map([["Nexus", SPEC], ["Nexus/testnet", SPEC]]);
const PRICE = 3n * 1050n;
const PATH = "Nexus/testnet/app";

const order = ({ n = 0, paid = PRICE, path = PATH, value = VALUE, landed = 10n, terms = TERMS, payer = BUYER } = {}) => {
  const k = orderKey({ host: HOST, id: "o1", payer, n, paid, path });
  return { key: k, ...parseOrderKey(k), value, landed, terms };
};

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
  const g = parseGenesis(sdk, parseOrderValue(VALUE));
  assert.equal(g.error, undefined);
  assert.equal(g.cid, fixture.genesis);
  assert.equal(BigInt(g.spec.maxBlockSize), 1000000n);
  const other = Object.keys(fixture.volumes).find((c) => c !== fixture.genesis);
  const swapped = { ...fixture.volumes, [fixture.genesis]: fixture.volumes[other] };
  assert.match(parseGenesis(sdk, parseOrderValue(formatOrderValue({ genesis: fixture.genesis, volumes: swapped, modules: {} }))).error, /does not match its CID/);
  assert.match(parseGenesis(sdk, parseOrderValue(formatOrderValue({ genesis: fixture.genesis, volumes: fixture.volumes, modules: {} }))).error, /not exactly the spec's/);
  assert.match(parseOrderValue("{}").error, /keys/);
});

test("an order is owed from the block it landed in, for the periods it paid", () => {
  const v = judge({ sdk, height: 50n, orders: [order({ paid: 2n * PRICE + 1n })], specs: SPECS });
  const [verdict] = v.values();
  assert.equal(verdict.kind, "owed");
  assert.equal(verdict.from, 10n);
  assert.equal(verdict.until, 10n + 200n);
  assert.equal(verdict.active, true);
  assert.equal(verdict.genesis, fixture.genesis);
});

test("an order is void when it pays less than a period for the whole path, or its genesis does not check out", () => {
  const short = judge({ sdk, height: 50n, orders: [order({ paid: PRICE - 1n })], specs: SPECS });
  assert.match([...short.values()][0].reason, /less than one period for the whole path/);
  const shallow = judge({ sdk, height: 50n, orders: [order({ paid: 2n * 1050n, path: "Nexus/app" })], specs: SPECS });
  assert.equal([...shallow.values()][0].kind, "owed", "a shorter path costs less");
  const bad = judge({ sdk, height: 50n, orders: [order({ value: "{}" })], specs: SPECS });
  assert.equal([...bad.values()][0].kind, "void");
  const noTerms = judge({ sdk, height: 50n, orders: [order({ terms: null })], specs: SPECS });
  assert.match([...noTerms.values()][0].reason, /terms/);
});

test("an order waits for the specs above its path", () => {
  const v = judge({ sdk, height: 50n, orders: [order()], specs: new Map([["Nexus", SPEC]]) });
  assert.equal([...v.values()][0].kind, "unpriced");
});

test("renewals extend paid time at the terms each landed on; one that ran out restarts where it landed", () => {
  const first = order();
  const renew = order({ n: 1, payer: OTHER, landed: 60n, value: RENEW, paid: PRICE });
  const late = order({ n: 2, landed: 500n, value: RENEW, paid: PRICE, terms: formatOffer({ ...OFFER, period: 10n }) });
  const v = judge({ sdk, height: 600n, orders: [late, renew, first], specs: SPECS });
  assert.equal(v.get(first.key).until, 500n + 10n);
  assert.equal(v.get(renew.key).kind, "renewal");
  const early = order({ n: 3, landed: 5n, value: RENEW });
  assert.equal(judge({ sdk, height: 600n, orders: [early, first], specs: SPECS }).get(early.key).kind, "void", "a renewal before any order");
});
