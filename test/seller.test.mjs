// What a seller runs beside its node: the pacer that makes its chains'
// blocks, the checks buyers run on those blocks, the node gates, `hearth
// stop`'s close, and `hearth earn`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { formatOffer, isClosed, offerText, orderKey, formatPayload, parseOffer } from "../client/records.mjs";
import { judge } from "../client/verdict.mjs";
import { CLOCK_SLACK_MS, checkListed, checkServing, listed, live, servingWindow, serving } from "../client/service.mjs";
import { DEFAULT_MARKET, markClosing, markReopen, nodeVersion, sellerFiles, sponsorBooks, startsReopened, sweep, sweepReserve, syncProgress } from "../host/hearth.mjs";
import { exclusions, pacer } from "../host/pace.mjs";
import { closedAt, closingActions, closingDone, paidTime } from "../host/stop.mjs";
import { policyCID, SPEC as SPEC_FILE } from "./market-chain.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { earn } from "../host/earn.mjs";

const key = (n) => sdk.accountFromPrivateKey(new Uint8Array(32).fill(n)).address;
const HOST = key(1), BUYER = key(2), PAYS = key(3), OTHER = key(4);
const MAX = (1n << 256n) - 1n;
const listen = async (handler) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
};
const json = (res, body, status = 200, headers = {}) => res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));

/**
 * A node whose template carries `chains` (`{ path: { blockTime, target,
 * fresh, syncing } }`): a submitted nonce makes a block, now, on every chain
 * whose target its hash clears. A `fresh` chain's tip is always new, as when
 * other miners keep it moving; a `syncing` one is behind its best header.
 */
// A node hosting `chains` (and Nexus, Nexus/testnet). `old` ignores a
// template's `exclude`, as a node from before it does; `listsLate` names a
// chain its first `GET /config` does not list yet.
async function miningNode(chains, { old = false, listsLate } = {}) {
  const blocks = Object.fromEntries(Object.keys(chains).map((p) => [p, []]));
  const templates = new Map(), requests = [];
  const hosted = ["Nexus", "Nexus/testnet", ...Object.keys(chains)];
  let n = 0, configs = 0;
  const node = await listen((req, res, body) => {
    const url = new URL(req.url, "http://x"), path = url.searchParams.get("chainPath");
    if (url.pathname === "/config") {
      const listed = hosted.filter((p) => configs > 0 || p !== listsLate);
      configs++;
      return json(res, { status: { chains: listed.map((p) => ({ path: p, from: ["deploy"], actual: "hosted" })) } });
    }
    if (url.pathname === "/status") return json(res, { height: "5", bestHeaderHeight: chains[path].syncing ? "9" : "5" });
    if (url.pathname === "/api/chain/spec") return json(res, { targetBlockTime: String(chains[path].blockTime) });
    if (url.pathname === "/api/blocks") {
      const tip = chains[path].fresh ? { timestamp: String(Date.now()) } : blocks[path].at(-1);
      return json(res, { blocks: tip ? [tip] : [] });
    }
    if (url.pathname === "/mining/templates") {
      const request = JSON.parse(body);
      requests.push(request);
      const out = new Set(old ? [] : (request.exclude ?? []).map((x) => x.join("/")));
      if (hosted.some((p) => !out.has(p) && [...out].some((x) => p.startsWith(`${x}/`)))) return json(res, { error: "excludedAncestor" }, 400);
      const carried = Object.keys(chains).filter((p) => !out.has(p));
      const workID = `w${n++}`, prefixHex = createHash("sha256").update(workID).digest("hex");
      templates.set(workID, { prefixHex, carried });
      return json(res, { workID, prefixHex, searchTarget: `0x${MAX.toString(16)}`,
        chains: carried.map((p) => ({ chainPath: p.split("/"), target: `0x${chains[p].target.toString(16)}`, height: String(blocks[p].length) })) });
    }
    if (url.pathname === "/mining/work") {
      const { workID, nonce } = JSON.parse(body), be = Buffer.alloc(8);
      be.writeBigUInt64BE(BigInt(nonce));
      const { prefixHex, carried } = templates.get(workID);
      const hash = BigInt(`0x${createHash("sha256").update(Buffer.from(prefixHex, "hex")).update(be).digest("hex")}`);
      const recipient = requests.at(-1)?.recipients?.[0]?.address;
      // One hit, one timestamp: the blocks it makes are found together.
      const at = String(Date.now());
      for (const p of carried) if (hash <= chains[p].target) blocks[p].push({ timestamp: at, rewardRecipient: recipient });
      return json(res, { disposition: "childOnly" });
    }
    json(res, {}, 404);
  });
  return { ...node, blocks, requests };
}

const TERMS = { parent: "Nexus/testnet", price: 50n, period: 100n, capacity: 5n, maxBlockSize: 100000n, maxStateGrowth: 100000n,
  minTargetBlockTime: 1000n, maxNumberOfTransactionsPerBlock: 100n, modules: "any", blocks: PAYS };
const at = (created, o) => offerText(created, formatOffer({ ...TERMS, ...o }));

test("the pacer makes each chain's block once its tip is a target block time old, paid to the sponsor's address", async () => {
  const A = "Nexus/testnet/a", B = "Nexus/testnet/b", C = "Nexus/testnet/c", D = "Nexus/testnet/d";
  // A round for one chain excludes the rest, so none takes a block early.
  const node = await miningNode({ [A]: { blockTime: 200, target: MAX }, [B]: { blockTime: 600, target: MAX >> 4n }, [C]: { blockTime: 200, target: MAX >> 40n, fresh: true },
    [D]: { blockTime: 200, target: MAX, syncing: true } });
  const lines = [];
  const began = Date.now();
  const p = pacer({ rpc: node.url, fetchImpl: (...x) => fetch(...x), to: PAYS, chains: () => [A, B, C, D], log: (l) => lines.push(l), idle: 20 });
  await new Promise((r) => setTimeout(r, 2000));
  p.stop();
  await p.done;
  node.close();
  // Bounds from the time it actually ran: a loaded machine runs fewer rounds, never more.
  const elapsed = Date.now() - began;
  const gaps = (bs) => bs.slice(1).map((b, i) => Number(b.timestamp) - Number(bs[i].timestamp));
  assert.ok(node.blocks[B].length >= 1 && node.blocks[B].length <= Math.floor(elapsed / 600) + 1, `B: ${node.blocks[B].length} blocks in ${elapsed} ms at 600 ms`);
  assert.ok(node.blocks[A].length >= 2 && node.blocks[A].length <= Math.floor(elapsed / 200) + 1, `A: ${node.blocks[A].length} blocks in ${elapsed} ms at 200 ms`);
  assert.ok(gaps(node.blocks[B]).every((g) => g >= 600), `B: ${gaps(node.blocks[B])}`);
  assert.ok(gaps(node.blocks[A]).every((g) => g >= 200), `A, easier, is excluded from B's rounds: ${gaps(node.blocks[A])}`);
  assert.equal(node.blocks[C].length, 0, "a chain others keep moving gets no block");
  assert.equal(node.blocks[D].length, 0, "a chain the node is syncing gets no block");
  assert.ok(lines.some((l) => l.startsWith(`pacer: ${D} is syncing`)), lines.join("\n"));
  assert.ok([...node.blocks[A], ...node.blocks[B]].every((b) => b.rewardRecipient === PAYS));
  assert.deepEqual(node.requests[0].recipients.map((r) => r.chainPath.join("/")), ["Nexus", "Nexus/testnet", A, B, C, D], "every level of every paced chain pays the sponsor");
  assert.ok(node.requests.every((r) => [C, D].every((x) => r.exclude?.some((e) => e.join("/") === x))), "each round excludes the chains not due");
  assert.ok(lines.some((l) => l.startsWith(`paced ${A}@`)), lines.join("\n"));
});

test("exclude: every hosted chain not due and with none due below it, so a due chain keeps its ancestors", () => {
  const hosted = ["Nexus", "Nexus/testnet", "Nexus/testnet/hosts", "Nexus/testnet/app", "Nexus/testnet/app/sub", "Nexus/testnet/other", "Nexus/testnet/other/sub"];
  assert.deepEqual(exclusions({ hosted, due: ["Nexus/testnet/app/sub"] }), ["Nexus/testnet/hosts", "Nexus/testnet/other", "Nexus/testnet/other/sub"]);
  assert.deepEqual(exclusions({ hosted, due: ["Nexus/testnet/hosts", "Nexus/testnet/app"] }), ["Nexus/testnet/app/sub", "Nexus/testnet/other", "Nexus/testnet/other/sub"]);
  assert.deepEqual(exclusions({ hosted, due: ["Nexus/testnet"] }), ["Nexus/testnet/app", "Nexus/testnet/app/sub", "Nexus/testnet/hosts", "Nexus/testnet/other", "Nexus/testnet/other/sub"]);
});

test("a due chain's easier ancestor still gets the block its hash clears", async () => {
  const P = "Nexus/testnet/p", Q = "Nexus/testnet/p/q";
  const node = await miningNode({ [P]: { blockTime: 60_000, target: MAX }, [Q]: { blockTime: 300, target: MAX >> 2n } });
  const p = pacer({ rpc: node.url, fetchImpl: (...x) => fetch(...x), to: PAYS, chains: () => [P, Q], log: () => {}, idle: 20 });
  await new Promise((r) => setTimeout(r, 1000));
  p.stop();
  await p.done;
  node.close();
  assert.ok(node.blocks[Q].length >= 2, `Q: ${node.blocks[Q].length}`);
  assert.ok(node.requests.every((r) => !r.exclude), "P, Q's parent, is never excluded");
  const withP = new Set(node.blocks[P].map((b) => b.timestamp));
  assert.ok(node.blocks[Q].every((b) => withP.has(b.timestamp)), "each hash for Q makes P's block too");
});

test("a node without exclude: the pacer skips hashes that would clear a harder chain not due", async () => {
  const A = "Nexus/testnet/a", B = "Nexus/testnet/b";
  const node = await miningNode({ [A]: { blockTime: 200, target: MAX }, [B]: { blockTime: 600, target: MAX >> 4n } }, { old: true });
  const p = pacer({ rpc: node.url, fetchImpl: (...x) => fetch(...x), to: PAYS, chains: () => [A, B], log: () => {}, idle: 20 });
  await new Promise((r) => setTimeout(r, 2000));
  p.stop();
  await p.done;
  node.close();
  const gaps = (bs) => bs.slice(1).map((b, i) => Number(b.timestamp) - Number(bs[i].timestamp));
  assert.ok(node.blocks[A].length >= 2 && node.blocks[B].length >= 1);
  assert.ok(gaps(node.blocks[B]).every((g) => g >= 600), `B, harder, is skipped by A's rounds (which would clear it one time in 16): ${gaps(node.blocks[B])}`);
  // A, easier, cannot be skipped: a hash for B clears it too.
  const withB = new Set(node.blocks[B].map((b) => b.timestamp));
  assert.ok(node.blocks[A].slice(1).every((b, i) => Number(b.timestamp) - Number(node.blocks[A][i].timestamp) >= 200 || withB.has(b.timestamp)), `A: ${gaps(node.blocks[A])}`);
});

test("refused with excludedAncestor (a chain newly hosted under an excluded one), the pacer reads the hosted chains again and retries once", async () => {
  const A = "Nexus/testnet/a", P = "Nexus/testnet/p", X = "Nexus/testnet/p/x";
  const node = await miningNode({ [A]: { blockTime: 60_000, target: MAX }, [P]: { blockTime: 200, target: MAX, fresh: true }, [X]: { blockTime: 200, target: MAX, fresh: true } }, { listsLate: X });
  const lines = [];
  const p = pacer({ rpc: node.url, fetchImpl: (...x) => fetch(...x), to: PAYS, chains: () => [A], log: (l) => lines.push(l), idle: 20 });
  await new Promise((r) => setTimeout(r, 500));
  p.stop();
  await p.done;
  node.close();
  assert.deepEqual(node.requests.slice(0, 2).map((r) => r.exclude.map((x) => x.join("/"))), [[P], [P, X]]);
  assert.equal(node.blocks[A].length, 1, lines.join("\n"));
  assert.equal(node.blocks[P].length + node.blocks[X].length, 0);
});

test("after a miss, the pacer waits the chain's whole target block time", async () => {
  const E = "Nexus/testnet/e";
  const node = await miningNode({ [E]: { blockTime: 500, target: 0n } });
  const lines = [];
  const began = Date.now();
  const p = pacer({ rpc: node.url, fetchImpl: (...x) => fetch(...x), to: PAYS, chains: () => [E], log: (l) => lines.push(l), idle: 20, maxHashes: 1000n });
  await new Promise((r) => setTimeout(r, 1800));
  p.stop();
  await p.done;
  node.close();
  const elapsed = Date.now() - began;
  assert.ok(node.requests.length >= 2 && node.requests.length <= Math.floor(elapsed / 500) + 1, `${node.requests.length} templates in ${elapsed} ms at 500 ms`);
  assert.ok(lines.some((l) => /no hit for .* in 1000 hashes/.test(l)), lines.join("\n"));
});

test("listed: the offer is open and its sponsor's terms bind it to this host", async () => {
  const offer = { ...TERMS, created: 100n, until: 5000n, sponsor: "https://host.example/sponsor" };
  const terms = { address: PAYS, payTo: HOST };
  assert.deepEqual(listed({ offer, terms, host: HOST, height: 200n }), { ok: true });
  assert.deepEqual(listed({ offer, terms: { fundTo: PAYS, payTo: HOST }, host: HOST, height: 200n }), { ok: true }, "fundTo, from a sponsor before `address`");
  assert.equal(listed({ offer, terms: { address: OTHER, fundTo: PAYS, payTo: HOST }, host: HOST, height: 200n }).ok, false, "`address` first");
  assert.equal(listed({ offer: { ...offer, sponsor: "http://host.example/sponsor" }, terms, host: HOST, height: 200n }).reason, "its sponsor is not an https URL");
  assert.deepEqual(listed({ offer: { ...offer, sponsor: "http://127.0.0.1:8650" }, terms, host: HOST, height: 200n }), { ok: true }, "a sponsor on loopback");
  assert.deepEqual(listed({ offer, terms, host: HOST, height: 5000n }), { ok: false, reason: "the offer is not open" });
  assert.deepEqual(listed({ offer: { ...offer, until: 100n }, terms, host: HOST, height: 200n }).reason, "the offer is not open", "closed");
  assert.equal(listed({ offer: { ...offer, sponsor: undefined }, terms, host: HOST, height: 200n }).reason, "the offer names no sponsor");
  assert.equal(listed({ offer: { ...offer, blocks: undefined }, terms, host: HOST, height: 200n }).reason, "the offer names no address its blocks pay");
  assert.equal(listed({ offer, terms: undefined, host: HOST, height: 200n }).reason, "its sponsor does not answer");
  assert.equal(listed({ offer, terms: { ...terms, address: OTHER }, host: HOST, height: 200n }).reason, "its sponsor's address is not the one its blocks pay", "another host's sponsor");
  assert.equal(listed({ offer, terms: { ...terms, payTo: OTHER }, host: HOST, height: 200n }).reason, "its sponsor does not pay this host");
  const asked = [];
  const fetchImpl = async (url, init) => { asked.push([url, !!init.signal]); return new Response(JSON.stringify(terms)); };
  assert.deepEqual(await checkListed({ offer, host: HOST, height: 200n, fetchImpl }), { ok: true });
  assert.deepEqual(asked, [["https://host.example/sponsor/terms", true]], "GET /terms, with a timeout");
  assert.equal((await checkListed({ offer, host: HOST, height: 200n, fetchImpl: async () => { throw new Error("refused"); } })).reason, "its sponsor does not answer");
  asked.length = 0;
  assert.equal((await checkListed({ offer: { ...offer, sponsor: "http://host.example" }, host: HOST, height: 200n, fetchImpl })).ok, false);
  assert.deepEqual(asked, [], "never asks a plain-http sponsor");
});

test("serving: the host's address credited on the chain within max(24 h, 10 T); live: any block within 3 T; both with clock slack", async () => {
  const offer = { blocks: PAYS };
  const now = 10_000_000_000, day = 24 * 3600 * 1000;
  assert.equal(servingWindow(5000), day);
  assert.equal(servingWindow(3 * 3600 * 1000), 30 * 3600 * 1000, "ten blocks of a slow chain");
  assert.deepEqual(serving({ blocks: [{ rewardRecipient: PAYS, timestamp: now - day }], offer, targetBlockTime: 5000, now }), { ok: true });
  assert.deepEqual(serving({ blocks: [{ rewardRecipient: PAYS, timestamp: now - day - CLOCK_SLACK_MS + 1 }], offer, targetBlockTime: 5000, now }), { ok: true }, "within the slack");
  assert.equal(serving({ blocks: [{ rewardRecipient: PAYS, timestamp: now - day - CLOCK_SLACK_MS }, { rewardRecipient: OTHER, timestamp: now }], offer, targetBlockTime: 5000, now }).ok, false);
  assert.equal(serving({ blocks: [{ rewardRecipient: PAYS, timestamp: now }], offer: {}, targetBlockTime: 5000, now }).reason, "the offer names no address its blocks pay");
  assert.deepEqual(live({ blocks: [{ rewardRecipient: OTHER, timestamp: now - 15000 - CLOCK_SLACK_MS + 1 }], targetBlockTime: 5000, now }), { ok: true }, "from anyone");
  assert.equal(live({ blocks: [{ timestamp: now - 15000 - CLOCK_SLACK_MS }], targetBlockTime: 5000, now }).ok, false);
  // Bounded, and it stops at the host's first block.
  const asked = [];
  const reader = { recentBlocks: async (chain, bounds) => { asked.push([chain, bounds]); return [{ rewardRecipient: PAYS, timestamp: now }]; } };
  assert.deepEqual(await checkServing({ reader, chain: "M/app", offer, targetBlockTime: 5000, now }), { ok: true, live: { ok: true } });
  assert.deepEqual(asked.map(([c, b]) => [c, b.since, b.max]), [["M/app", now - day - CLOCK_SLACK_MS, 1000]]);
  assert.equal(asked[0][1].stop({ rewardRecipient: PAYS }), true);
  assert.equal(asked[0][1].stop({ rewardRecipient: OTHER }), false);
  // A read that hit its cap before the window's start has no verdict.
  const capped = Object.assign([{ rewardRecipient: OTHER, timestamp: now }], { complete: false });
  assert.deepEqual(serving({ blocks: capped, offer, targetBlockTime: 5000, now, complete: false }), { ok: false, reason: "unknown" });
  const cappedReader = { recentBlocks: async () => capped };
  assert.deepEqual(await checkServing({ reader: cappedReader, chain: "M/app", offer, targetBlockTime: 5000, now }), { ok: false, reason: "unknown", live: { ok: true } });
  const whole = Object.assign([{ rewardRecipient: OTHER, timestamp: now }], { complete: true });
  assert.equal((await checkServing({ reader: { recentBlocks: async () => whole }, chain: "M/app", offer, targetBlockTime: 5000, now })).reason, "no block of this chain pays the host lately");
});

test("the node gates: GET /config says which layer lists each chain (Lattice 4.0.1), and a chain counts as synced once its tip is at the best header its peers showed", async () => {
  const fake = (config) => async (url) => (new URL(url).pathname === "/status" ? new Response(JSON.stringify({ version: "4.0.0+dev" }))
    : config ? new Response(JSON.stringify(config)) : new Response("", { status: 404 }));
  assert.equal(await nodeVersion("http://127.0.0.1:1", fake({ fragments: ["lattice", "operator"], status: { chains: [{ path: "Nexus/m", actual: "hosted", from: ["operator"] }] } })), "4.0.0+dev", "a node hosting a child");
  assert.equal(await nodeVersion("http://127.0.0.1:1", fake({ fragments: ["lattice"], status: { chains: [] } })), "4.0.0+dev", "a fresh node hosts no child, and lists no chain");
  for (const old of [undefined, { status: {} }, { status: { chains: [] } }, { fragments: ["lattice"], status: { chains: [{ path: "Nexus/m", actual: "hosted" }] } }]) {
    await assert.rejects(nodeVersion("http://127.0.0.1:1", fake(old)), (e) => e.tooOld && /needs Lattice 5\.0\.0 or newer \(you have 4\.0\.0\+dev/.test(e.message), JSON.stringify(old));
  }
  assert.deepEqual(syncProgress({ height: "5", bestHeaderHeight: "10" }), { synced: false, height: 5n, best: 10n, line: "syncing market: 5 / 10" });
  assert.equal(syncProgress({ height: "10", bestHeaderHeight: "10" }).synced, true);
  assert.equal(syncProgress({ height: "0" }).line, "syncing market: 0 / ?", "no header from a peer yet: not synced");
  assert.equal(syncProgress({ height: "0" }).synced, false);
});

test("chain/spec.json names chain/policy.wasm by its own CID, the module the market (chain/market.json) runs", () => {
  const spec = JSON.parse(readFileSync(SPEC_FILE, "utf8"));
  assert.deepEqual(spec.wasmPolicies.map((p) => p.moduleCID), [policyCID()]);
  const market = JSON.parse(readFileSync(new URL("../chain/market.json", import.meta.url), "utf8"));
  assert.equal(market.path, DEFAULT_MARKET);
  assert.equal(market.moduleCID, policyCID(), "the market runs this build of policy/src");
});


test("`hearth stop` closes each of the key's offers still on sale with a version that ends where it is written", () => {
  const newest = new Map([
    [`${HOST}/live`, at(100n, { until: 5000n, mines: 9n })],
    [`${HOST}/ended`, at(100n, { until: 200n })],
    [`${HOST}/closed`, at(300n, { until: 300n })],
    [`${OTHER}/theirs`, at(100n, { until: 5000n })],
  ]);
  const actions = closingActions({ newest, self: HOST, height: 400n });
  assert.deepEqual(actions.map((a) => [a.id, a.key]), [["live", `offer/${HOST}/live/400`]]);
  const closed = parseOffer(offerText(400n, actions[0].newValue));
  assert.equal(isClosed(closed), true);
  assert.deepEqual({ ...closed, created: undefined, until: undefined }, { ...TERMS, created: undefined, until: undefined }, "the same terms, closed");
});

test("after a close, the chains with paid time left are those owed and active; orders still settling are counted", () => {
  const SPEC = { maxNumberOfTransactionsPerBlock: 10n, maxStateGrowth: 1000n, maxBlockSize: 1000n, premine: 0n, targetBlockTime: 5000n, initialReward: 10n, halvingInterval: 1000n, halfLife: 100n, wasmPolicies: [] };
  const payloadText = formatPayload({ spec: SPEC, premineTo: null, modules: {}, genesisTransactions: [] });
  const order = (path, created, paid = 50n) => ({ key: orderKey({ host: HOST, id: "o", payer: BUYER, height: created, paid, path }), host: HOST, id: "o", buyer: BUYER, payer: BUYER, created, paid, path, payloadText });
  const orders = [order("Nexus/testnet/kept", 300n, 500n), order("Nexus/testnet/lapsed", 120n), order("Nexus/testnet/late", 600n), order("Nexus/testnet/new", 598n)];
  const versions = new Map([[`${HOST}/o`, [at(100n, { until: 5000n }), at(600n, { until: 600n })]]]);
  const height = 610n;
  const verdicts = judge({ sdk, height, versions, orders });
  const { paid, settling } = paidTime({ orders, verdicts });
  assert.deepEqual([...paid], [["Nexus/testnet/kept", 1300n]], "ten periods from 300; the lapsed one has none left");
  assert.equal(verdicts.get(orders[2].key).kind, "pending");
  assert.equal(settling, 2, "the orders at 598 and 600, before the close takes effect (610), still settle: owed once judged");
  assert.equal(closedAt({ newest: new Map([[`${HOST}/o`, at(600n, { until: 600n })], [`${OTHER}/o`, at(700n, { until: 700n })]]), self: HOST }), 600n);
  assert.equal(closedAt({ newest: new Map([[`${HOST}/o`, at(100n, { until: 5000n })]]), self: HOST }), undefined, "nothing closed");
});

test("`hearth earn` works for the sponsor's payouts until the address holds enough, waiting out 429s", async () => {
  let shares = 0, refusedWork = 0, refusedShares = 0, earnedAsked = 0;
  const sponsor = await listen((req, res, body) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/s/work") {
      assert.deepEqual(JSON.parse(body), { chain: "M", payTo: BUYER });
      if (refusedWork++ === 0) return json(res, { error: "busy" }, 429, { "Retry-After": "0" });
      return json(res, { prefixHex: "00", shareTarget: "f".repeat(64), startNonce: "0", count: "1000000", assignment: "a", expiresInMilliseconds: "5000" });
    }
    if (url.pathname === "/s/shares") {
      if (refusedShares++ === 1) return json(res, { error: "slow down" }, 429);
      shares++;
      return json(res, { credit: String(shares) });
    }
    if (url.pathname === "/s/earnings") { earnedAsked++; return json(res, { earned: String(shares), payoutAt: "25", paying: false }); }
    json(res, {}, 404);
  });
  const lines = [];
  const have = await earn({ sponsor: `${sponsor.url}/s`, chain: "M", payTo: BUYER, workers: 1, until: 5n, balance: async () => BigInt(shares), log: (l) => lines.push(l), every: 50 });
  sponsor.close();
  assert.ok(have >= 5n);
  assert.ok(refusedWork >= 2 && refusedShares >= 2, "it asked again after each 429");
  assert.ok(earnedAsked >= 1 && lines.some((l) => /earned \d+ of the 25 a payout needs/.test(l)), lines.join("\n"));
});

test("a closing seller is done once nothing is on sale, settling or paid, also when it never wrote a close", () => {
  const base = { live: [], closed: 600n, height: 626n, pending: false, owed: 0 };
  assert.deepEqual(closingDone(base), { done: true });
  assert.deepEqual(closingDone({ ...base, closed: undefined, height: 5n }), { done: true }, "its offers ran out, or it had none: nothing to wait for");
  assert.equal(closingDone({ ...base, closed: undefined, owed: 1 }).line, "serving 1 paid chains");
  assert.equal(closingDone({ ...base, closed: undefined, pending: true }).line, "orders still settle");
  assert.equal(closingDone({ ...base, height: 625n }).line, "orders settle until market block 626");
  assert.match(closingDone({ ...base, live: [{ id: "o" }] }).line, /waiting for the close of o/);
});

test("the operator reopens: a foreground `hearth sell`, or `--install` for the service's next start; a service restart never does", () => {
  const files = sellerFiles({ root: mkdtempSync(join(tmpdir(), "hearth-files-")) });
  markReopen(files);
  writeFileSync(files.closing, "x");
  assert.equal(startsReopened({ resume: true, files }), true, "the service after --install");
  assert.equal(existsSync(files.closing), false, "no longer closing");
  assert.equal(existsSync(files.reopen), false, "the mark is read once");
  assert.equal(startsReopened({ resume: true, files }), false, "a later restart, even one that wrote nothing, does not reopen");
  // --install, then hearth stop before the service starts: the stop wins.
  markReopen(files);
  markClosing(files);
  assert.equal(startsReopened({ resume: true, files }), false, "install, stop, --resume start: no reopen");
  assert.equal(existsSync(files.closing), true, "still closing");
  writeFileSync(files.closing, "x");
  markReopen(files);
  assert.equal(existsSync(files.closing), false, "--install clears it at once");
  writeFileSync(files.closing, "x");
  assert.equal(startsReopened({ resume: false, files }), true, "a foreground hearth sell");
  const quiet = sellerFiles({ root: mkdtempSync(join(tmpdir(), "hearth-files-")) });
  mkdirSync(quiet.dir, { recursive: true });
  writeFileSync(quiet.closing, "x");
  assert.equal(startsReopened({ resume: true, files: quiet }), false, "a restart with no reopen mark");
  assert.equal(existsSync(quiet.closing), true, "stays closing");
});

test("sweep leaves the float, the sponsor's holds and fund deposits, and refuses while a signed transaction may take a nonce", async () => {
  const key = new Uint8Array(32).fill(9), self = sdk.accountFromPrivateKey(key).address;
  const dir = mkdtempSync(join(tmpdir(), "hearth-sponsor-"));
  writeFileSync(join(dir, "lattice-sponsor-holds.json"), JSON.stringify([{ chain: "M", signer: self, nonce: "3", fee: "5" }, { chain: "M", signer: OTHER, nonce: "1", fee: "50" }, { chain: "N", signer: self, nonce: "1", fee: "7" }]));
  writeFileSync(join(dir, "lattice-sponsor-funds.json"), JSON.stringify([{ chain: "M", prefixes: ["a/"], deposit: "40" }]));
  const books = sponsorBooks(dir);
  assert.deepEqual(sponsorBooks(mkdtempSync(join(tmpdir(), "hearth-sponsor-"))), { holds: [], funds: [] }, "no files: none");
  assert.equal(sweepReserve({ chain: "M", self, float: 100n, ...books }), 145n, "float 100 + its own hold 5 + deposit 40");
  const sent = [];
  const node = (nonce, balance) => async (url, init) => {
    const u = new URL(url);
    if (u.pathname.startsWith("/api/state/account/")) return new Response(JSON.stringify({ balance: String(balance), nonce: String(nonce) }));
    if (u.pathname === "/api/chain/info") return new Response(JSON.stringify({ minRelayFee: "1" }));
    if (u.pathname === "/transactions") { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ transactionCID: "bafy" })); }
    return new Response("", { status: 404 });
  };
  await assert.rejects(sweep({ sdk, node: "http://127.0.0.1:1", fetchImpl: node(3n, 1000n), privateKey: key, to: HOST, chain: "M", float: 100n, ...books }), /signed transactions on M that have not landed/);
  assert.equal(sent.length, 0);
  const done = await sweep({ sdk, node: "http://127.0.0.1:1", fetchImpl: node(4n, 1000n), privateKey: key, to: HOST, chain: "M", float: 100n, ...books });
  assert.deepEqual([done.amount, done.reserve], [1000n - 145n - 1n, 145n]);
  assert.equal(sent.length, 1);
  assert.equal(await sweep({ sdk, node: "http://127.0.0.1:1", fetchImpl: node(4n, 146n), privateKey: key, to: HOST, chain: "M", float: 100n, ...books }), undefined, "nothing above the reserve and fee");
});
