#!/usr/bin/env node
// Hearth's seller in one command:
//
//   npx @hearthnet/hearth sell --price 100/day
//
// finds the Lattice node beside it (4.0.1 or newer), makes the seller's key
// if there is none, writes the offer from its flags, and runs
// host/sell-hosting.mjs in the foreground, which makes the node host the
// market and the offer's parent, makes their blocks, and runs the host's
// sponsor. `--install` writes systemd user units (Linux) or launchd agents
// (macOS) for the node and the seller, and prints the command that loads
// them.
//
//   npx @hearthnet/hearth stop [--now]
//
// closes the seller's offers and leaves the seller serving what is paid: it
// keeps hosting, pacing and sponsoring each chain with paid time until that
// ends, then exits. `--now` stops the seller and hosting at once, and says
// what its buyers lose.
//
//   npx @hearthnet/hearth sweep [--float 100] [--chain <path>]
//
// moves what the sponsor's key holds above the float to the seller's address.
//
//   npx @hearthnet/hearth earn [--until <coins>]
//
// earns market coin for the seller's key with this machine's processor.
//
//   npx @hearthnet/hearth burn 100 --chain Nexus/testnet
//
// burns coin for the seller's key on a chain from Nexus down to the market.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as sdk from "../vendor/lattice-sdk.js";
import { keyFileJSON } from "../client/tx.mjs";
import { reader } from "../client/market.mjs";
import { CREATED_WINDOW } from "../client/records.mjs";
import { DEFAULT_MARKET, DEFAULT_STORAGE_RATE, authedFetch, burn, burnChain, chainSync, ensureKey, findRoot, installedSeller, nodeSecret, nodeVersion, offerFromFlags,
  markClosing, markReopen, onPath, sponsorBooks, operatorRPC, parseAmount, rpcPort, sellerFiles, serviceUnits, sweep, waitSynced } from "../host/hearth.mjs";
import { sponsorBinary } from "../host/sponsor.mjs";
import { stop } from "../host/stop.mjs";
import { pacer } from "../host/pace.mjs";
import { DEFAULT_SPONSOR, earn } from "../host/earn.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const { name, version } = JSON.parse(readFileSync(join(HERE, "../package.json"), "utf8"));
const NODE = "[--root <node root> | --node <url> --token-file <file>] [--key <file>] [--lattice lattice]";
const USAGE = `usage: hearth sell --price <coin>/<period> [--parent Nexus/testnet] [--chains 50]
                   [--url https://host.example [--proof <url>]] [--market ${DEFAULT_MARKET}]
                   ${NODE} [--offer offer.json]
                   [--id <offer id>] [--storage-offer storage.json] [--interval 30] [--fee <n>] [--once]
                   [--sponsor-bin lattice-sponsor] [--sponsor-port 8650] [--sponsor-url <https url>]
                   [--storage-rate ${DEFAULT_STORAGE_RATE}] [--burn <coin> [--burn-chain <path>]] [--install] [--resume]
       hearth stop [--now] [--market ${DEFAULT_MARKET}] ${NODE} [--fee <n>]
       hearth sweep [--float 100] [--chain <path>] [--sponsor-port 8650] [--market ${DEFAULT_MARKET}] ${NODE} [--fee <n>]
       hearth earn [--until <coins>] [--workers 1] [--sponsor ${DEFAULT_SPONSOR}]
                   [--market ${DEFAULT_MARKET}] ${NODE}
       hearth burn <coin> --chain <path> [--market ${DEFAULT_MARKET}] ${NODE} [--fee <n>]`;

const [verb, ...rest] = process.argv.slice(2);
if (!["sell", "stop", "earn", "burn", "sweep"].includes(verb)) { console.error(USAGE); process.exit(verb === undefined || verb === "help" || verb === "--help" ? 0 : 2); }
const fail = (message) => { console.error(`hearth: ${message}`); process.exit(2); };
let parsed;
try { parsed = parseArgs({
  args: rest,
  allowPositionals: verb === "burn",
  options: {
    root: { type: "string" }, node: { type: "string" }, "token-file": { type: "string" },
    market: { type: "string", default: DEFAULT_MARKET }, key: { type: "string" }, offer: { type: "string" },
    id: { type: "string" }, url: { type: "string" }, proof: { type: "string" }, "storage-offer": { type: "string" },
    lattice: { type: "string", default: "lattice" }, interval: { type: "string", default: "30" }, once: { type: "boolean", default: false }, fee: { type: "string" },
    price: { type: "string" }, parent: { type: "string" }, chains: { type: "string" },
    install: { type: "boolean", default: false }, resume: { type: "boolean", default: false }, float: { type: "string", default: "100" },
    burn: { type: "string" }, "burn-chain": { type: "string" }, chain: { type: "string" },
    "sponsor-bin": { type: "string" }, "sponsor-port": { type: "string" }, "sponsor-url": { type: "string" }, "storage-rate": { type: "string" },
    now: { type: "boolean", default: false },
    sponsor: { type: "string", default: DEFAULT_SPONSOR }, workers: { type: "string", default: "1" }, until: { type: "string" },
  },
}); } catch (e) { fail(e.message); }
const { values: a, positionals } = parsed;
if (a.node && !a["token-file"]) fail("--node needs --token-file");

/** The node (beside it, or remote), its secret, and the seller's key path. */
async function located() {
  const root = a.node ? undefined : a.root ? resolve(a.root) : findRoot({ cwd: process.cwd(), home: homedir() });
  const key = resolve(a.key ?? join(root ?? process.cwd(), "hearth/seller.json"));
  const fetchImpl = authedFetch(() => nodeSecret({ root, tokenFile: a.node && a["token-file"] }));
  const node = a.node ?? `http://127.0.0.1:${await rpcPort(root, a.lattice, fetchImpl)}`;
  return { root, key, node, fetchImpl };
}
const readKey = (key) => {
  if (!existsSync(key)) fail(`no seller key at ${key}: give --key`);
  return sdk.hexToBytes(JSON.parse(readFileSync(key, "utf8")).privateKey);
};

if (verb === "burn") {
  // A plain transfer from the seller's key to its burn address on one chain.
  try {
    if (positionals.length !== 1 || !a.chain) fail("hearth burn <coin> --chain <path>");
    const amount = parseAmount(positionals[0], "the amount");
    const chain = burnChain(a.chain, a.market);
    const { key, node, fetchImpl } = await located();
    const privateKey = readKey(key);
    await nodeVersion(node, fetchImpl);
    await waitSynced(node, chain, { fetchImpl, label: chain === a.market ? "market" : chain });
    const done = await burn({ sdk, node, fetchImpl, privateKey, chain, amount, fee: a.fee });
    console.log(`burned ${done.amount} on ${chain} for ${sdk.accountFromPrivateKey(privateKey).address}\nto ${done.to}\ntransaction ${done.tx}\n`
      + `burned total on ${chain}: ${done.burned + done.amount} once it is in a block (was ${done.burned})`);
  } catch (e) { fail(e.message); }
  process.exit(0);
}

/** The running seller's pid from `pidFile`, or undefined (a pid left by a seller that died may name another process by now). */
function runningSeller(pidFile) {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number(readFileSync(pidFile, "utf8"));
  try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).includes("sell-hosting.mjs") ? pid : undefined; } catch { return undefined; }
}

if (verb === "sweep") {
  try {
    const { root, key, node, fetchImpl } = await located();
    const to = sdk.accountFromPrivateKey(readKey(key)).address;
    const sponsorKey = join(dirname(key), "sponsor.json");
    if (!existsSync(sponsorKey)) fail(`no sponsor key at ${sponsorKey}`);
    // lattice-sponsor signs with the same key: two signers would race for its nonces.
    const pid = runningSeller(sellerFiles({ root, key }).pid);
    if (pid) fail(`the seller (pid ${pid}) runs lattice-sponsor with this key: sweep once it has stopped (hearth stop --now, or stop its service)`);
    const port = a["sponsor-port"] ?? "8650";
    const answered = await fetch(`http://127.0.0.1:${port}/terms`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    if (answered) fail(`a lattice-sponsor answers on port ${port}: stop it before sweeping its key (it signs with the same key), or give --sponsor-port`);
    const chain = burnChain(a.chain ?? a.market, a.market);
    await nodeVersion(node, fetchImpl);
    await waitSynced(node, chain, { fetchImpl, label: chain === a.market ? "market" : chain });
    const float = BigInt(parseAmount(a.float, "--float"));
    const { holds, funds } = sponsorBooks(join(dirname(key), "sponsor"));
    const done = await sweep({ sdk, node, fetchImpl, privateKey: readKey(sponsorKey), to, chain, float, fee: a.fee, holds, funds });
    console.log(done ? `moved ${done.amount} of the sponsor's ${done.balance} on ${chain} to ${to}, keeping ${done.reserve} (the float ${float}, its holds and fund deposits): ${done.tx}`
      : `the sponsor's key holds no more than the float ${float}, its holds and fund deposits on ${chain} (with the fee): nothing to move`);
  } catch (e) { fail(e.message); }
  process.exit(0);
}

if (verb === "stop") {
  try {
    const { root, key, node, fetchImpl } = await located();
    const privateKey = readKey(key);
    await nodeVersion(node, fetchImpl);
    const files = sellerFiles({ root, key });
    let pid = runningSeller(files.pid);
    if (a.now) {
      // The seller first, so nothing paces or sponsors any more.
      const service = installedSeller({ platform: process.platform, home: homedir() });
      if (service) {
        console.log(`stopping the seller's service: ${service.stop.join(" ")}`);
        try { execFileSync(service.stop[0], service.stop.slice(1), { stdio: "inherit" }); } catch (e) { console.log(`(${e.message.split("\n")[0]}: it may not have been loaded)`); }
      }
      if (pid) {
        try { process.kill(pid, "SIGTERM"); for (let i = 0; i < 100; i++) { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 100)); } } catch {}
        console.log(`stopped the seller (pid ${pid}), its pacer and its sponsor`);
      }
      pid = undefined;
      rmSync(files.reopen, { force: true });
    } else {
      // The seller keeps serving what is paid, and writes no offer again.
      markClosing(files);
    }
    if (root === undefined) console.log("with --node, stop the seller wherever it runs");
    await waitSynced(node, a.market, { fetchImpl, label: "market" });
    // With no seller, the market's blocks come from other hosts; until the
    // close settles, this one paces the market too, paying its sponsor.
    const sponsorKey = join(dirname(key), "sponsor.json");
    const pace = !pid && existsSync(sponsorKey) && pacer({ rpc: node, fetchImpl, to: JSON.parse(readFileSync(sponsorKey, "utf8")).address, chains: () => [a.market], log: () => {} });
    const done = await stop({ sdk, node, fetchImpl, rpc: operatorRPC(node, fetchImpl), privateKey, market: a.market, fee: a.fee, now: a.now, sellerRuns: !!pid })
      .finally(() => pace && pace.stop());
    const when = (h) => new Date(Date.now() + Number(h - done.height) * done.blockTime).toISOString().slice(0, 16).replace("T", " ");
    if (done.closed.length) {
      console.log(`closed ${done.closed.map((c) => c.id).join(", ")} at market block ${done.closedAt ?? done.height}: no new orders once it takes effect at block ${(done.closedAt ?? done.height) + CREATED_WINDOW}; orders placed before then are owed`
        + (done.landed ? "" : " (not in a block yet: run hearth stop again to check)"));
    } else console.log(done.closedAt === undefined ? "no offer of this key is on sale" : `the offers were closed at market block ${done.closedAt}`);
    if (done.landed && !a.now && done.height < done.settledAt) console.log(`orders still settle until market block ${done.settledAt} (about ${when(done.settledAt)} UTC): what is paid below may grow; run hearth stop again then`);
    const last = [...done.paid.values()].reduce((x, y) => (y > x ? y : x), 0n);
    const paidLine = `${done.paid.size} chains have paid time left, the last to market block ${last} (about ${when(last)} UTC)`;
    if (a.now) {
      console.log(done.paid.size
        ? `stopped hosting them at once: ${paidLine}, and their buyers lose the rest of it, with no refund; their chains get no more blocks or sponsored writes from this host`
        : "nobody had paid time left");
    } else if (pid) {
      console.log(done.paid.size
        ? `${paidLine}: the seller (pid ${pid}) keeps hosting them, making their blocks and sponsoring them until then, and then exits. Keep the node running.`
        : "nobody has paid time left: the seller exits once the orders have settled");
    } else {
      console.log(done.paid.size
        ? `${paidLine}: this node keeps hosting them (${done.kept.join(" ")}), but no seller is running to make their blocks. Start it as before with --resume added (or its service): it serves them until then, writes no offer, and exits.`
        : "nobody has paid time left");
    }
    if (done.settling) console.log(`${done.settling} orders were still settling`);
    if (done.dropped.length) console.log(`no longer hosts: ${done.dropped.join(" ")} (what it stored stays)`);
  } catch (e) { fail(e.message); }
  process.exit(0);
}

if (verb === "earn") {
  try {
    const { key, node, fetchImpl } = await located();
    const { address } = ensureKey(sdk, key, keyFileJSON);
    const workers = Number(a.workers);
    if (!Number.isInteger(workers) || workers < 1) fail("--workers is a whole number of threads, at least 1");
    const r = reader(sdk, node, { fetchImpl });
    // Enough for what `hearth sell` writes (offer, url, storage offer) and a close: four fees.
    const until = a.until !== undefined ? parseAmount(a.until, "--until")
      : 4n * BigInt((await r.api("/api/chain/info", a.market).catch(() => ({}))).minRelayFee ?? 1);
    console.log(`earning ${until} coin on ${a.market} for ${address} with ${workers} thread${workers > 1 ? "s" : ""}, working for ${a.sponsor}`);
    // The balance counts only once the node has synced the market.
    const balance = async () => ((await chainSync(node, a.market, fetchImpl)).synced ? (await r.account(a.market, address)).balance : undefined);
    const have = await earn({ sponsor: a.sponsor, chain: a.market, payTo: address, workers, until, balance });
    console.log(`${address} holds ${have} on ${a.market}: done`);
  } catch (e) { fail(e.message); }
  process.exit(0);
}

if (!a.price === !a.offer) fail("give --price (the offer from flags) or --offer offer.json");
if (a["burn-chain"] && !a.burn) fail("--burn-chain goes with --burn");

try {
  // The node: remote with --node, else its root.
  const root = a.node ? undefined : a.root ? resolve(a.root) : findRoot({ cwd: process.cwd(), home: homedir() });
  const key = resolve(a.key ?? join(root ?? process.cwd(), "hearth/seller.json"));
  const { address, created } = ensureKey(sdk, key, keyFileJSON);
  console.log(`${created ? "made the seller's key" : "seller key"} ${key}\naddress ${address}`);
  if (root) sponsorBinary(a["sponsor-bin"]);

  // The offer: its file, or one written beside the key from the flags.
  let offerPath = a.offer && resolve(a.offer);
  if (a.price) {
    const offer = offerFromFlags({ price: a.price, parent: a.parent, chains: a.chains, id: a.id });
    // One file per offer id: the same flags find their file, new flags write
    // a new one (and the seller says the old offer stays on sale).
    offerPath = join(dirname(key), `${offer.id}.json`);
    if (!existsSync(offerPath)) writeFileSync(offerPath, `${JSON.stringify(offer, null, 2)}\n`);
    console.log(`offer ${offer.id}: ${offer.price} coin per ${offer.period}, ${offer.capacity} chains under ${offer.parent}${a.url ? `, at ${a.url}` : ", key only (no --url)"}`);
  }
  if (a.burn) {
    parseAmount(a.burn, "--burn");
    console.log(`burns until ${a.burn} is burned for ${address} on ${burnChain(a["burn-chain"] ?? a.market, a.market)}, once`);
  }

  const where = root ? ["--root", root] : ["--node", a.node, "--token-file", resolve(a["token-file"])];
  const pass = (flag) => (a[flag] === undefined ? [] : [`--${flag}`, a[flag]]);
  const sponsorBin = a["sponsor-bin"]?.includes("/") ? ["--sponsor-bin", resolve(a["sponsor-bin"])] : pass("sponsor-bin");
  const sellArgs = [...where, "--market", a.market, "--key", key, "--offer", offerPath,
    ...pass("url"), ...pass("proof"), ...pass("fee"), ...pass("burn"), ...pass("burn-chain"), ...(a["storage-offer"] ? ["--storage-offer", resolve(a["storage-offer"])] : []),
    ...sponsorBin, ...pass("sponsor-port"), ...pass("sponsor-url"), ...pass("storage-rate"),
    "--interval", a.interval, ...(a.once ? ["--once"] : []), ...(a.resume ? ["--resume"] : [])];

  if (a.install) {
    // The services run the seller with the offer just written and every path
    // absolute; from an npx cache, through npx at this version, which a cache
    // clean cannot strand.
    // Node as the shell finds it (e.g. /opt/homebrew/bin/node), not this
    // process's resolved path, which an upgrade of node deletes.
    const self = realpathSync(process.argv[1]);
    const nodePath = onPath("node") ?? process.execPath;
    const bin = dirname(nodePath);
    const program = self.includes("/_npx/") ? [join(bin, "npx"), "--yes", `${name}@${version}`] : [nodePath, self];
    const lattice = a.lattice.includes("/") ? resolve(a.lattice) : onPath(a.lattice) ?? a.lattice;
    // A service restart is not the operator: it never reopens a closed offer.
    const command = [...program, "sell", ...sellArgs, ...(a.resume ? [] : ["--resume"]), "--lattice", lattice];
    const sponsorDir = a["sponsor-bin"]?.includes("/") ? [dirname(resolve(a["sponsor-bin"]))] : [];
    const path = [...new Set([bin, ...(lattice.startsWith("/") ? [dirname(lattice)] : []), ...sponsorDir, "/usr/local/bin", "/usr/bin", "/bin"])].join(delimiter);
    const { units, load, note } = serviceUnits({ platform: process.platform, home: homedir(), command, nodeCommand: root && [lattice, "up", "--root", root], path });
    for (const unit of units) {
      mkdirSync(dirname(unit.file), { recursive: true });
      writeFileSync(unit.file, unit.content);
      console.log(`wrote ${unit.file}`);
    }
    // Installing puts the offer on sale: the service's next start writes a
    // version from the file once, though it runs with --resume.
    markReopen(sellerFiles({ root, key }));
    console.log(`load them with:\n  ${load}\n${note}`);
    process.exit(0);
  }

  const child = spawn(process.execPath, [join(HERE, "../host/sell-hosting.mjs"), ...sellArgs, "--lattice", a.lattice], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} catch (e) {
  fail(e.message);
}
