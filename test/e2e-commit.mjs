// End to end with nobody mining the sold chain: node A mines Nexus, the
// parent and the market; node B hosts them and sells hosting, and makes no
// blocks. The buyer makes its chain's blocks by committing them on the parent
// through B (`lattice child commit`), paying the parent's fee.
//
//   LATTICE=<lattice-node>/.build/debug/lattice node test/e2e-commit.mjs
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "../vendor/lattice-sdk.js";
import { keyFileJSON } from "../client/tx.mjs";
import { reader } from "../client/market.mjs";
import { judge } from "../client/verdict.mjs";
import { orderWrite, recordsBody, submit } from "../client/tx.mjs";
import { parseOffer } from "../client/records.mjs";
import { marketArgs } from "./market-chain.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LATTICE = process.env.LATTICE;
const MARKET = "Nexus/testnet/hosts", APP = "Nexus/testnet/app";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const account = () => { const privateKey = sdk.generatePrivateKey(); return { privateKey, address: sdk.accountFromPrivateKey(privateKey).address }; };
const [miner, buyer, host] = [account(), account(), account()];

function makeNode(base) {
  const root = mkdtempSync(`${tmpdir()}/hostmarket-commit-`);
  const n = { root, listen: base, rpc: base + 1, publicRead: base + 2, url: `http://127.0.0.1:${base + 2}` };
  n.lattice = (...args) => execFileSync(LATTICE, [...args, "--root", root], { encoding: "utf8" });
  // `lattice up` runs the node in the foreground; it answers once its cookie is there.
  n.up = async () => {
    const out = openSync(join(root, "node.log"), "a");
    spawn(LATTICE, ["up", "--root", root], { stdio: ["ignore", out, out], detached: true }).unref();
    await until("the node", async () => existsSync(join(root, "chains/Nexus/.cookie")), 120);
  };
  n.configure = (change) => { const f = `${root}/lattice.json`, t = JSON.parse(readFileSync(f, "utf8")); change(t); writeFileSync(f, JSON.stringify(t, null, 2)); };
  n.r = reader(sdk, n.url);
  return n;
}
const A = makeNode(27141), B = makeNode(27151);
async function until(label, condition, seconds = 900) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) { const v = await condition().catch(() => undefined); if (v) return v; if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`); await sleep(1000); }
}
const balance = async (n, path, who) => (await n.r.account(path, who)).balance;

let daemon, committing;
try {
  A.lattice("init");
  A.configure((t) => { Object.assign(t, { listen: A.listen, rpc: A.rpc, publicRead: A.publicRead, webSocket: 0, publicSubmit: true, minRelayFee: 1 });
    t.publicReadExpensiveRate = 1000; t.peers = []; });
  A.lattice("child", "create", "Nexus/testnet");
  A.lattice("child", "create", MARKET, ...marketArgs({ dir: A.root, premineTo: buyer.address }));
  // The buyer earns the parent's coin it pays commits with.
  writeFileSync(join(A.root, "miner.json"), JSON.stringify({ worker: "cpu", workers: 1, batchSize: 100000,
    recipients: { Nexus: miner.address, "Nexus/testnet": buyer.address, [MARKET]: host.address } }));
  await A.up(); A.lattice("mine", "start");
  await until("the market", async () => (await balance(A, MARKET, buyer.address)) > 0n);

  B.lattice("init");
  B.configure((t) => {
    Object.assign(t, { listen: B.listen, rpc: B.rpc, publicRead: B.publicRead, webSocket: 0, publicSubmit: true, minRelayFee: 1, hostedChains: ["Nexus/testnet", MARKET] });
    t.publicReadExpensiveRate = 1000;
    t.peers = [`${A.lattice("identity").match(/([0-9a-f]{64})@/)[1]}@127.0.0.1:${A.listen}`];
  });
  await B.up();
  await until("B synced", async () => (await B.r.tip(MARKET)).height + 2n >= (await A.r.tip(MARKET)).height && (await balance(B, "Nexus/testnet", buyer.address)) > 100n);
  say("B follows A; the buyer has parent coin", await balance(B, "Nexus/testnet", buyer.address));

  const keyFile = join(B.root, "host-key.json");
  writeFileSync(keyFile, keyFileJSON(sdk, host.privateKey), { mode: 0o600 });
  const offerFile = join(B.root, "offer.json");
  writeFileSync(offerFile, JSON.stringify({ id: "c", parent: "Nexus/testnet", price: 10, period: 2000, duration: 100000, capacity: 5,
    maxBlockSize: 100000, maxStateGrowth: 100000, minTargetBlockTime: 1000, maxNumberOfTransactionsPerBlock: 100, modules: "any" }));
  const out = openSync(join(B.root, "sell-hosting.log"), "a");
  daemon = spawn(process.execPath, [join(ROOT, "host/sell-hosting.mjs"), "--root", B.root, "--market", MARKET, "--key", keyFile, "--offer", offerFile, "--url", B.url, "--lattice", LATTICE, ...(process.env.SPONSOR ? ["--sponsor-bin", process.env.SPONSOR] : []), "--interval", "3"], { stdio: ["ignore", out, out] });
  say("host log", join(B.root, "sell-hosting.log"));
  const m0 = await until("the offer", async () => { const m = await B.r.market(MARKET); return m.offers.has(`${host.address}/c`) && m; });
  const offer = parseOffer(m0.offers.get(`${host.address}/c`));

  // The buyer orders through B, the host's own public URL.
  const spec = { maxNumberOfTransactionsPerBlock: 100n, maxStateGrowth: 100000n, maxBlockSize: 100000n, premine: 10n, targetBlockTime: 5000n, initialReward: 100n, halvingInterval: 100000n, halfLife: 100n, wasmPolicies: [] };
  for (let i = 0; ; i++) {
    try {
      const height = (await B.r.tip(MARKET)).height;
      const w = orderWrite({ host: host.address, id: "c", offer, buyer: buyer.address, path: APP, payload: { spec, premineTo: buyer.address, modules: {}, genesisTransactions: [] }, height });
      await submit(sdk, B.url, recordsBody({ signer: buyer.address, nonce: (await B.r.account(MARKET, buyer.address)).nonce, chainPath: MARKET.split("/"), actions: w.actions, payments: w.payments, fee: 1n }), buyer.privateKey);
      break;
    } catch (e) { if (i > 20) throw e; await sleep(2000); }
  }
  say("ordered", APP);

  // The buyer commits its chain's blocks, one after another, until the test ends.
  const buyerKey = join(B.root, "buyer-key.json");
  writeFileSync(buyerKey, keyFileJSON(sdk, buyer.privateKey), { mode: 0o600 });
  committing = (async () => {
    while (committing) {
      await new Promise((ok) => execFile(LATTICE, ["child", "commit", APP, "--key", buyerKey, "--root", B.root], { timeout: 15 * 60_000 }, ok));
      await sleep(1000);
    }
  })();
  await until("the chain launched by a commit (premine paid)", async () => (await balance(B, APP, buyer.address)) > 0n, 900);
  say("launched by commit");
  const g = await B.r.genesis(APP);
  const m1 = await B.r.market(MARKET);
  const v = judge({ sdk, height: m1.height, versions: m1.versions, orders: m1.orders, genesis: new Map([[APP, g]]) });
  assert.equal(v.get(m1.orders[0].key).kind, "owed", "the genesis is the one the payload builds");
  assert.ok(!(await A.lattice("status").includes(APP)), "A, the miner, does not host the sold chain");

  // A write on the sold chain lands in a block the buyer commits.
  for (let i = 0; ; i++) {
    try { await submit(sdk, B.url, recordsBody({ signer: buyer.address, nonce: (await B.r.account(APP, buyer.address)).nonce, chainPath: APP.split("/"), actions: [{ key: "hello", newValue: "world" }], fee: 1n }), buyer.privateKey); break; }
    catch (e) { if (i > 20) throw e; await sleep(2000); }
  }
  await until("the write committed", async () => (await B.r.account(APP, buyer.address)).nonce > 0n, 600);
  say("a write landed through a committed block; buyer paid", await balance(B, "Nexus/testnet", buyer.address), "parent coin left");
  say("PASS");
} finally {
  committing = undefined;
  daemon?.kill();
  if (!process.env.KEEP) for (const n of [B, A]) { try { n.lattice("mine", "stop"); } catch {} try { n.lattice("down"); } catch {} }
}
