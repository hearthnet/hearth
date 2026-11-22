// End to end on a local network, for the seller: `hearth sell` with a key
// that holds no coin paces the market and the chain it sells with no miner
// running, pays those blocks to its sponsor's key, funds its first writes
// from that key's block rewards, then runs lattice-sponsor beside the node
// (its terms bind it to the offer); `hearth status` reports the order; and `hearth stop` closes the offer while the seller keeps
// making the paid chain's blocks until its paid time ends, then exits.
//
//   LATTICE=<lattice-node>/.build/debug/lattice SPONSOR=<lattice-sponsor>/.build/debug/lattice-sponsor node test/e2e-seller.mjs
//
// A miner runs only to bring up Nexus/testnet and the market's genesis.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "../vendor/lattice-sdk.js";
import { keyFileJSON, orderWrite, recordsBody, submit } from "../client/tx.mjs";
import { reader } from "../client/market.mjs";
import { judge } from "../client/verdict.mjs";
import { CREATED_WINDOW, newestOffers, parseOffer } from "../client/records.mjs";
import { checkListed, checkServing } from "../client/service.mjs";
import { pacer } from "../host/pace.mjs";
import { marketArgs } from "./market-chain.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { LATTICE, SPONSOR } = process.env;
if (!LATTICE || !SPONSOR) throw new Error("give LATTICE and SPONSOR");
const ports = { listen: 27141, rpc: 27490, publicRead: 27491, sponsor: 27650 };
const node = `http://127.0.0.1:${ports.publicRead}`, rpc = `http://127.0.0.1:${ports.rpc}`;
const MARKET = "Nexus/testnet/hosts";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

const root = process.env.E2E_ROOT ?? mkdtempSync(`${tmpdir()}/hearth-seller-e2e-`);
const lattice = (...args) => execFileSync(LATTICE, [...args, "--root", root], { encoding: "utf8" });
const cookie = () => readFileSync(join(root, "chains/Nexus/.cookie"), "utf8").trim().replace(/^[^:]*:/, "");
const authed = (u, init = {}) => fetch(u, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${cookie()}` } });
const fragment = () => { try { return JSON.parse(readFileSync(join(root, "config.d/hostmarket.json"), "utf8")).hostedChains ?? []; } catch { return undefined; } };
const configure = (change) => { const f = `${root}/lattice.json`, t = JSON.parse(readFileSync(f, "utf8")); change(t); writeFileSync(f, JSON.stringify(t, null, 2)); };
const account = () => { const privateKey = sdk.generatePrivateKey(); return { privateKey, address: sdk.accountFromPrivateKey(privateKey).address }; };
// `bank` holds the market's premine; the seller's key starts with nothing.
const [miner, bank, buyer, host] = [account(), account(), account(), account()];
const r = reader(sdk, node);
const hearth = (...args) => new Promise((ok) => execFile(process.execPath, [join(ROOT, "bin/hearth.mjs"), ...args], { encoding: "utf8" }, (e, out, err) => ok({ code: e?.code ?? 0, out: out + err })));

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
const nonce = async (path, who) => (await r.account(path, who.address)).nonce;
const height = async (path) => (await r.tip(path)).height;
async function send(who, build, label) {
  for (let i = 0; ; i++) {
    try { const cid = await submit(sdk, node, await build(), who.privateKey); say(label, "→", cid.slice(0, 16)); return cid; } catch (e) {
      if (i > 60) throw e;
      if (i % 10 === 0) say(label, "refused, retrying:", e.message.slice(0, 160));
      await sleep(2000);
    }
  }
}

let seller, keeper;
try {
  lattice("init");
  configure((t) => { Object.assign(t, { listen: ports.listen, rpc: ports.rpc, publicRead: ports.publicRead, webSocket: 0, publicSubmit: true, minRelayFee: 1 });
    t.publicReadExpensiveRate = 1000; t.peers = []; });
  lattice("child", "create", "Nexus/testnet");
  lattice("child", "create", MARKET, ...marketArgs({ dir: root, premineTo: bank.address, overrides: { targetBlockTime: 3000 } }));
  writeFileSync(join(root, "miner.json"), JSON.stringify({ worker: "cpu", workers: 1, batchSize: 100000, recipients: { Nexus: miner.address, "Nexus/testnet": miner.address, [MARKET]: miner.address } }));
  const log = openSync(join(root, "node.log"), "a");
  spawn(LATTICE, ["up", "--root", root], { stdio: ["ignore", log, log], detached: true }).unref();
  await until("the node", async () => existsSync(join(root, "chains/Nexus/.cookie")), 120);
  lattice("mine", "start");
  say("root", root);
  await until("the market's genesis", async () => (await balance(MARKET, bank.address)) > 0n);
  await send(bank, async () => sdk.buildTransfer({ from: bank.address, to: buyer.address, amount: 5000n, fee: 1n, nonce: await nonce(MARKET, bank), chainPath: MARKET.split("/") }), "coin for the buyer");
  await until("the buyer's coin", async () => (await balance(MARKET, buyer.address)) >= 5000n);
  lattice("mine", "stop");
  say("miner stopped at market height", await height(MARKET));

  // ---- hearth sell: no miner; the pacer makes the blocks ----
  const keyFile = join(root, "hearth/seller.json");
  execFileSync("mkdir", ["-p", join(root, "hearth")]);
  writeFileSync(keyFile, keyFileJSON(sdk, host.privateKey), { mode: 0o600 });
  const offerFile = join(root, "offer.json");
  writeFileSync(offerFile, JSON.stringify({ id: "small", parent: "Nexus/testnet", price: 10, period: 20, capacity: 3,
    maxBlockSize: 100000, maxStateGrowth: 100000, minTargetBlockTime: 1000, maxNumberOfTransactionsPerBlock: 100, modules: "any" }));
  const out = openSync(join(root, "seller.log"), "a");
  seller = spawn(process.execPath, [join(ROOT, "bin/hearth.mjs"), "sell", "--offer", offerFile, "--root", root, "--market", MARKET, "--lattice", LATTICE,
    "--sponsor-bin", SPONSOR, "--sponsor-port", String(ports.sponsor), "--interval", "2", "--storage-budget", "64M"], { stdio: ["ignore", out, out] });
  const sponsorKey = JSON.parse(await until("the sponsor's key", async () => readFileSync(join(root, "hearth/sponsor.json"), "utf8"), 60));
  assert.notEqual(sponsorKey.address, host.address);
  const m0 = await until("the offer", async () => { const m = await r.market(MARKET); return m.versions.has(`${host.address}/small`) && m; }, 300);
  const offer = parseOffer(newestOffers(m0.versions).get(`${host.address}/small`));
  assert.equal(offer.blocks, sponsorKey.address, "the offer names the sponsor's key as where its blocks pay");
  assert.equal(offer.sponsor, undefined, "no --sponsor-url: no sponsor");
  assert.equal(offer.until - offer.created, 864000n, "30 days of 3-second blocks");
  // Its fees came from the sponsor key's block rewards, moved before lattice-sponsor started.
  const sellerLog = () => readFileSync(join(root, "seller.log"), "utf8");
  assert.equal((await r.account(MARKET, host.address)).nonce > 0n, true);
  assert.match(sellerLog(), /moving 4 market coin of the sponsor key's block rewards to the seller's key for its first writes/);
  assert.ok(sellerLog().indexOf("moving 4 market coin") < sellerLog().indexOf("sponsor on 127.0.0.1"), "the move before lattice-sponsor starts");
  assert.match(sellerLog(), /worst case, each chain sold adds up to 17\.3 GB a day .*51\.8 GB a day for all 3/);
  say("offer at", offer.created, "until", offer.until);
  const terms = await until("the sponsor's terms", async () => (await fetch(`http://127.0.0.1:${ports.sponsor}/terms`)).json(), 60);
  assert.equal(String(terms.storageRates[MARKET]), "10240");
  assert.equal(terms.address, sponsorKey.address, "its terms name its own address (lattice-sponsor with `address` in /terms)");
  assert.equal(terms.fundTo, undefined, "run without --funds");
  // Listed: open, and its sponsor's terms bind it to this host (as the
  // public would reach it at --sponsor-url).
  const at = (await r.market(MARKET)).height;
  assert.deepEqual(await checkListed({ offer: { ...offer, sponsor: `http://127.0.0.1:${ports.sponsor}` }, host: host.address, height: at }), { ok: true });
  assert.equal((await checkListed({ offer, host: host.address, height: at })).reason, "the offer names no sponsor");
  say("listed, sponsor up", JSON.stringify(terms));

  // ---- an order, launched and paced by the seller ----
  const appSpec = { maxNumberOfTransactionsPerBlock: 100n, maxStateGrowth: 100000n, maxBlockSize: 100000n, premine: 10n, targetBlockTime: 2000n, initialReward: 100n, halvingInterval: 100000n, halfLife: 100n, wasmPolicies: [] };
  const order = (path, periods) => send(buyer, async () => {
    const w = orderWrite({ host: host.address, id: "small", offer, buyer: buyer.address, path, payload: { spec: appSpec, premineTo: buyer.address, modules: {}, genesisTransactions: [] }, periods, height: await height(MARKET) });
    return recordsBody({ signer: buyer.address, nonce: await nonce(MARKET, buyer), chainPath: MARKET.split("/"), actions: w.actions, payments: w.payments, fee: 1n });
  }, `order ${path}`);
  // An order goes by the version in force: wait until the offer is.
  await until("the offer in force", async () => (await height(MARKET)) >= offer.created + CREATED_WINDOW, 120);
  // Eight periods: 160 market blocks, about eight minutes.
  await order("Nexus/testnet/app1", 8n);
  await until("app1 launched (premine paid)", async () => (await balance("Nexus/testnet/app1", buyer.address)) > 0n, 600);
  await until("app1's blocks paid to the sponsor", async () => { const s = await checkServing({ reader: r, chain: "Nexus/testnet/app1", offer, targetBlockTime: 2000 }); return s.ok && s.live.ok; }, 120);
  say("app1 served, fragment", fragment());
  const status = await until("hearth status after the order settled", async () => {
    const s = await hearth("status", "--root", root, "--market", MARKET, "--lattice", LATTICE, "--sponsor-port", String(ports.sponsor));
    return / and 0 renewals: earned 80 coin\n/.test(s.out) && s;
  }, 120);
  say("hearth status:\n" + status.out);
  assert.equal(status.code, 0, status.out);
  assert.match(status.out, new RegExp(`the seller's key ${host.address} holds \\d+; the sponsor's key ${sponsorKey.address} holds \\d+ \\(its block rewards\\)`));
  assert.match(status.out, /1 orders \{"owed":1\}/);
  assert.match(status.out, /owes hosting to Nexus\/testnet\/app1 \(to market block \d+\)/);
  assert.match(status.out, /storage pinned by the sponsor: 0 B of its 64\.0 MiB budget, 0 B held for uploads being paid, 64\.0 MiB left/, "the budget as given, from the sponsor's /terms");
  assert.match(status.out, /the seller runs \(pid \d+\)/);
  assert.match(readFileSync(join(root, "seller.log"), "utf8"), /owes hosting to Nexus\/testnet\/app1/, "each pass reports it too");
  // A takedown through the sponsor, with the node's cookie; the CID is refused from then on.
  const CID = "bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
  const down = await hearth("unpin", CID, "--root", root, "--sponsor-port", String(ports.sponsor));
  say("hearth unpin:\n" + down.out);
  assert.equal(down.code, 0, down.out);
  assert.match(down.out, new RegExp(`took ${CID} down: the sponsor refuses it from now on`));
  const stored = await fetch(`http://127.0.0.1:${ports.sponsor}/store`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: CID, volumes: [{ cid: CID, bytes: 10 }] }) });
  assert.equal(stored.status, 451, "a blocked CID is refused");

  // ---- each chain at its own pace: the market every 3 s, app1 every 2 s ----
  await sleep(60_000);
  // When the seller found and sent each chain's blocks (its `paced` lines),
  // and the block timestamps. A child block's timestamp is when the node
  // first built it, not when the hash came: the node reuses a hosted child's
  // block, timestamp and all, while nothing it is built from changes (up to
  // 30 s, lattice-node's ChildTemplateCache). So one gap between timestamps
  // can be short and the next long by as much; their mean is the rate the
  // difficulty schedule sees.
  const sent = (path) => readFileSync(join(root, "seller.log"), "utf8").split("\n")
    .filter((l) => l.includes(" paced ") && l.includes(` ${path}@`)).map((l) => Date.parse(l.split(" ")[0])).slice(-25);
  const gaps = (times) => times.slice(1).map((t, i) => t - times[i]);
  const stats = (g, T) => { const sorted = [...g].sort((x, y) => x - y); return { min: sorted[0], median: sorted[sorted.length >> 1], mean: Math.round(g.reduce((a, b) => a + b, 0) / g.length), under: T ? g.filter((x) => x < T).length : null, of: g.length }; };
  const pace = {};
  for (const [path, T] of [[MARKET, 3000], ["Nexus/testnet/app1", 2000], ["Nexus/testnet", null]]) {
    const stamped = (await r.recentBlocks(path, { max: 25 })).reverse().map((b) => b.timestamp);
    pace[path] = { T, sent: stats(gaps(sent(path)), T), stamped: stats(gaps(stamped), T) };
  }
  say(`block gaps (ms): ${JSON.stringify(pace)}`);
  // Each round excludes the chains not due, so no paced chain gets a block
  // before its tip is T old. The market and app1 are siblings: neither
  // carries the other. Nexus/testnet is the one exception, named: their
  // ancestor, carried with each, it gets a block from a hash that clears
  // either whenever its target is easier (the pacer skips the hashes that
  // would clear it while it is harder). Its gaps are shown, not checked.
  for (const path of [MARKET, "Nexus/testnet/app1"]) {
    const { T, sent: s, stamped: b } = pace[path];
    assert.ok(s.of >= 10 && s.under === 0, `${path}, sent: ${JSON.stringify(s)}`);
    assert.ok(b.mean >= 0.9 * T, `${path}, stamped: ${JSON.stringify(b)}`);
  }

  // ---- hearth stop: closed, and the seller keeps serving what is paid ----
  const stopped = await hearth("stop", "--root", root, "--market", MARKET, "--lattice", LATTICE);
  const stoppedAt = Date.now();
  say("hearth stop:\n" + stopped.out);
  assert.equal(stopped.code, 0, stopped.out);
  const closedAt = BigInt(/closed small at market block (\d+): no new orders once it takes effect at block (\d+)/.exec(stopped.out)?.[1] ?? -1);
  assert.ok(closedAt > 0n, stopped.out);
  assert.match(stopped.out, /1 chains have paid time left, the last to market block \d+ .*: the seller \(pid \d+\) keeps hosting them, making their blocks and sponsoring them/);
  assert.equal(seller.exitCode, null, "the seller still runs");
  assert.deepEqual(fragment(), ["Nexus/testnet", "Nexus/testnet/app1", MARKET]);
  await until("app1's blocks after the close", async () => (await r.recentBlocks("Nexus/testnet/app1", { max: 5 })).some((b) => b.timestamp > stoppedAt && b.rewardRecipient === sponsorKey.address), 60);
  await until("the sponsor still up", async () => (await fetch(`http://127.0.0.1:${ports.sponsor}/terms`)).ok, 10);

  // An order once the close is in force is void; the seller hosts nothing for it.
  await until("the close in force", async () => (await height(MARKET)) >= closedAt + CREATED_WINDOW, 120);
  await order("Nexus/testnet/late", 1n);
  const v = await until("the late order judged", async () => {
    const m = await r.market(MARKET);
    const late = m.orders.find((o) => o.path === "Nexus/testnet/late");
    const verdict = late && judge({ sdk, height: m.height, versions: m.versions, orders: m.orders, renewals: m.renewals }).get(late.key);
    return verdict?.kind !== "pending" && verdict;
  }, 300);
  assert.deepEqual([v.kind, v.reason], ["void", `the offer was closed at market block ${closedAt}`]);

  // Once app1's paid time ends, the seller drops its fragment and exits 0.
  await until("the seller done", async () => seller.exitCode !== null, 900);
  assert.equal(seller.exitCode, 0);
  assert.equal(fragment(), undefined, "the fragment is gone");
  await until("the sponsor gone", async () => fetch(`http://127.0.0.1:${ports.sponsor}/terms`).then(() => false, () => true), 30);
  const restarted = spawnSync(process.execPath, [join(ROOT, "bin/hearth.mjs"), "sell", "--offer", offerFile, "--root", root, "--market", MARKET, "--lattice", LATTICE,
    "--sponsor-bin", SPONSOR, "--sponsor-port", String(ports.sponsor), "--interval", "2", "--resume"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(restarted.status, 0, restarted.stdout + restarted.stderr);
  assert.match(restarted.stdout, /closed: nothing paid is left/, "a service restart closes again, and reopens nothing");
  assert.ok(parseOffer(newestOffers((await r.market(MARKET)).versions).get(`${host.address}/small`)).until === closedAt, "still closed");

  const now = await hearth("stop", "--now", "--root", root, "--market", MARKET, "--lattice", LATTICE);
  say("hearth stop --now:\n" + now.out);
  assert.match(now.out, new RegExp(`the offers were closed at market block ${closedAt}`));
  assert.match(now.out, /nobody had paid time left/);
  say("PASS");
} finally {
  keeper?.stop();
  seller?.kill();
  if (!process.env.KEEP) { try { lattice("mine", "stop"); } catch {} try { lattice("down"); } catch {} }
}
