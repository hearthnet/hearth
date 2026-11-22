// A local market to work on the web app against: a node mining Nexus,
// Nexus/testnet and the market, a coin seller with several sales open, a host
// selling hosting, and a faucet for the parent coin (local only).
//
//   LATTICE=<lattice-node>/.build/debug/lattice node test/devnet.mjs
//   open http://127.0.0.1:8765/?node=http://127.0.0.1:26491&market=Nexus/testnet/hosts&blockSeconds=2
//   curl -X POST 'http://127.0.0.1:26500/?to=<address>'   parent coin for an address
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "../vendor/lattice-sdk.js";
import { keyFileJSON } from "../client/tx.mjs";
import { reader } from "../client/market.mjs";
import { depositBody, submit, buildTransferBody } from "./devnet-tx.mjs";
import { marketArgs } from "./market-chain.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LATTICE = process.env.LATTICE;
const ports = { listen: 26141, rpc: 26490, publicRead: 26491, faucet: 26500 };
const node = `http://127.0.0.1:${ports.publicRead}`;
const MARKET = "Nexus/testnet/hosts";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = mkdtempSync(`${tmpdir()}/hostmarket-dev-`);
const lattice = (...args) => execFileSync(LATTICE, [...args, "--root", root], { encoding: "utf8" });
const configure = (change) => { const f = `${root}/lattice.json`, t = JSON.parse(readFileSync(f, "utf8")); change(t); writeFileSync(f, JSON.stringify(t, null, 2)); };
const account = () => { const privateKey = sdk.generatePrivateKey(); return { privateKey, address: sdk.accountFromPrivateKey(privateKey).address }; };
const [miner, seller, faucet, host] = [account(), account(), account(), account()];
const r = reader(sdk, node);
const until = async (cond) => { for (;;) { if (await cond().catch(() => false)) return; await sleep(1000); } };
const nonce = async (path, who) => (await r.account(path, who.address)).nonce;

lattice("init");
configure((t) => { Object.assign(t, { listen: ports.listen, rpc: ports.rpc, publicRead: ports.publicRead, webSocket: 0, publicSubmit: true, minRelayFee: 1 });
  t.publicReadExpensiveRate = 1000; t.peers = []; });
lattice("child", "create", "Nexus/testnet");
lattice("child", "create", MARKET, ...marketArgs({ dir: root, premineTo: seller.address }));
// The miner's own settings, not the node's.
writeFileSync(join(root, "miner.json"), JSON.stringify({ worker: "cpu", workers: 1, batchSize: 100000,
  recipients: { Nexus: miner.address, "Nexus/testnet": faucet.address, [MARKET]: host.address } }));
// `lattice up` runs the node in the foreground; it answers once its cookie is there.
const nodeLog = openSync(join(root, "node.log"), "a");
spawn(LATTICE, ["up", "--root", root], { stdio: ["ignore", nodeLog, nodeLog], detached: true }).unref();
await until(async () => existsSync(join(root, "chains/Nexus/.cookie")));
lattice("mine", "start");
console.log("root", root);
await until(async () => (await r.account(MARKET, seller.address)).balance > 0n);

// Sales: different sizes and prices.
let n = 0;
for (const [deposited, demanded] of [[500n, 250n], [2000n, 1000n], [5000n, 3000n], [20000n, 9000n]]) {
  await submit(sdk, node, depositBody({ seller: seller.address, nonce: await nonce(MARKET, seller), chainPath: MARKET.split("/"), depositNonce: BigInt(++n), amountDemanded: demanded, amountDeposited: deposited, fee: 1n }), seller.privateKey);
  await until(async () => (await r.deposits(MARKET)).length >= n);
}
console.log("sales open");

const keyFile = join(root, "host-key.json");
writeFileSync(keyFile, keyFileJSON(sdk, host.privateKey), { mode: 0o600 });
const offerFile = join(root, "offer.json");
writeFileSync(offerFile, JSON.stringify({ id: "small", parent: "Nexus/testnet", price: 100, period: 1800, duration: 1000000, capacity: 20,
  maxBlockSize: 1000000, maxStateGrowth: 1000000, minTargetBlockTime: 1000, maxNumberOfTransactionsPerBlock: 1000, modules: "any" }));
spawn(process.execPath, [join(ROOT, "host/sell-hosting.mjs"), "--root", root, "--market", MARKET, "--key", keyFile, "--offer", offerFile, "--url", node, "--lattice", LATTICE, ...(process.env.SPONSOR ? ["--sponsor-bin", process.env.SPONSOR] : []), "--interval", "5"],
  { stdio: ["ignore", openSync(join(root, "sell-hosting.log"), "a"), openSync(join(root, "sell-hosting.log"), "a")] });

createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const to = new URL(req.url, "http://x").searchParams.get("to");
  try {
    await submit(sdk, node, buildTransferBody({ from: faucet.address, to, amount: 5000n, nonce: await nonce("Nexus/testnet", faucet), chainPath: ["Nexus", "testnet"], fee: 1n }), faucet.privateKey);
    res.end("sent 5000\n");
  } catch (e) { res.statusCode = 500; res.end(e.message); }
}).listen(ports.faucet);
console.log(`ready: http://127.0.0.1:8765/?node=${node}&market=${MARKET}&blockSeconds=2`);
