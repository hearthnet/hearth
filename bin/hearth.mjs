#!/usr/bin/env node
// Hearth's seller in one command:
//
//   npx @hearthnet/hearth sell [--price 1000] [--period 1d] [--throughput 200000] [--storage 1000000] [--under <path>]... [--hashrate <n>]
//
// finds the Lattice node beside it (5.1.0 or newer), makes the seller's key
// if there is none, and runs host/sell-hosting.mjs in the foreground, which
// makes the node host the market, mines every chain it hosts, writes the
// offer from its flags, hosts and launches the chains it owes, and runs the
// host's sponsor. `--install` writes systemd user units (Linux) or launchd agents
// (macOS) for the node and the seller, and prints the command that loads
// them.
//
//   npx @hearthnet/hearth stop [--now]
//
// deletes the seller's offer and leaves the seller serving what is paid: it
// keeps hosting, mining and sponsoring each chain with paid time until that
// ends, then exits. `--now` stops the seller and hosting at once, and says
// what its buyers lose.
//
//   npx @hearthnet/hearth sweep [--float 100] [--chain <path>]
//
// moves what the sponsor's key holds above the float to the seller's address.
//
//   npx @hearthnet/hearth status
//
// prints, once, what the seller prints each pass: both keys' balances, its
// orders, what they paid and what it owes, the storage pinned, its coin on
// sale and the market's cheapest coin on sale.
//
//   npx @hearthnet/hearth sell-coin 300000 --price 3000 [--float 100]
//
// locks the seller key's market coin on Lattice's exchange for a price in
// the parent chain's coin, which a buyer pays straight to the seller's
// address on the parent. Lattice cannot cancel it.
//
//   npx @hearthnet/hearth unpin <cid>
//
// asks the seller's sponsor to unpin a file and serve it no more.
//
//   npx @hearthnet/hearth earn [--until <coins>]
//
// earns market coin for the seller's key with this machine's processor.
//
//   npx @hearthnet/hearth burn 100 --chain Nexus
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
import { marketMismatch, reader } from "../client/market.mjs";
import { OWN_LIMIT, coinLines, exchangeOf, receiptsOf, sellCoin } from "../host/coin.mjs";
import { DEFAULT_MARKET, DEFAULT_TERMS, WHY_SELL, offerTerms, DEFAULT_STORAGE_RATE, authedFetch, burn, burnChain, chainSync, checkRoot, checkSellFlags, ensureKey, findRoot,
  installedSeller, nodeSecret, nodeVersion, markClosing, markReopen, onPath, sponsorBooks, operatorRPC, parseAmount, rpcPort,
  sellerFiles, serviceUnits, sweep, waitSynced } from "../host/hearth.mjs";
import { sponsorAnswers, sponsorBinary, sponsorStorage, unpin } from "../host/sponsor.mjs";
import { initManagedNode, installTools, keepManagedNode, managedRoot, nodeAnswers, runManagedNode, TUNNEL } from "../host/runtime.mjs";
import { openTunnel, PUBLIC_READ_PORT, startProxy } from "../host/public.mjs";
import { REMOTE_STORAGE, judgeOwn, report } from "../host/status.mjs";
import { stop } from "../host/stop.mjs";
import { miner } from "../host/pace.mjs";
import { earn } from "../host/earn.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const { name, version } = JSON.parse(readFileSync(join(HERE, "../package.json"), "utf8"));
const NODE = "[--root <node root> | --node <url> --token-file <file>] [--key <file>] [--lattice <path>]";
const VERBS = {
  sell: `hearth sell [--price ${DEFAULT_TERMS.price}] [--period ${DEFAULT_TERMS.period}] [--throughput ${DEFAULT_TERMS.throughput}] [--storage ${DEFAULT_TERMS.storage}]
                   [--under <path>]... [--hashrate <hashes/s>] [--id 1]
                   [--public | --key-only] [--market ${DEFAULT_MARKET}] ${NODE}
                   [--interval 30] [--fee <n>] [--once]
                   [--sponsor-bin <path>] [--sponsor-port 8650] [--sponsor-url <https url>]
                   [--storage-rate ${DEFAULT_STORAGE_RATE}] [--storage-budget 256M]
                   [--burn <coin> [--burn-chain <path>]] [--install] [--resume]`,
  status: `hearth status [--market ${DEFAULT_MARKET}] ${NODE} [--sponsor-port 8650]`,
  stop: `hearth stop [--now] [--market ${DEFAULT_MARKET}] ${NODE} [--fee <n>]`,
  unpin: "hearth unpin <cid> [--root <node root>] [--sponsor-port 8650]",
  sweep: `hearth sweep [--float 100] [--chain <path>] [--sponsor-port 8650] [--market ${DEFAULT_MARKET}] ${NODE} [--fee <n>]`,
  earn: `hearth earn [--until <coins>] [--workers 1] --sponsor <url>
                   [--market ${DEFAULT_MARKET}] ${NODE}`,
  burn: `hearth burn <coin> --chain <path> [--market ${DEFAULT_MARKET}] ${NODE} [--fee <n>]`,
  "sell-coin": `hearth sell-coin <coin> --price <parent coin> [--float 100] [--again] [--sponsor-port 8650] [--market ${DEFAULT_MARKET}] ${NODE} [--fee <n>]`,
};
const USAGE = `usage: ${Object.values(VERBS).join("\n       ")}`;

const [verb, ...rest] = process.argv.slice(2);
if (!(verb in VERBS)) { console.error(USAGE); process.exit(verb === undefined || verb === "help" || verb === "--help" || verb === "-h" ? 0 : 2); }
if (rest.includes("--help") || rest.includes("-h")) { console.log(`usage: ${VERBS[verb]}\nSee https://hearthnet.io/cli.html`); process.exit(0); }
const fail = (message) => { console.error(`hearth: ${message}`); process.exit(2); };
let parsed;
try { parsed = parseArgs({
  args: rest,
  allowPositionals: verb === "burn" || verb === "unpin" || verb === "sell-coin",
  options: {
    root: { type: "string" }, node: { type: "string" }, "token-file": { type: "string" },
    market: { type: "string", default: DEFAULT_MARKET }, key: { type: "string" },
    id: { type: "string" }, public: { type: "boolean" }, "key-only": { type: "boolean" },
    lattice: { type: "string" }, interval: { type: "string", default: "30" }, "storage-budget": { type: "string" }, once: { type: "boolean", default: false }, fee: { type: "string" },
    throughput: { type: "string" }, storage: { type: "string" }, period: { type: "string" }, hashrate: { type: "string" }, price: { type: "string" },
    under: { type: "string", multiple: true },
    install: { type: "boolean", default: false }, resume: { type: "boolean", default: false }, float: { type: "string", default: "100" },
    burn: { type: "string" }, "burn-chain": { type: "string" }, chain: { type: "string" },
    "sponsor-bin": { type: "string" }, "sponsor-port": { type: "string" }, "sponsor-url": { type: "string" }, "storage-rate": { type: "string" },
    now: { type: "boolean", default: false }, again: { type: "boolean", default: false },
    sponsor: { type: "string" }, workers: { type: "string", default: "1" }, until: { type: "string" },
  },
}); } catch (e) { fail(e.message); }
const { values: a, positionals } = parsed;
if (a.node && !a["token-file"]) fail("--node needs --token-file");

let installed;
/** Hearth's own node and sponsor binaries, downloaded the first time. */
const tools = () => (installed ??= installTools({ home: homedir() }));

/**
 * The node's root: none with --node; else --root (where a node must be);
 * else a running node beside this process (the current directory, or
 * ~/.lattice); else the node Hearth runs in ~/.hearth/node, started for as
 * long as this command runs. Only `hearth sell` makes that node (`create`;
 * `install` only makes it, for the services to start). A node of your own
 * that is not running is said, never replaced.
 */
async function nodeRoot({ create = false, install = false } = {}) {
  if (a.node) { a.lattice ??= "lattice"; return undefined; }
  if (a.root) { a.lattice ??= "lattice"; return checkRoot(resolve(a.root)); }
  const home = homedir();
  try { const root = findRoot({ cwd: process.cwd(), home }); a.lattice ??= "lattice"; return root; } catch {}
  for (const dir of [process.cwd(), join(home, ".lattice")].filter((d) => resolve(d) !== managedRoot(home))) {
    if (existsSync(join(dir, "lattice.json")) || existsSync(join(dir, "chains/Nexus"))) fail(`the node at ${dir} is not running: start it, or give --root`);
  }
  const root = managedRoot(home);
  if (!create && !existsSync(join(root, "hearth/seller.json"))) fail("nothing is sold from this machine yet: run hearth sell (or give --root, or --node with --token-file)");
  a.lattice ??= (await tools()).lattice;
  if (create) {
    // Public (read by anyone through the tunnel, taking their writes) or not, set before the node starts.
    initManagedNode({ home, lattice: a.lattice });
    a.public ??= defaultPublic();
    // The port the tunnel uses is Hearth's to open and close: opened for --public (and a mark left), closed
    // when not public if Hearth opened it (or --key-only says so); one the operator set stays.
    const mark = join(root, "hearth/public-port");
    if (a.public) {
      // Marked as Hearth's only when no port was set before; the mark first, so a crash never leaves an unmarked one.
      let set = false;
      try { set = execFileSync(a.lattice, ["config", "get", "publicRead", "--root", root], { encoding: "utf8" }).trim() !== ""; } catch {}
      if (!set) { mkdirSync(dirname(mark), { recursive: true }); writeFileSync(mark, "opened by hearth sell for its tunnel\n"); }
      execFileSync(a.lattice, ["config", "set", `publicRead=${PUBLIC_READ_PORT}`, "publicSubmit=true", "--root", root], { stdio: "ignore" });
    } else if (a["key-only"] || existsSync(mark)) {
      execFileSync(a.lattice, ["config", "unset", "publicRead", "publicSubmit", "--root", root], { stdio: "ignore" });
      rmSync(mark, { force: true });
    }
  }
  if (install) return initManagedNode({ home, lattice: a.lattice });
  // The seller keeps its node up; another verb runs it for as long as it takes.
  if (create) return (await keepManagedNode({ home, lattice: a.lattice })).root;
  return (await runManagedNode({ home, lattice: a.lattice })).root;
}

/** Hearth's own node is reachable by default: with no sponsor URL of the seller's own (nor --key-only), a tunnel. */
const defaultPublic = () => !a["key-only"] && !a["sponsor-url"];

/** The node's public read port at `root` (`lattice config get publicRead`), or a failure saying how to set it. */
function publicReadPort(root) {
  const get = (key) => { try { return JSON.parse(execFileSync(a.lattice, ["config", "get", key, "--root", root], { encoding: "utf8" })); } catch { return undefined; } };
  const port = get("publicRead");
  if (!Number.isInteger(port) || port <= 0 || get("publicSubmit") !== true) {
    fail(`--public serves the node's public read port, and the node at ${root} has none taking writes: run\n  ${a.lattice} config set publicRead=${PUBLIC_READ_PORT} publicSubmit=true --root ${root}\nthen restart the node (or sell with --key-only)`);
  }
  return port;
}

/** The node (beside it, or remote), its secret, and the seller's key path. */
async function located() {
  const root = await nodeRoot();
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

/**
 * The pid of the node the seller `pid`'s parent (its `hearth sell`) runs on
 * `root`: that parent's other child on the root (`lattice up` may become
 * `lattice-node`), or undefined.
 */
function sellerNode(pid, root) {
  try {
    const rows = execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
    const parent = rows.find(([, p]) => Number(p) === pid)?.[2];
    return Number(rows.find(([, p, pp, cmd]) => pp === parent && Number(p) !== pid && cmd.includes(`--root ${root}`))?.[1]) || undefined;
  } catch { return undefined; }
}

/** The running seller's pid from `pidFile`, or undefined (a pid left by a seller that died may name another process by now). */
function runningSeller(pidFile) {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number(readFileSync(pidFile, "utf8"));
  try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).includes("sell-hosting.mjs") ? pid : undefined; } catch { return undefined; }
}

/** How to pause the seller without closing its offer (`hearth stop` closes it), then run `then`. */
function pauseHow(then) {
  const service = installedSeller({ platform: process.platform, home: homedir() });
  return service ? `stop its service (${process.platform === "darwin" ? `launchctl bootout gui/$(id -u)/net.hearth.seller` : "systemctl --user stop hearth.service"}), `
    + `run ${then}, then start it again (${process.platform === "darwin" ? `launchctl bootstrap gui/$(id -u) ${service.file}` : "systemctl --user start hearth.service"})`
    : `stop it (Ctrl-C, or kill its pid), run ${then}, then start it again with the same hearth sell flags and --resume`;
}

/** `fetchImpl` with a deadline on each read: a report or a one-off write never waits on a stuck node. */
const timed = (authed) => (input, init = {}) => authed(input, { ...init, signal: AbortSignal.timeout(15_000) })
  .catch((e) => { throw e.name === "TimeoutError" ? new Error(`${new URL(input).pathname}: no answer from the node within 15 s`) : e; });

if (verb === "sell-coin") {
  // Every amount checked before the node is asked anything.
  try {
    if (positionals.length !== 1 || !a.price) fail("hearth sell-coin <coin> --price <parent coin>: how much market coin to lock, and what a buyer pays for all of it");
    const amount = parseAmount(positionals[0], "the amount");
    const price = parseAmount(a.price, "--price");
    const float = parseAmount(a.float, "--float");
    if (a.fee !== undefined) parseAmount(a.fee, "--fee");
    const port = a["sponsor-port"] ?? "8650";
    if (!/^[1-9][0-9]*$/.test(port)) fail(`--sponsor-port is a port, not ${port}`);
    const { parent } = exchangeOf(a.market);
    const { root, key, node, fetchImpl: authed } = await located();
    const privateKey = readKey(key);
    // The seller and its lattice-sponsor sign with these keys: two signers would race for the nonce.
    const pid = runningSeller(sellerFiles({ root, key }).pid);
    if (pid) fail(`the seller (pid ${pid}) signs with the seller's key, and two signers would race for its nonces: ${pauseHow("hearth sell-coin")}. Its offer stays on sale meanwhile (hearth stop would close it).`);
    if (await sponsorAnswers(port)) fail(`a sponsor answers on port ${port}: stop it before selling coin (the seller runs it beside its keys), or give --sponsor-port`);
    // Every read has a deadline; once the market is synced, so has the whole.
    const fetchImpl = timed(authed);
    await nodeVersion(node, fetchImpl);
    await waitSynced(node, a.market, { fetchImpl, label: "market" });
    setTimeout(() => fail("no answer from the node within 120 s: is it running, and not overloaded? Run hearth status before trying again: the deposit may have been sent"), 120_000).unref();
    const done = await sellCoin({ sdk, node, fetchImpl, privateKey, market: a.market, amount, price, float, fee: a.fee, again: a.again });
    if (done.existing) {
      const e = done.existing;
      console.log(`already on sale: ${e.amountDeposited} market coin for ${e.amountDemanded} ${parent} coin, deposit ${e.key}. Nothing sent: a deposit can't be cancelled, so a second one is locked only with --again.`);
      process.exit(0);
    }
    const d = done.deposit;
    console.log(`locked ${d.amountDeposited} market coin on ${a.market} for sale at ${d.amountDemanded} ${parent} coin: deposit ${d.demander}/${d.amountDemanded}/${d.nonce}\ntransaction ${done.tx}\n`
      + `A buyer pays ${d.amountDemanded} ${parent} coin (and that chain's fee) on ${parent}; the chain credits it straight to ${d.demander} there, with nothing to claim, and the buyer takes the coin. `
      + "Buyers find it on Hearth's Buy coin page, and hearth status lists it once it is in a block.\n"
      + `A deposit cannot be cancelled: there is no cancel or refund. Until someone buys it, the only way back is to buy it yourself like any buyer, paying its price to your own address on ${parent} (a fee on each chain).`);
  } catch (e) { fail(e.message); }
  process.exit(0);
}

if (verb === "sweep") {
  try {
    const { root, key, node, fetchImpl } = await located();
    const to = sdk.accountFromPrivateKey(readKey(key)).address;
    const sponsorKey = join(dirname(key), "sponsor.json");
    if (!existsSync(sponsorKey)) fail(`no sponsor key at ${sponsorKey}`);
    // lattice-sponsor signs with the same key: two signers would race for its nonces.
    const pid = runningSeller(sellerFiles({ root, key }).pid);
    const pause = pauseHow("hearth sweep");
    if (pid) fail(`the seller (pid ${pid}) runs the sponsor with the sponsor's key, and two signers would race for its nonces: ${pause}. `
      + "Its offer stays on sale meanwhile (hearth stop would close it). The seller funds its first writes from the sponsor's key by itself.");
    const port = a["sponsor-port"] ?? "8650";
    if (await sponsorAnswers(port)) fail(`a sponsor answers on port ${port}: stop it before sweeping its key (it signs with the same key), or give --sponsor-port`);
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

if (verb === "status") {
  // A report, not a wait: every read has a deadline, and so has the whole.
  setTimeout(() => fail("no answer from the node within 120 s: is it running, and not overloaded?"), 120_000).unref();
  try {
    const { root, key, node, fetchImpl: authed } = await located();
    const fetchImpl = timed(authed);
    const self = sdk.accountFromPrivateKey(readKey(key)).address;
    const sponsorKey = join(dirname(key), "sponsor.json");
    if (!existsSync(sponsorKey)) fail(`no sponsor key at ${sponsorKey}: hearth sell makes it`);
    const sponsorAddress = JSON.parse(readFileSync(sponsorKey, "utf8")).address;
    await nodeVersion(node, fetchImpl);
    const sync = await chainSync(node, a.market, fetchImpl, "market");
    if (!sync.synced) {
      console.log(sync.height === undefined && sync.best === undefined ? `market not synced: ${sync.line}` : `market not synced (height ${sync.height ?? 0} of ${sync.best ?? "?"}): run hearth status again once it is`);
      process.exit(0);
    }
    const n = reader(sdk, node, { fetchImpl });
    const m = await n.market(a.market);
    const wrong = marketMismatch(await n.spec(a.market), a.market);
    if (wrong) fail(wrong);
    const own = await judgeOwn({ sdk, m, self, market: a.market });
    const [seller, sponsor] = await Promise.all([n.account(a.market, self), n.account(a.market, sponsorAddress)]);
    console.log(report({ market: a.market, height: m.height, seller: { address: self, balance: seller.balance }, sponsor: { address: sponsorAddress, balance: sponsor.balance },
      ...own, storage: root ? await sponsorStorage(a["sponsor-port"] ?? "8650") : REMOTE_STORAGE }).join("\n"));
    // The exchange: the seller's coin on sale, and the price it competes with.
    const { parent, directory } = exchangeOf(a.market);
    // Bounded reads: a page of the market's deposits for the cheapest, the seller's own by its key prefix.
    const [deposits, mine] = await Promise.all([n.deposits(a.market), n.deposits(a.market, { prefix: `${self}/`, limit: OWN_LIMIT })]);
    const paidBy = await receiptsOf({ n, parent, directory, deposits: mine });
    console.log(coinLines({ market: a.market, deposits, mine, paidBy }).join("\n"));
    const paid = await n.account(parent, self).catch(() => undefined);
    if (paid) console.log(`the seller's key holds ${paid.balance} on ${parent}, where buyers of its coin pay it`);
    const pid = root && runningSeller(sellerFiles({ root, key }).pid);
    if (root) console.log(pid ? `the seller runs (pid ${pid})${existsSync(sellerFiles({ root, key }).closing) ? ", closing" : ""}` : "no seller runs beside this node");
  } catch (e) { fail(e.message); }
  process.exit(0);
}

if (verb === "unpin") {
  try {
    if (positionals.length !== 1) fail("hearth unpin <cid>: the root CID of the file to unpin");
    const [cid] = positionals;
    if (!/^bafy[a-z2-7]{50,}$/.test(cid)) fail(`${cid} is not a CID (bafy...): give the root CID of the file to unpin`);
    const port = a["sponsor-port"] ?? "8650";
    if (!/^[1-9][0-9]*$/.test(port)) fail(`--sponsor-port is a port, not ${port}`);
    // The sponsor takes the node's cookie as the operator's credential.
    const root = await nodeRoot();
    if (!root) fail("hearth unpin runs beside the node (--root): its sponsor takes the node's cookie");
    const cookieFile = join(root, "chains/Nexus/.cookie");
    if (!existsSync(cookieFile)) fail(`the node at ${root} is not running (no chains/Nexus/.cookie): start the seller (hearth sell), then unpin`);
    const done = await unpin({ port, cid, cookie: readFileSync(cookieFile, "utf8").trim() });
    console.log(`took ${done.cid} down: the sponsor refuses it from now on, and unpinned ${done.unpinned.length} Volumes (${done.unpinned.join(" ") || "none were pinned"}). `
      + "Whoever paid for it loses the rest of its time, with no refund.");
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
      // The seller first, so nothing mines or sponsors any more.
      const service = installedSeller({ platform: process.platform, home: homedir() });
      if (service) {
        console.log(`stopping the seller's service: ${service.stop.join(" ")}`);
        try { execFileSync(service.stop[0], service.stop.slice(1), { stdio: "inherit" }); } catch (e) { console.log(`(${e.message.split("\n")[0]}: it may not have been loaded)`); }
      }
      if (pid) {
        // The node the seller's `hearth sell` runs (none when a service or the user runs it).
        const node = sellerNode(pid, root);
        try { process.kill(pid, "SIGTERM"); for (let i = 0; i < 100; i++) { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 100)); } } catch {}
        console.log(`stopped the seller (pid ${pid}), its miner and its sponsor`);
        // Hearth's node stops with the seller that ran it: this verb runs it now.
        if (node) {
          // Gone, or a zombie (an init that reaps no orphans leaves one).
          const alive = () => {
            try { process.kill(node, 0); } catch { return false; }
            try { return !execFileSync("ps", ["-o", "stat=", "-p", String(node)], { encoding: "utf8" }).trim().startsWith("Z"); } catch {}
            try { return readFileSync(`/proc/${node}/stat`, "utf8").split(") ").pop()[0] !== "Z"; } catch { return true; }
          };
          for (let i = 0; i < 1200 && alive(); i++) await new Promise((r) => setTimeout(r, 250));
          await runManagedNode({ home: homedir(), lattice: a.lattice });
        }
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
    // close lands, this one mines what the node hosts too, paying its sponsor.
    const sponsorKey = join(dirname(key), "sponsor.json");
    const mining = !pid && existsSync(sponsorKey) && miner({ rpc: node, fetchImpl, to: JSON.parse(readFileSync(sponsorKey, "utf8")).address, log: () => {} });
    const done = await stop({ sdk, node, fetchImpl, rpc: operatorRPC(node, fetchImpl), privateKey, market: a.market, fee: a.fee, now: a.now, sellerRuns: !!pid })
      .finally(() => mining && mining.stop());
    const when = (h) => new Date(Date.now() + Number(h - done.height) * done.blockTime).toISOString().slice(0, 16).replace("T", " ");
    if (done.closed.length) {
      console.log(`closed ${done.closed.join(", ")} at market block ${done.height}: no order lands on it from then on; orders already in a block are owed`
        + (done.landed ? "" : " (not in a block yet: run hearth stop again to check)"));
    } else console.log("no offer of this key is on sale");
    const last = [...done.paid.values()].reduce((x, y) => (y > x ? y : x), 0n);
    const paidLine = `${done.paid.size} chains have paid time left, the last to market block ${last} (about ${when(last)} UTC)`;
    if (a.now) {
      console.log(done.paid.size
        ? `stopped hosting them at once: ${paidLine}, and their buyers lose the rest of it, with no refund; their chains get no more blocks or sponsored writes from this host`
        : "nobody had paid time left");
    } else if (pid) {
      console.log(done.paid.size
        ? `${paidLine}: the seller (pid ${pid}) keeps hosting them, making their blocks and sponsoring them until then, and then exits. Keep the node running.`
        : "nobody has paid time left: the seller exits once the close has landed");
    } else {
      console.log(done.paid.size
        ? `${paidLine}: this node keeps hosting them (${done.kept.join(" ")}), but no seller is running to make their blocks. Start it as before with --resume added (or its service): it serves them until then, writes no offer, and exits.`
        : "nobody has paid time left");
    }
    if (done.dropped.length) console.log(`no longer hosts: ${done.dropped.join(" ")} (what it stored stays)`);
  } catch (e) { fail(e.message); }
  process.exit(0);
}

if (verb === "earn") {
  try {
    if (!a.sponsor) fail("--sponsor is a sponsor that pays market coin for work (its --payout-at), e.g. https://host.example:8650/sponsor");
    const { key, node, fetchImpl } = await located();
    const { address } = ensureKey(sdk, key, keyFileJSON);
    const workers = Number(a.workers);
    if (!Number.isInteger(workers) || workers < 1) fail("--workers is a whole number of threads, at least 1");
    const r = reader(sdk, node, { fetchImpl });
    // Enough for what `hearth sell` writes (its offer) and its close: two fees.
    const until = a.until !== undefined ? parseAmount(a.until, "--until")
      : 2n * BigInt((await r.api("/api/chain/info", a.market).catch(() => ({}))).minRelayFee ?? 1);
    console.log(`earning ${until} coin on ${a.market} for ${address} with ${workers} thread${workers > 1 ? "s" : ""}, working for ${a.sponsor}`);
    // The balance counts only once the node has synced the market.
    const balance = async () => ((await chainSync(node, a.market, fetchImpl)).synced ? (await r.account(a.market, address)).balance : undefined);
    const have = await earn({ sponsor: a.sponsor, chain: a.market, payTo: address, workers, until, balance });
    console.log(`${address} holds ${have} on ${a.market}: done`);
  } catch (e) { fail(e.message); }
  process.exit(0);
}

try {
  // Every flag checked, and the node found, before anything is written.
  checkSellFlags(a);
  // The node: remote with --node, else its root.
  const root = await nodeRoot({ create: true, install: a.install });
  // Beside the node, a sponsor: --sponsor-bin, else one on PATH, else Hearth's own.
  if (root && !a["sponsor-bin"] && !onPath("lattice-sponsor")) a["sponsor-bin"] = (await tools())["lattice-sponsor"];
  if (root) sponsorBinary(a["sponsor-bin"]);
  // A remote node: reachable, with the token, and new enough.
  if (a.node) {
    if (!existsSync(resolve(a["token-file"]))) fail(`no token file at ${resolve(a["token-file"])}`);
    const token = readFileSync(resolve(a["token-file"]), "utf8").trim();
    await nodeVersion(a.node, (input, init = {}) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000), headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } }))
      .catch((e) => { throw e.tooOld ? e : new Error(`cannot reach the node at ${a.node}: ${e.cause?.code ?? e.message}`); });
  }
  const key = resolve(a.key ?? join(root ?? process.cwd(), "hearth/seller.json"));
  const { address, created } = ensureKey(sdk, key, keyFileJSON);
  console.log(`${created ? "made the seller's key" : "seller key"} ${key}\naddress ${address}`);
  if (created) console.log(WHY_SELL);

  if (root === managedRoot(homedir())) a.public ??= defaultPublic();
  let tunnel;
  if (a.public && !a.install) {
    const readPort = publicReadPort(root);
    try { await fetch(`http://127.0.0.1:${readPort}/api/chain/info?chainPath=Nexus`, { signal: AbortSignal.timeout(5_000) }); }
    catch { fail(`the node at ${root} does not answer on its public read port ${readPort}: restart it (it takes publicRead when it starts), then run hearth sell --public again`); }
    const proxy = await startProxy({ nodePort: readPort, sponsorPort: Number(a["sponsor-port"] ?? 8650) });
    const { cloudflared } = await installTools({ home: homedir(), pinned: TUNNEL });
    tunnel = await openTunnel({ bin: cloudflared, port: proxy.port, log: (line) => console.log(line) });
    a["sponsor-url"] = `${tunnel.url}/sponsor`;
    console.log(`public at ${tunnel.url}: the node's public read port, and its sponsor at /sponsor (a Cloudflare quick tunnel to this machine: a new URL each start)`);
  }

  const t = { ...DEFAULT_TERMS, ...Object.fromEntries(["price", "period", "throughput", "storage", "hashrate"].filter((k) => a[k] !== undefined).map((k) => [k, a[k]])) };
  console.log(`offer ${a.id ?? "1"}: ${t.price} market coin per ${t.period} for one chain under ${offerTerms(a).under.join(", ")}, `
    + `of up to ${t.throughput} bytes a second of blocks and ${t.storage} bytes of state growth a block; ` + (t.hashrate ? `${t.hashrate} hashes per second` : "the hash rate its miner measures"));
  if (a.burn) {
    console.log(`burns until ${a.burn} is burned for ${address} on ${burnChain(a["burn-chain"] ?? a.market, a.market)}, once`);
  }

  const where = root ? ["--root", root] : ["--node", a.node, "--token-file", resolve(a["token-file"])];
  const pass = (flag) => (a[flag] === undefined ? [] : [`--${flag}`, a[flag]]);
  const sponsorBin = a["sponsor-bin"]?.includes("/") ? ["--sponsor-bin", resolve(a["sponsor-bin"])] : pass("sponsor-bin");
  const sellArgs = [...where, "--market", a.market, "--key", key,
    ...pass("id"), ...pass("price"), ...pass("period"), ...pass("throughput"), ...pass("storage"), ...(a.under ?? []).flatMap((p) => ["--under", p]),
    ...pass("hashrate"), ...pass("fee"), ...pass("burn"), ...pass("burn-chain"),
    ...sponsorBin, ...pass("sponsor-port"), ...pass("sponsor-url"), ...pass("storage-rate"), ...pass("storage-budget"),
    "--interval", a.interval, ...(a.once ? ["--once"] : []), ...(a.resume ? ["--resume"] : [])];

  if (a.install) {
    // The services run the seller with these flags and every path absolute; from an npx cache, through npx at this version, which a cache
    // clean cannot strand.
    // Node as the shell finds it (e.g. /opt/homebrew/bin/node), not this
    // process's resolved path, which an upgrade of node deletes.
    const self = realpathSync(process.argv[1]);
    const nodePath = onPath("node") ?? process.execPath;
    const bin = dirname(nodePath);
    const program = self.includes("/_npx/") ? [join(bin, "npx"), "--yes", `${name}@${version}`] : [nodePath, self];
    const lattice = a.lattice.includes("/") ? resolve(a.lattice) : onPath(a.lattice) ?? a.lattice;
    // A service restart is not the operator: it never reopens a closed offer.
    const command = [...program, "sell", ...sellArgs, ...(a.resume ? [] : ["--resume"]), ...(a.public ? ["--public"] : a["key-only"] ? ["--key-only"] : []), "--lattice", lattice];
    const sponsorDir = a["sponsor-bin"]?.includes("/") ? [dirname(resolve(a["sponsor-bin"]))] : [];
    const path = [...new Set([bin, ...(lattice.startsWith("/") ? [dirname(lattice)] : []), ...sponsorDir, "/usr/local/bin", "/usr/bin", "/bin"])].join(delimiter);
    const { units, load, note } = serviceUnits({ platform: process.platform, home: homedir(), command, nodeCommand: root && [lattice, "up", "--root", root], path });
    for (const unit of units) {
      mkdirSync(dirname(unit.file), { recursive: true });
      writeFileSync(unit.file, unit.content);
      console.log(`wrote ${unit.file}`);
    }
    // Installing puts the offer on sale: the service's next start sells,
    // though it runs with --resume.
    markReopen(sellerFiles({ root, key }));
    console.log(`load them with:\n  ${load}\n${note}`);
    // Hearth's own node, run by a hearth sell still running: the node service
    // would find its port taken.
    if (root === managedRoot(homedir()) && await nodeAnswers(root)) console.log("first stop the hearth sell running now (its node stops with it)");
    process.exit(0);
  }

  const child = spawn(process.execPath, [join(HERE, "../host/sell-hosting.mjs"), ...sellArgs, ...(a.public ? ["--sponsor-loopback"] : []), "--lattice", a.lattice], { stdio: "inherit" });
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { stopping = true; child.kill(signal); });
  // Buyers reach the chains only through the tunnel: without it, stop, failed (a service starts it all again).
  let tunnelGone = false;
  child.on("exit", (code, signal) => process.exit(tunnelGone ? 1 : code ?? (signal ? 1 : 0)));
  tunnel?.child.on("exit", (code) => { if (stopping) return; tunnelGone = true; console.error(`hearth: the tunnel stopped (cloudflared exited ${code}): stopping the seller`); child.kill("SIGTERM"); });
} catch (e) {
  fail(e.message);
}
