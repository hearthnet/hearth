// End to end on a local network, for the seller: `hearth sell` with a key
// that holds no coin mines the market with no other miner running, pays
// those blocks to its sponsor's key, funds its offer from that key's block
// rewards, writes the offer at the hash rate it measured, then runs
// lattice-sponsor beside the node; `hearth status` reports; and `hearth stop`
// deletes the offer, after which the seller, owing nothing, exits.
//
//   LATTICE=<lattice-node>/.build/debug/lattice SPONSOR=<lattice-sponsor>/.build/debug/lattice-sponsor node test/e2e-seller.mjs
//
// A miner runs only to bring up Nexus/testnet and the market's genesis. An
// order (a genesis the buyer mints, with its child-only proof) and its launch
// on the seller's node are not covered here: host/launch.mjs is unit tested
// against a fake node until nodes take the proofs.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "../vendor/lattice-sdk.js";
import { keyFileJSON } from "../client/tx.mjs";
import { reader } from "../client/market.mjs";
import { parseOffer } from "../client/records.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { LATTICE, SPONSOR } = process.env;
if (!LATTICE || !SPONSOR) throw new Error("give LATTICE and SPONSOR");
const ports = { listen: 27141, rpc: 27490, publicRead: 27491, sponsor: 27650 };
const node = `http://127.0.0.1:${ports.publicRead}`;
const MARKET = "Nexus/testnet/hosts";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

const root = process.env.E2E_ROOT ?? mkdtempSync(`${tmpdir()}/hearth-seller-e2e-`);
const lattice = (...args) => execFileSync(LATTICE, [...args, "--root", root], { encoding: "utf8" });
const fragment = () => { try { return JSON.parse(readFileSync(join(root, "config.d/hostmarket.json"), "utf8")).hostedChains ?? []; } catch { return undefined; } };
const configure = (change) => { const f = `${root}/lattice.json`, t = JSON.parse(readFileSync(f, "utf8")); change(t); writeFileSync(f, JSON.stringify(t, null, 2)); };
const account = () => { const privateKey = sdk.generatePrivateKey(); return { privateKey, address: sdk.accountFromPrivateKey(privateKey).address }; };
// `bank` holds the market's premine; the seller's key starts with nothing.
const [miner, bank, host] = [account(), account(), account()];
const r = reader(sdk, node);
const hearth = (...args) => new Promise((ok) => execFile(process.execPath, [join(ROOT, "bin/hearth.mjs"), ...args], { encoding: "utf8" }, (e, out, err) => ok({ code: e?.code ?? 0, out: out + err })));
/** The v3 market's spec (chain/spec-v3-testnet.json, with `overrides`) and policy, as `lattice child create` takes them. */
function marketArgs(overrides) {
  const file = join(root, "market-spec.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(join(ROOT, "chain/spec-v3-testnet.json"), "utf8")), ...overrides }));
  return ["--spec", file, "--policy-module", join(ROOT, "chain/policy-v3.wasm"), "--premine-to", bank.address];
}

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

let seller, keeper;
try {
  lattice("init");
  configure((t) => { Object.assign(t, { listen: ports.listen, rpc: ports.rpc, publicRead: ports.publicRead, webSocket: 0, publicSubmit: true, minRelayFee: 1 });
    t.publicReadExpensiveRate = 1000; t.peers = []; });
  lattice("child", "create", "Nexus/testnet");
  lattice("child", "create", MARKET, ...marketArgs({ targetBlockTime: 3000 }));
  writeFileSync(join(root, "miner.json"), JSON.stringify({ worker: "cpu", workers: 1, batchSize: 100000, recipients: { Nexus: miner.address, "Nexus/testnet": miner.address, [MARKET]: miner.address } }));
  const log = openSync(join(root, "node.log"), "a");
  spawn(LATTICE, ["up", "--root", root], { stdio: ["ignore", log, log], detached: true }).unref();
  await until("the node", async () => existsSync(join(root, "chains/Nexus/.cookie")), 120);
  lattice("mine", "start");
  say("root", root);
  await until("the market's genesis", async () => (await balance(MARKET, bank.address)) > 0n);
  lattice("mine", "stop");
  say("miner stopped at market height", await height(MARKET));

  // ---- hearth sell: no other miner; the seller's makes the blocks ----
  const keyFile = join(root, "hearth/seller.json");
  execFileSync("mkdir", ["-p", join(root, "hearth")]);
  writeFileSync(keyFile, keyFileJSON(sdk, host.privateKey), { mode: 0o600 });
  const sellFlags = ["--throughput", "3", "--storage", "1", "--period", "20", "--id", "small", "--root", root, "--market", MARKET, "--lattice", LATTICE,
    "--sponsor-bin", SPONSOR, "--sponsor-port", String(ports.sponsor), "--interval", "2", "--storage-budget", "64M"];
  const out = openSync(join(root, "seller.log"), "a");
  seller = spawn(process.execPath, [join(ROOT, "bin/hearth.mjs"), "sell", ...sellFlags], { stdio: ["ignore", out, out] });
  const sponsorKey = JSON.parse(await until("the sponsor's key", async () => readFileSync(join(root, "hearth/sponsor.json"), "utf8"), 60));
  assert.notEqual(sponsorKey.address, host.address);
  const sellerLog = () => readFileSync(join(root, "seller.log"), "utf8");
  const m0 = await until("the offer", async () => { const m = await r.market(MARKET); return m.offers.has(`${host.address}/small`) && m; }, 300);
  const offer = parseOffer(m0.offers.get(`${host.address}/small`));
  assert.equal(offer.blocks, sponsorKey.address, "the offer names the sponsor's key as where its blocks pay");
  assert.deepEqual([offer.throughput, offer.storage, offer.period], [3n, 1n, 20n]);
  assert.ok(offer.hashrate > 0n, "the hash rate its miner measured");
  assert.match(sellerLog(), /miner: \d+ hashes per second/);
  assert.match(sellerLog(), /the offer waits for the miner's first minute/);
  // Its fees came from the sponsor key's block rewards, moved before lattice-sponsor started.
  assert.equal((await r.account(MARKET, host.address)).nonce > 0n, true);
  assert.match(sellerLog(), /moving 2 market coin of the sponsor key's block rewards to the seller's key for its offer and its close/);
  assert.ok(sellerLog().indexOf("moving 2 market coin") < sellerLog().indexOf("sponsor on 127.0.0.1"), "the move before lattice-sponsor starts");
  assert.deepEqual(fragment(), ["Nexus/testnet", MARKET]);
  say("offer", JSON.stringify(offer, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  const terms = await until("the sponsor's terms", async () => (await fetch(`http://127.0.0.1:${ports.sponsor}/terms`)).json(), 60);
  assert.equal(String(terms.storageRates[MARKET]), "10240");
  assert.equal(terms.address, sponsorKey.address, "its terms name its own address");
  // The market's blocks come from the seller alone, paid to its sponsor.
  const mined = await until("market blocks paid to the sponsor", async () => (await r.recentBlocks(MARKET, { max: 10 })).filter((b) => b.rewardRecipient === sponsorKey.address).length >= 3 && true, 120);
  assert.ok(mined);

  const status = await hearth("status", "--root", root, "--market", MARKET, "--lattice", LATTICE, "--sponsor-port", String(ports.sponsor));
  say("hearth status:\n" + status.out);
  assert.equal(status.code, 0, status.out);
  assert.match(status.out, new RegExp(`the seller's key ${host.address} holds \\d+; the sponsor's key ${sponsorKey.address} holds \\d+ \\(its block rewards\\)`));
  assert.match(status.out, /0 orders and renewals \{\}: earned 0 coin from buyers/);
  assert.match(status.out, /owes hosting to no chain now/);
  assert.match(status.out, /storage pinned by the sponsor: 0 B of its 64\.0 MiB budget/);
  assert.match(status.out, /the seller runs \(pid \d+\)/);

  // A takedown through the sponsor, with the node's cookie; the CID is refused from then on.
  const CID = "bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
  const down = await hearth("unpin", CID, "--root", root, "--sponsor-port", String(ports.sponsor));
  assert.equal(down.code, 0, down.out);
  assert.match(down.out, new RegExp(`took ${CID} down: the sponsor refuses it from now on`));

  // ---- hearth stop: the offer is deleted; owing nothing, the seller exits ----
  const stopped = await hearth("stop", "--root", root, "--market", MARKET, "--lattice", LATTICE);
  say("hearth stop:\n" + stopped.out);
  assert.equal(stopped.code, 0, stopped.out);
  assert.match(stopped.out, /closed small at market block \d+: no order lands on it from then on/);
  assert.doesNotMatch(stopped.out, /not in a block yet/, "the seller mines the market while it closes");
  assert.equal((await r.market(MARKET)).offers.has(`${host.address}/small`), false, "the offer is gone");
  await until("the seller done", async () => seller.exitCode !== null, 120);
  assert.equal(seller.exitCode, 0);
  assert.match(sellerLog(), /closed: nothing paid is left/);
  assert.equal(fragment(), undefined, "the fragment is gone");
  await until("the sponsor gone", async () => fetch(`http://127.0.0.1:${ports.sponsor}/terms`).then(() => false, () => true), 30);
  // A service restart stays closing: it writes no offer, and exits.
  const restarted = spawnSync(process.execPath, [join(ROOT, "bin/hearth.mjs"), "sell", ...sellFlags, "--resume"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(restarted.status, 0, restarted.stdout + restarted.stderr);
  assert.match(restarted.stdout, /closed: nothing paid is left/, "a service restart closes again, and reopens nothing");
  assert.equal((await r.market(MARKET)).offers.has(`${host.address}/small`), false, "still closed");

  const now = await hearth("stop", "--now", "--root", root, "--market", MARKET, "--lattice", LATTICE);
  say("hearth stop --now:\n" + now.out);
  assert.match(now.out, /no offer of this key is on sale/);
  assert.match(now.out, /nobody had paid time left/);
  say("PASS");
} finally {
  keeper?.stop();
  seller?.kill();
  if (!process.env.KEEP) { try { lattice("mine", "stop"); } catch {} try { lattice("down"); } catch {} }
}
