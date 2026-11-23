#!/usr/bin/env node
// Hearth's seller in one command:
//
//   npx @hearthnet/hearth sell [--price 10000/day]
//
// finds the Lattice node beside it (5.0.0 or newer), makes the seller's key
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
import { reader } from "../client/market.mjs";
import { OWN_LIMIT, coinLines, exchangeOf, receiptsOf, sellCoin } from "../host/coin.mjs";
import { CREATED_WINDOW } from "../client/records.mjs";
import { DEFAULT_MARKET, DEFAULT_PRICE, WHY_SELL, DEFAULT_STORAGE_RATE, authedFetch, burn, burnChain, chainSync, checkRoot, checkSellFlags, ensureKey, findRoot,
  installedSeller, nodeSecret, nodeVersion, offerFromFlags, markClosing, markReopen, onPath, sponsorBooks, operatorRPC, parseAmount, rpcPort,
  sellerFiles, serviceUnits, sweep, waitSynced } from "../host/hearth.mjs";
import { sponsorAnswers, sponsorBinary, sponsorStorage, unpin } from "../host/sponsor.mjs";
import { initManagedNode, installTools, keepManagedNode, managedRoot, nodeAnswers, runManagedNode } from "../host/runtime.mjs";
import { REMOTE_STORAGE, judgeOwn, report } from "../host/status.mjs";
import { isRootCID } from "../client/records.mjs";
import { stop } from "../host/stop.mjs";
import { pacer } from "../host/pace.mjs";
import { earn } from "../host/earn.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const { name, version } = JSON.parse(readFileSync(join(HERE, "../package.json"), "utf8"));
const NODE = "[--root <node root> | --node <url> --token-file <file>] [--key <file>] [--lattice <path>]";
const VERBS = {
  sell: `hearth sell [--price ${DEFAULT_PRICE}] [--parent Nexus] [--chains 10]
                   [--url https://host.example [--proof <url>]] [--market ${DEFAULT_MARKET}]
                   ${NODE} [--offer offer.json]
                   [--id <offer id>] [--storage-offer storage.json] [--interval 30] [--fee <n>] [--once]
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
    market: { type: "string", default: DEFAULT_MARKET }, key: { type: "string" }, offer: { type: "string" },
    id: { type: "string" }, url: { type: "string" }, proof: { type: "string" }, "storage-offer": { type: "string" },
    lattice: { type: "string" }, interval: { type: "string", default: "30" }, "storage-budget": { type: "string" }, once: { type: "boolean", default: false }, fee: { type: "string" },
    price: { type: "string" }, parent: { type: "string" }, chains: { type: "string" },
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
  if (install) return initManagedNode({ home, lattice: a.lattice });
  // The seller keeps its node up; another verb runs it for as long as it takes.
  if (create) return (await keepManagedNode({ home, lattice: a.lattice })).root;
  return (await runManagedNode({ home, lattice: a.lattice })).root;
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

/** The running seller's pid from `pidFile`, or undefined (a pid left by a seller that died may name another process by now). */
function runningSeller(pidFile) {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number(readFileSync(pidFile, "utf8"));
  try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).includes("sell-hosting.mjs") ? pid : undefined; } catch { return undefined; }
}

/** How to pause the seller without closing its offers (`hearth stop` closes them), then run `then`. */
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
    if (pid) fail(`the seller (pid ${pid}) signs with the seller's key, and two signers would race for its nonces: ${pauseHow("hearth sell-coin")}. Its offers stay on sale meanwhile (hearth stop would close them).`);
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
      + "Its offers stay on sale meanwhile (hearth stop would close them). The seller funds its first writes from the sponsor's key by itself.");
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
    const { status } = (await operatorRPC(node, fetchImpl)("/config")).body;
    const hosted = new Set((status.chains ?? []).filter((c) => c.actual === "hosted").map((c) => c.path));
    const own = await judgeOwn({ sdk, n, m, self, hosted });
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
    if (!isRootCID(cid)) fail(`${cid} is not a CID (bafy...): give the root CID of the file to unpin`);
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
      // The seller first, so nothing paces or sponsors any more.
      const service = installedSeller({ platform: process.platform, home: homedir() });
      if (service) {
        console.log(`stopping the seller's service: ${service.stop.join(" ")}`);
        try { execFileSync(service.stop[0], service.stop.slice(1), { stdio: "inherit" }); } catch (e) { console.log(`(${e.message.split("\n")[0]}: it may not have been loaded)`); }
      }
      if (pid) {
        try { process.kill(pid, "SIGTERM"); for (let i = 0; i < 100; i++) { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 100)); } } catch {}
        console.log(`stopped the seller (pid ${pid}), its pacer and its sponsor`);
        // Hearth's node stops with the seller that ran it: this verb runs it now.
        if (root === managedRoot(homedir())) {
          for (let i = 0; i < 40 && await nodeAnswers(root); i++) await new Promise((r) => setTimeout(r, 500));
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
    if (!a.sponsor) fail("--sponsor is a sponsor that pays market coin for work (its --payout-at), e.g. https://host.example:8650/sponsor");
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

try {
  // Every flag checked, and the node found, before anything is written.
  if (!a.price && !a.offer) a.price = DEFAULT_PRICE;
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
    console.log(`burns until ${a.burn} is burned for ${address} on ${burnChain(a["burn-chain"] ?? a.market, a.market)}, once`);
  }

  const where = root ? ["--root", root] : ["--node", a.node, "--token-file", resolve(a["token-file"])];
  const pass = (flag) => (a[flag] === undefined ? [] : [`--${flag}`, a[flag]]);
  const sponsorBin = a["sponsor-bin"]?.includes("/") ? ["--sponsor-bin", resolve(a["sponsor-bin"])] : pass("sponsor-bin");
  const sellArgs = [...where, "--market", a.market, "--key", key, "--offer", offerPath,
    ...pass("url"), ...pass("proof"), ...pass("fee"), ...pass("burn"), ...pass("burn-chain"), ...(a["storage-offer"] ? ["--storage-offer", resolve(a["storage-offer"])] : []),
    ...sponsorBin, ...pass("sponsor-port"), ...pass("sponsor-url"), ...pass("storage-rate"), ...pass("storage-budget"),
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
    // Hearth's own node, run by a hearth sell still running: the node service
    // would find its port taken.
    if (root === managedRoot(homedir()) && await nodeAnswers(root)) console.log("first stop the hearth sell running now (its node stops with it)");
    process.exit(0);
  }

  const child = spawn(process.execPath, [join(HERE, "../host/sell-hosting.mjs"), ...sellArgs, "--lattice", a.lattice], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} catch (e) {
  fail(e.message);
}
