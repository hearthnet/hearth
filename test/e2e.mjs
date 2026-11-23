// End to end on a local network: a real node mining Nexus, Nexus/testnet
// and the market chain, a coin seller, a buyer with no node, and a host
// running sell-hosting.
//
//   LATTICE=<lattice-node>/.build/debug/lattice node test/e2e.mjs
//
// The buyer buys market coin with parent coin from `hearth sell-coin` (deposit, receipt,
// withdrawal), orders a chain, and the host launches it; an order outside
// the offer's limits is void and never hosted; a lapsed chain is dropped.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "../vendor/lattice-sdk.js";
import { keyFileJSON } from "../client/tx.mjs";
import { reader } from "../client/market.mjs";
import { judge } from "../client/verdict.mjs";
import { orderWrite, renewWrite, recordsBody, depositBody, receiptBody, withdrawalBody, submit } from "../client/tx.mjs";
import { parseOffer, strictJSON } from "../client/records.mjs";
import { marketArgs } from "./market-chain.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LATTICE = process.env.LATTICE;
const ports = { listen: 26141, rpc: 26490, publicRead: 26491 };
const node = `http://127.0.0.1:${ports.publicRead}`;
const MARKET = "Nexus/testnet/hosts";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

const root = process.env.E2E_ROOT ?? mkdtempSync(`${tmpdir()}/hostmarket-e2e-`);
const lattice = (...args) => execFileSync(LATTICE, [...args, "--root", root], { encoding: "utf8" });
// `lattice up` runs the node in the foreground; it answers once its cookie is there.
const up = async () => {
  const out = openSync(join(root, "node.log"), "a");
  spawn(LATTICE, ["up", "--root", root], { stdio: ["ignore", out, out], detached: true }).unref();
  await until("the node", async () => existsSync(join(root, "chains/Nexus/.cookie")), 120);
};
const cookie = () => readFileSync(join(root, "chains/Nexus/.cookie"), "utf8").trim().replace(/^[^:]*:/, "");
const fragment = () => { try { return JSON.parse(readFileSync(join(root, "config.d/hostmarket.json"), "utf8")).hostedChains ?? []; } catch { return []; } };
const configure = (change) => { const f = `${root}/lattice.json`, t = JSON.parse(readFileSync(f, "utf8")); change(t); writeFileSync(f, JSON.stringify(t, null, 2)); };
const account = () => { const privateKey = sdk.generatePrivateKey(); return { privateKey, address: sdk.accountFromPrivateKey(privateKey).address }; };
const [miner, seller, buyer, host] = [account(), account(), account(), account()];
const r = reader(sdk, node);

async function until(label, condition, seconds = 600) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const v = await condition().catch(() => undefined);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(1000);
  }
}
const balance = async (path, who) => (await r.account(path, who)).balance;
const height = async (path) => (await r.tip(path)).height;
const fee = 1n;

/** Send a body signed by `who`, retrying refusals a later block may clear (a receipt not yet seen, a nonce). */
async function send(who, build, label) {
  for (let i = 0; ; i++) {
    try {
      const body = await build();
      const cid = await submit(sdk, node, body, who.privateKey);
      say(label, "→", cid.slice(0, 16));
      return cid;
    } catch (e) {
      if (i > 120) throw e;
      if (i % 10 === 0) say(label, "refused, retrying:", e.message.slice(0, 160));
      await sleep(2000);
    }
  }
}
const nonce = async (path, who) => (await r.account(path, who.address)).nonce;

let daemon;
try {
  lattice("init");
  configure((t) => { Object.assign(t, { listen: ports.listen, rpc: ports.rpc, publicRead: ports.publicRead, webSocket: 0, publicSubmit: true, minRelayFee: 1 });
    t.publicReadExpensiveRate = 1000; t.peers = []; });
  lattice("child", "create", "Nexus/testnet");
  lattice("child", "create", MARKET, ...marketArgs({ dir: root, premineTo: seller.address }));
  // The miner's own settings, not the node's.
  writeFileSync(join(root, "miner.json"), JSON.stringify({ worker: "cpu", workers: 1, batchSize: 100000,
    recipients: { Nexus: miner.address, "Nexus/testnet": buyer.address, [MARKET]: host.address } }));
  await up(); lattice("mine", "start");
  say("root", root);
  await until("the market's genesis", async () => (await balance(MARKET, seller.address)) > 0n);
  await until("the buyer's parent coin", async () => (await balance("Nexus/testnet", buyer.address)) >= 5000n);
  await until("the host's market coin for fees", async () => (await balance(MARKET, host.address)) >= 10n);
  say("chains up; seller", await balance(MARKET, seller.address), "buyer parent coin", await balance("Nexus/testnet", buyer.address));

  // ---- buying market coin: the seller locks it with `hearth sell-coin` ----
  const sellerKey = join(root, "seller-key.json");
  writeFileSync(sellerKey, keyFileJSON(sdk, seller.privateKey), { mode: 0o600 });
  const sellCoin = (amount, price) => execFileSync(process.execPath, [join(ROOT, "bin/hearth.mjs"), "sell-coin", String(amount), "--price", String(price), "--float", "10",
    "--market", MARKET, "--root", root, "--key", sellerKey, "--lattice", LATTICE], { encoding: "utf8" });
  const mine = async (amount) => (await r.deposits(MARKET)).find((d) => d.demander === seller.address && d.amountDeposited === amount);
  say(sellCoin(4000, 2000).trim());
  const deposit = await until("the deposit listed", () => mine(4000n));
  assert.equal(deposit.amountDemanded, 2000n);
  assert.match(sellCoin(4000, 2000), /^already on sale: .*Nothing sent/m, "a retry locks no second deposit");
  assert.equal((await r.deposits(MARKET, { prefix: `${seller.address}/` })).length, 1);
  const sellerParentBefore = await balance("Nexus/testnet", seller.address);
  await send(buyer, async () => receiptBody({ buyer: buyer.address, nonce: await nonce("Nexus/testnet", buyer), parentPath: ["Nexus", "testnet"], directory: "hosts", deposit, fee }), "receipt");
  await until("the receipt on the parent", async () => (await r.receipt("Nexus/testnet", "hosts", deposit)) === buyer.address);
  assert.equal(await balance("Nexus/testnet", seller.address), sellerParentBefore + 2000n, "the seller is paid on the parent, with nothing to claim");
  await send(buyer, async () => withdrawalBody({ buyer: buyer.address, nonce: await nonce(MARKET, buyer), chainPath: MARKET.split("/"), deposit, fee }), "withdrawal");
  await until("the buyer's market coin", async () => (await balance(MARKET, buyer.address)) === 3999n);
  assert.equal(await r.deposit(MARKET, deposit), 0n, "the deposit is spent");
  say("bought 3999 market coin for 2000 parent coin");
  // No cancel: an unsold deposit comes back only the way any buyer takes it,
  // the seller paying its price to itself on the parent.
  const kept = await balance(MARKET, seller.address);
  sellCoin(100, 50);
  const own = await until("the second deposit listed", () => mine(100n));
  await send(seller, async () => receiptBody({ buyer: seller.address, nonce: await nonce("Nexus/testnet", seller), parentPath: ["Nexus", "testnet"], directory: "hosts", deposit: own, fee }), "self-receipt");
  await until("the self-receipt", async () => (await r.receipt("Nexus/testnet", "hosts", own)) === seller.address);
  await send(seller, async () => withdrawalBody({ buyer: seller.address, nonce: await nonce(MARKET, seller), chainPath: MARKET.split("/"), deposit: own, fee }), "self-withdrawal");
  await until("the deposit back", async () => (await r.deposit(MARKET, own)) === 0n);
  assert.equal(await balance(MARKET, seller.address), kept - 2n, "back, less two market fees");
  say("the seller took back its own unsold deposit by paying itself");

  // ---- the host's offer, written by sell-hosting ----
  const offerFile = join(root, "offer.json");
  writeFileSync(offerFile, JSON.stringify({ id: "small", parent: "Nexus/testnet", price: 100, period: 200, duration: 100000, capacity: 3,
    maxBlockSize: 100000, maxStateGrowth: 100000, minTargetBlockTime: 1000, maxNumberOfTransactionsPerBlock: 100, modules: "any" }));
  const keyFile = join(root, "host-key.json");
  writeFileSync(keyFile, keyFileJSON(sdk, host.privateKey), { mode: 0o600 });
  const out = openSync(join(root, "sell-hosting.log"), "a");
  daemon = spawn(process.execPath, [join(ROOT, "host/sell-hosting.mjs"), "--root", root, "--market", MARKET, "--key", keyFile, "--offer", offerFile, "--url", node, "--lattice", LATTICE, ...(process.env.SPONSOR ? ["--sponsor-bin", process.env.SPONSOR] : []), "--interval", "3"], { stdio: ["ignore", out, out] });
  const m0 = await until("the offer", async () => { const m = await r.market(MARKET); return m.offers.has(`${host.address}/small`) && m.urls.has(host.address) && m; });
  const offer = parseOffer(m0.offers.get(`${host.address}/small`));
  say("offer", offer.price, "per", offer.period, "blocks");

  // ---- orders ----
  const appSpec = { maxNumberOfTransactionsPerBlock: 100n, maxStateGrowth: 100000n, maxBlockSize: 100000n, premine: 10n, targetBlockTime: 5000n, initialReward: 100n, halvingInterval: 100000n, halfLife: 100n, wasmPolicies: [] };
  const order = async (path, spec, periods = 1n) => {
    const h = await height(MARKET);
    return send(buyer, async () => {
      const w = orderWrite({ host: host.address, id: "small", offer, buyer: buyer.address, path, payload: { spec, premineTo: buyer.address, modules: {}, genesisTransactions: [] }, periods, height: await height(MARKET) });
      return recordsBody({ signer: buyer.address, nonce: await nonce(MARKET, buyer), chainPath: MARKET.split("/"), actions: w.actions, payments: w.payments, fee });
    }, `order ${path} at ${h}`);
  };
  await order("Nexus/testnet/app1", appSpec, 2n);
  await order("Nexus/testnet/big", { ...appSpec, maxBlockSize: 200000n });
  await until("the buyer's chain launched (premine paid)", async () => (await balance("Nexus/testnet/app1", buyer.address)) > 0n, 900);
  say("app1 launched");

  // Every order judged: an order retried after a refusal settles later.
  const { kinds, verdicts, m1 } = await until("every order settled", async () => {
    const m1 = await r.market(MARKET);
    const genesis = new Map([["Nexus/testnet/app1", await r.genesis("Nexus/testnet/app1")]]);
    const verdicts = judge({ sdk, height: m1.height, versions: m1.versions, orders: m1.orders, renewals: m1.renewals, genesis });
    const k = Object.fromEntries(m1.orders.map((o) => [o.path, verdicts.get(o.key).kind]));
    return Object.values(k).includes("pending") ? undefined : { kinds: k, verdicts, m1 };
  });
  say("verdicts", JSON.stringify(kinds));
  assert.equal(kinds["Nexus/testnet/app1"], "owed");
  assert.equal(kinds["Nexus/testnet/big"], "void");
  const hosted = (await (await fetch(`http://127.0.0.1:${ports.rpc}/hosted-chains`, { headers: { Authorization: `Bearer ${cookie()}` } })).json()).chains;
  assert.ok(hosted.includes("Nexus/testnet/app1") && !hosted.includes("Nexus/testnet/big"), `hosted: ${hosted}`);
  assert.deepEqual(fragment(), ["Nexus/testnet", "Nexus/testnet/app1", MARKET], "the seller lists the market, its offer's parent and what it owes in its own fragment");

  // ---- the buyer writes on its new chain through the host ----
  await send(buyer, async () => recordsBody({ signer: buyer.address, nonce: await nonce("Nexus/testnet/app1", buyer), chainPath: ["Nexus", "testnet", "app1"], actions: [{ key: "hello", newValue: "world" }], fee }), "write on app1");
  await until("the write in a block", async () => (await r.account("Nexus/testnet/app1", buyer.address)).nonce > 0n);

  // ---- renewal: someone else pays one more period, written as its own record ----
  const app1 = m1.orders.find((o) => o.path === "Nexus/testnet/app1");
  const before = verdicts.get(app1.key).until;
  await send(seller, async () => {
    const w = renewWrite({ host: host.address, id: "small", offer, payer: seller.address, path: app1.path, height: await height(MARKET) });
    return recordsBody({ signer: seller.address, nonce: await nonce(MARKET, seller), chainPath: MARKET.split("/"), actions: w.actions, payments: w.payments, fee });
  }, "renewal of app1");
  const v = await until("the renewal counted", async () => {
    const m = await r.market(MARKET);
    const w = judge({ sdk, height: m.height, versions: m.versions, orders: m.orders, renewals: m.renewals }).get(app1.key);
    return w.until > before && w;
  });
  assert.equal(v.until, before + offer.period, "one more period on the paid time");

  // ---- lapse: the paid time runs out, and the host drops the chain ----
  say("app1 paid until market height", v.until, "was", before);
  await until("app1 dropped after its paid time", async () => {
    const chains = (await (await fetch(`http://127.0.0.1:${ports.rpc}/hosted-chains`, { headers: { Authorization: `Bearer ${cookie()}` } })).json()).chains;
    return !chains.includes("Nexus/testnet/app1");
  }, 1800);
  assert.deepEqual(fragment(), ["Nexus/testnet", MARKET], "a lapsed chain leaves the seller's fragment");
  const hostedAfter = (await (await fetch(`http://127.0.0.1:${ports.rpc}/hosted-chains`, { headers: { Authorization: `Bearer ${cookie()}` } })).json()).chains;
  assert.ok(hostedAfter.includes("Nexus/testnet") && hostedAfter.includes(MARKET), "the operator's own chains stay");
  say("PASS");
} finally {
  daemon?.kill();
  if (!process.env.KEEP) { try { lattice("mine", "stop"); } catch {} try { lattice("down"); } catch {} }
}
