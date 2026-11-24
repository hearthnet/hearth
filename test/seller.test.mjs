// The seller's parts, each against a fake node: the miner, launching an
// owed chain, the node's gates, earning, reopening and sweeping.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { moduleCID } from "../client/records.mjs";
import { DEFAULT_MARKET, markClosing, markReopen, nodeVersion, sellerChains, sellerFiles, sponsorBooks, startsReopened, sweep, sweepReserve, syncProgress } from "../host/hearth.mjs";
import { miner } from "../host/pace.mjs";
import { launch } from "../host/launch.mjs";
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

test("the miner mines every chain the node hosts, every level paying the sponsor's address, and takes a fresh template after each hit", async () => {
  const hosted = ["Nexus/testnet", "Nexus/testnet/hearth", "Nexus/testnet/app"];
  const requests = [], work = [];
  let n = 0;
  const node = await listen((req, res, body) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/config") return json(res, { status: { chains: [...hosted.map((path) => ({ path, actual: "hosted" })), { path: "Nexus/testnet/gone", actual: "stopped" }] } });
    if (url.pathname === "/mining/templates") {
      requests.push(JSON.parse(body));
      const workID = `w${n++}`;
      return json(res, { workID, prefixHex: createHash("sha256").update(workID).digest("hex"), searchTarget: `0x${MAX.toString(16)}`,
        chains: hosted.map((p) => ({ chainPath: p.split("/"), target: `0x${(p.endsWith("app") ? MAX : 0n).toString(16)}`, height: "3" })) });
    }
    if (url.pathname === "/mining/work") { work.push(JSON.parse(body)); return json(res, { disposition: "childOnly" }); }
    json(res, {}, 404);
  });
  const lines = [];
  const m = miner({ rpc: node.url, fetchImpl: (...x) => fetch(...x), to: PAYS, log: (l) => lines.push(l), batch: 1000n, idle: 20 });
  while (work.length < 3) await new Promise((r) => setTimeout(r, 10));
  m.stop();
  await m.done;
  node.close();
  assert.deepEqual(requests[0].recipients, ["Nexus", ...hosted].map((p) => ({ chainPath: p.split("/"), address: PAYS })), "Nexus and every hosted chain, none stopped");
  assert.deepEqual(work.slice(0, 3).map((w) => w.workID), ["w0", "w1", "w2"], "one hit a template");
  assert.ok(lines.includes("mined Nexus/testnet/app@3: childOnly"), lines.join("\n"));
  assert.equal(m.rate(), 0, "no rate before its first minute");
});

test("with no chain in its template yet, the miner says so and waits", async () => {
  const node = await listen((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/config") return json(res, { status: { chains: [] } });
    if (url.pathname === "/mining/templates") return json(res, { workID: "w", prefixHex: "00", searchTarget: "0x0", chains: [] });
    json(res, {}, 404);
  });
  const lines = [];
  const m = miner({ rpc: node.url, fetchImpl: (...x) => fetch(...x), to: PAYS, log: (l) => lines.push(l), idle: 20 });
  await new Promise((r) => setTimeout(r, 200));
  m.stop();
  await m.done;
  node.close();
  assert.deepEqual(lines, ["miner: the node's template carries no chain yet"], "said once");
});

const fixture = JSON.parse(readFileSync(new URL("./fixtures/genesis-testnet-hearth.json", import.meta.url), "utf8"));
const MODULE = readFileSync(new URL("../chain/policy-v3.wasm", import.meta.url)).toString("base64");

test("launch: pins every Volume and module of the genesis, then submits the genesis block with its proofs until the node weighs it", async () => {
  const calls = [];
  const rpc = (status) => async (route, body) => { calls.push([route, body]); return { body: route === "/child-blocks" ? { blockCID: fixture.genesis, status } : { pins: [] } }; };
  const extra = Buffer.from("not wasm").toString("base64");
  const genesis = { cid: fixture.genesis, volumes: fixture.volumes, modules: { [moduleCID(sdk, MODULE)]: MODULE, [moduleCID(sdk, extra)]: extra }, proofs: ["AAAA", "BBBB"] };
  assert.equal(await launch({ rpc: rpc("tree"), path: "Nexus/testnet/app", genesis }), "tree");
  const pins = calls.filter(([r]) => r === "/pins").map(([, b]) => b);
  assert.deepEqual(pins.map((p) => p.cid), [...Object.keys(fixture.volumes), moduleCID(sdk, extra)], "each Volume, and each module no Volume holds");
  for (const p of pins.slice(0, -1)) {
    const volume = sdk.decodeVolumeArchive(p.cid, Buffer.from(fixture.volumes[p.cid], "base64"));
    assert.deepEqual(Object.keys(p.entries).sort(), volume.entries.map((e) => e.cid).sort(), "every entry of the Volume, by CID");
  }
  assert.equal(moduleCID(sdk, extra), sdk.cidV1DagCbor(Buffer.from(Object.values(pins.at(-1).entries)[0], "base64")), "a module's entry is its node, which its CID names");
  const [route, submit] = calls.at(-1);
  assert.equal(route, "/child-blocks", "the block after its content");
  assert.deepEqual(submit.chainPath, ["Nexus", "testnet", "app"]);
  assert.deepEqual(submit.proofs, ["AAAA", "BBBB"]);
  const block = sdk.decodeCanonicalBlock(Buffer.from(submit.block, "base64"));
  assert.equal(sdk.cidV1DagCbor(Buffer.from(submit.block, "base64")), fixture.genesis, "the genesis block's own bytes");
  assert.equal(sdk.cidV1DagCbor(Buffer.from(submit.children, "base64")), block.childrenCID);
  assert.equal(sdk.cidV1DagCbor(Buffer.from(submit.spec, "base64")), block.specCID);
  assert.equal(await launch({ rpc: rpc("awaiting"), path: "Nexus/testnet/app", genesis }), "awaiting", "not weighed yet: the seller tries again next pass");
  const { [fixture.genesis]: _, ...noBlock } = fixture.volumes;
  await assert.rejects(launch({ rpc: rpc("tree"), path: "Nexus/testnet/app", genesis: { ...genesis, volumes: noBlock } }), /carries no block/);
});

test("the fragment lists the market and every owed chain, each with the chains above it, never Nexus", () => {
  assert.deepEqual(sellerChains({ market: DEFAULT_MARKET }), ["Nexus/testnet", DEFAULT_MARKET]);
  assert.deepEqual(sellerChains({ market: DEFAULT_MARKET, owed: ["Nexus/other/deep/app", "Nexus/b", "Nexus/testnet/a"] }),
    ["Nexus/b", "Nexus/other", "Nexus/testnet", "Nexus/other/deep", "Nexus/testnet/a", DEFAULT_MARKET, "Nexus/other/deep/app"], "any path, its ancestors first");
});

test("the node gates: GET /config says which layer lists each chain (Lattice 4.0.1), and a chain counts as synced once its tip is at the best header its peers showed", async () => {
  const fake = (config) => async (url) => (new URL(url).pathname === "/status" ? new Response(JSON.stringify({ version: "4.0.0+dev" }))
    : config ? new Response(JSON.stringify(config)) : new Response("", { status: 404 }));
  assert.equal(await nodeVersion("http://127.0.0.1:1", fake({ fragments: ["lattice", "operator"], status: { chains: [{ path: "Nexus/m", actual: "hosted", from: ["operator"] }] } })), "4.0.0+dev", "a node hosting a child");
  assert.equal(await nodeVersion("http://127.0.0.1:1", fake({ fragments: ["lattice"], status: { chains: [] } })), "4.0.0+dev", "a fresh node hosts no child, and lists no chain");
  for (const old of [undefined, { status: {} }, { status: { chains: [] } }, { fragments: ["lattice"], status: { chains: [{ path: "Nexus/m", actual: "hosted" }] } }]) {
    await assert.rejects(nodeVersion("http://127.0.0.1:1", fake(old)), (e) => e.tooOld && /needs node 5\.0\.0 or newer \(you have 4\.0\.0\+dev/.test(e.message), JSON.stringify(old));
  }
  assert.deepEqual(syncProgress({ height: "5", bestHeaderHeight: "10" }), { synced: false, height: 5n, best: 10n, line: "syncing market: 5 / 10" });
  assert.equal(syncProgress({ height: "10", bestHeaderHeight: "10" }).synced, true);
  assert.equal(syncProgress({ height: "0" }).line, "syncing market: 0 / ?", "no header from a peer yet: not synced");
  assert.equal(syncProgress({ height: "0" }).synced, false);
});

test("chain/spec.json names chain/policy.wasm by its own CID, the module the old market (chain/market.json) runs", () => {
  const spec = JSON.parse(readFileSync(new URL("../chain/spec.json", import.meta.url), "utf8"));
  const cid = moduleCID(sdk, readFileSync(new URL("../chain/policy.wasm", import.meta.url)).toString("base64"));
  assert.deepEqual(spec.wasmPolicies.map((p) => p.moduleCID), [cid]);
  assert.equal(JSON.parse(readFileSync(new URL("../chain/market.json", import.meta.url), "utf8")).moduleCID, cid);
});

test("the default market is the v3 market on testnet, whose spec names chain/policy-v3.wasm by its own CID", () => {
  const market = JSON.parse(readFileSync(new URL("../chain/market-v3-testnet.json", import.meta.url), "utf8"));
  const spec = JSON.parse(readFileSync(new URL("../chain/spec-v3-testnet.json", import.meta.url), "utf8"));
  assert.equal(market.path, DEFAULT_MARKET);
  assert.equal(market.moduleCID, moduleCID(sdk, MODULE), "the market runs this build of policy/src");
  assert.deepEqual(spec.wasmPolicies.map((p) => p.moduleCID), [market.moduleCID]);
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
