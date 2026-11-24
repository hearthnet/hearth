#!/usr/bin/env node
// Sells hosting on the market chain from a running Lattice node, as a client
// of its operator API: beside the node (--root, the loopback API and cookie)
// or anywhere else (--node and --token-file, the node's remote operator
// listener, with an admin token; see README.md).
//
//   node host/sell-hosting.mjs (--root /var/lib/lattice | --node http://10.0.0.5:8090 --token-file token) \
//     --market Nexus/testnet/hearth --key host.json [--id 1] [--throughput 6000] [--storage 600] [--period 1d] \
//     [--hashrate <hashes/s>] [--sponsor-bin lattice-sponsor] [--sponsor-port 8650] [--sponsor-url https://host.example/sponsor] \
//     [--storage-rate 10240] [--lattice /usr/local/bin/lattice] [--interval 30] [--resume]
//
// It needs a node of Lattice 5.0.0 or newer, and says so otherwise. Each
// pass waits until the node has synced the market (`syncing market: h / H`)
// before it reads anything there, funds, writes or burns.
//
// It mines every chain the node hosts, all the time (host/pace.mjs), paid
// to its sponsor's key, never to the seller's, and measures its hash rate.
//
// Its offer, `offer/<seller>/<id>`, is five lines: the hash rate (--hashrate,
// else the rate its miner measured over its first minute, when the offer is
// first written), the throughput and storage prices, the period in market
// blocks, and the address its blocks pay. It writes the offer once its key
// holds the fees of the offer and its close, and again, in place, whenever
// its terms or that address change. Beside the node, until the key holds
// them, the seller moves them from the sponsor key's block rewards before it
// starts lattice-sponsor, so nothing else signs with that key; until that
// key holds enough, it says it waits for them, or how to send or earn the
// coin.
//
// Each pass, at the market's tip, it reads its own orders, judges them as
// every reader does (client/verdict.mjs), and lists the market and exactly
// the chains it owes, each with the chains above it, in its own fragment of
// the node's configuration, `hostmarket` (config.d/hostmarket.json): one
// `PUT /config/fragments/hostmarket`, sent with the version it read
// (`If-Match`, or `If-None-Match: *` when there was none). A chain whose paid
// time ran out is left out, and the node stops it unless another layer lists
// it; what it stored stays. Each owed chain it has not launched in this
// process it then launches from the genesis its order carries
// (host/launch.mjs), every pass until the node weighs the genesis.
//
// Each pass prints both keys' balances, its orders, what they paid and what
// it owes, and the storage its sponsor pinned against --storage-budget, as
// its `GET /terms` reports it (host/status.mjs; `hearth status` prints the
// same once).
//
// Beside the node (--root) it runs lattice-sponsor (host/sponsor.mjs,
// restarted with backoff if it exits) with its own key, `sponsor.json`
// beside the seller's (mode 0600; it owns nothing but the float the blocks
// pay it), on --sponsor-port: fees for clients who pay with work, and pins
// (kept until taken down) at --storage-rate bytes per market coin, up to
// --storage-budget bytes pinned at once (default 256 MiB). It listens on
// loopback unless --sponsor-url names where the public reaches it (an https
// URL in front of the port). The offer never names it.
//
// `hearth stop` deletes the offer and marks the seller closing (`closing`
// beside its pid, `sellerFiles`): from then on it writes no offer, keeps
// mining and sponsoring the chains with paid time, and once its offer is
// gone and none is left paid, it deletes its fragment and exits 0. A start
// with --resume (the installed service) stays closing; one the operator
// runs (or the first after `hearth sell --install`) sells again.
//
// With --burn <amount> it burns, once, what this key's burned total on
// --burn-chain (default the market) lacks of the amount (see `burn` in
// hearth.mjs).
//
// It never restarts the node. Failures are logged and retried next pass.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const sdk = await import(join(HERE, "../vendor/lattice-sdk.js"));
const { reader } = await import(join(HERE, "../client/market.mjs"));
const { formatOffer, isHTTPS, parseOffer } = await import(join(HERE, "../client/records.mjs"));
const { offerWrite, recordsBody, submit, keyFileJSON } = await import(join(HERE, "../client/tx.mjs"));
const { ordered, sellerChains, fundingMessage, fundingStep, burn, burnChain, parseAmount, rpcPort, nodeSecret, authedFetch,
  nodeVersion, chainSync, ensureKey, operatorRPC, sellerFiles, startsReopened, parseSize, offerTerms, DEFAULT_STORAGE_RATE, DEFAULT_STORAGE_BUDGET } = await import(join(HERE, "hearth.mjs"));
const { judgeOwn, report, REMOTE_STORAGE } = await import(join(HERE, "status.mjs"));
const { launch } = await import(join(HERE, "launch.mjs"));
const { miner } = await import(join(HERE, "pace.mjs"));
const { sponsorAnswers, sponsorArgs, sponsorBinary, sponsorStorage, supervise } = await import(join(HERE, "sponsor.mjs"));

const { values: args } = parseArgs({
  options: {
    root: { type: "string" }, node: { type: "string" }, "token-file": { type: "string" },
    market: { type: "string" }, key: { type: "string" }, id: { type: "string", default: "1" },
    throughput: { type: "string" }, storage: { type: "string" }, period: { type: "string" }, hashrate: { type: "string" },
    lattice: { type: "string", default: "lattice" },
    interval: { type: "string", default: "30" }, once: { type: "boolean", default: false }, fee: { type: "string" },
    burn: { type: "string" }, "burn-chain": { type: "string" },
    "sponsor-bin": { type: "string", default: "lattice-sponsor" }, "sponsor-port": { type: "string", default: "8650" },
    "sponsor-url": { type: "string" }, "storage-rate": { type: "string", default: String(DEFAULT_STORAGE_RATE) },
    "storage-budget": { type: "string", default: String(DEFAULT_STORAGE_BUDGET) },
    resume: { type: "boolean", default: false },
    // The sponsor stays on loopback though public (a proxy beside it serves --sponsor-url).
    "sponsor-loopback": { type: "boolean", default: false },
  },
});
for (const name of ["market", "key"]) if (!args[name]) throw new Error(`--${name} is required`);
if (!args.root === !args.node) throw new Error("give --root (beside the node) or --node with --token-file (remote)");
if (args.node && !args["token-file"]) throw new Error("--node needs --token-file");

const root = args.root && resolve(args.root);
const marketPath = args.market;
const offerId = args.id;
offerTerms(args);  // every term checked before anything runs
const burnAmount = args.burn === undefined ? undefined : parseAmount(args.burn, "--burn");
const burnOn = burnChain(args["burn-chain"] ?? marketPath, marketPath);
const key = JSON.parse(readFileSync(args.key, "utf8"));
const privateKey = sdk.hexToBytes(key.privateKey);
const self = sdk.accountFromPrivateKey(privateKey).address;
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

// ---- the sponsor's key: where the blocks pay, never the seller's ----

const sponsorURL = args["sponsor-url"];
if (sponsorURL !== undefined && !isHTTPS(sponsorURL)) throw new Error(`--sponsor-url is the sponsor's public https URL, not ${sponsorURL}`);
if (!/^[1-9][0-9]*$/.test(args["storage-rate"])) throw new Error(`--storage-rate is bytes per market coin, a whole number, not ${args["storage-rate"]}`);
const storageBudget = parseSize(args["storage-budget"], "--storage-budget");
const sponsorBin = root ? sponsorBinary(args["sponsor-bin"]) : undefined;
const sponsorKey = join(dirname(resolve(args.key)), "sponsor.json");
const { address: sponsorAddress, created: sponsorMade } = ensureKey(sdk, sponsorKey, keyFileJSON);
if (sponsorAddress === self) throw new Error(`${sponsorKey} is the seller's key: the sponsor's key must own nothing a draft could reach; move it away`);
const sponsorDir = join(dirname(resolve(args.key)), "sponsor");
log(`${sponsorMade ? "made the sponsor's key" : "sponsor key"} ${sponsorKey}: blocks pay ${sponsorAddress}`);
if (!root) log("with --node this seller runs no sponsor (a sponsor reaches a node only on its loopback): run one beside the node yourself");

// ---- the node: its operator API, and nothing else of it ----

// Beside the node, its loopback port is the configuration's `rpc`
// (`rpcPort`), read again each pass.
let port;
const rpcURL = () => args.node ?? `http://127.0.0.1:${port}`;
const authed = authedFetch(() => nodeSecret({ root, tokenFile: args.node && args["token-file"] }));
const node = () => reader(sdk, rpcURL(), { fetchImpl: authed });

const rpc = operatorRPC(rpcURL, authed);

// ---- the seller's fragment of the node's configuration ----

const FRAGMENT = "/config/fragments/hostmarket";

/** Its fragment as it is, and the version to write over. */
async function readFragment() {
  try {
    const { body, etag } = await rpc(FRAGMENT);
    return { fragment: body, condition: { "If-Match": etag } };
  } catch (e) {
    if (e.status === 404) return { fragment: {}, condition: { "If-None-Match": "*" } };
    throw e;
  }
}

/** Has the fragment list exactly `chains`, when it does not yet. */
async function listInFragment(chains) {
  const { fragment, condition } = await readFragment();
  const before = [...(fragment.hostedChains ?? [])].sort().join(" ");
  if (before === [...chains].sort().join(" ")) return;
  await rpc(FRAGMENT, { ...fragment, hostedChains: ordered(chains) }, "PUT", condition);
  log("hosting", chains.join(" ") || "nothing", "(was", (before || "nothing") + ")");
}

// ---- the offer ----

/**
 * Sends its writes once the key holds the market coin for them. Until then
 * it says what to send (or to earn it with `hearth earn`), and waits.
 */
async function send(actions) {
  const n = node();
  const [{ nonce, balance }, info] = await Promise.all([n.account(marketPath, self), n.api("/api/chain/info", marketPath)]);
  const fee = BigInt(args.fee ?? info.minRelayFee ?? 1);
  const short = fundingMessage({ address: self, need: { chain: marketPath, amount: fee, balance }, interval: args.interval });
  if (short) throw new Error(short);
  return submit(sdk, rpcURL(), recordsBody({ signer: self, nonce, chainPath: marketPath.split("/"), actions, fee }), privateKey, authed);
}

let rateLine;
/**
 * The offer to write now, or undefined: its terms from the flags (the
 * period at the market's block time), the hash rate --hashrate gives, else
 * the one on the market, else the miner's measured rate (none yet: it
 * waits), and the address its blocks pay. Undefined when the market already
 * says exactly that.
 */
async function nextOffer(old) {
  const spec = await node().api("/api/chain/spec", marketPath);
  const terms = offerTerms(args, spec.targetBlockTime);
  const measured = BigInt(Math.round(mine?.rate() ?? 0));
  const hashrate = terms.hashrate ?? parseOffer(old)?.hashrate ?? (measured > 0n ? measured : undefined);
  if (hashrate === undefined) {
    const line = "the offer waits for the miner's first minute: it offers the hash rate it measures (or give --hashrate)";
    if (line !== rateLine) log((rateLine = line));
    return undefined;
  }
  const offer = { hashrate, throughput: terms.throughput, storage: terms.storage, period: terms.period, blocks: sponsorAddress };
  return formatOffer(offer) === old ? undefined : offer;
}

async function ensureOffer(m) {
  const old = m.offers.get(`${self}/${offerId}`);
  const offer = await nextOffer(old);
  if (!offer) return false;
  log(`${old === undefined ? "writing" : "changing"} offer ${offerId}: ${formatOffer(offer).replaceAll("\n", ", ")}`, await send([offerWrite({ host: self, id: offerId, offer, old })]));
  return true;
}

/**
 * `--burn`: what the burned total lacks, once; a later pass sends the same
 * transaction until it lands. Last in a pass, so a burn waiting on coin
 * never holds up hosting.
 */
async function ensureBurn() {
  if (burnAmount === undefined) return;
  try {
    const done = await burn({ sdk, node: rpcURL(), fetchImpl: authed, privateKey, chain: burnOn, amount: burnAmount, atLeast: true, fee: args.fee });
    if (done) log(`burning ${done.amount} on ${burnOn} to ${done.to} (burned so far ${done.burned}, --burn ${burnAmount})`, done.tx);
  } catch (e) { log("could not burn (will retry)", e.message); }
}

// ---- one pass ----

let checked = false, syncLine, sponsor, mine, funded = false, fundLine;
/** The owed chains whose genesis the node has weighed, since this process started. */
const launched = new Set();

/** The sponsor beside the node, started once the seller's key is funded (`fund`). */
function startSponsor() {
  if (!root || sponsor || args.once) return;
  mkdirSync(sponsorDir, { recursive: true });
  sponsor = supervise({ bin: sponsorBin, log, args: sponsorArgs({ node: rpcURL(), cookieFile: join(root, "chains/Nexus/.cookie"), key: sponsorKey,
    port: args["sponsor-port"], publicURL: sponsorURL, market: marketPath, storageRate: args["storage-rate"], storageFile: join(sponsorDir, "storage.json"),
    storageBudget, payTo: self, loopback: args["sponsor-loopback"] }) });
  log(`sponsor on ${sponsorURL && args["sponsor-loopback"] ? `127.0.0.1:${args["sponsor-port"]}, public at ${sponsorURL} through the proxy beside it` : sponsorURL ? `every interface, port ${args["sponsor-port"]}, public at ${sponsorURL}` : `127.0.0.1:${args["sponsor-port"]} only (no --sponsor-url)`}`);
}

/**
 * Whether the seller's key holds the fees of its offer and its close (true
 * from then on in this process). With `first` (its offer is not on the
 * market yet) and beside the node, before lattice-sponsor runs, it moves
 * them from the sponsor key's block rewards: the same transaction each pass
 * until it lands. Otherwise, with `first`, it says what it waits for.
 */
async function fund(first) {
  if (funded) return true;
  const n = node();
  const [seller, sponsorAccount, info] = await Promise.all([n.account(marketPath, self), n.account(marketPath, sponsorAddress), n.api("/api/chain/info", marketPath)]);
  const fee = BigInt(args.fee ?? info.minRelayFee ?? 1);
  const canMove = first && !!root && !sponsor;
  // A lattice-sponsor already on the port (started by hand, or another
  // seller's) may sign with the sponsor's key: two signers would race.
  const otherSponsor = canMove && await sponsorAnswers(args["sponsor-port"]) ? args["sponsor-port"] : undefined;
  const step = fundingStep({ fee, seller: seller.balance, sponsor: sponsorAccount.balance, canMove, otherSponsor,
    chain: marketPath, address: self, interval: args.interval });
  if (step.ready) { funded = true; fundLine = undefined; return true; }
  if (!first) return false;
  if (step.wait) { if (step.wait !== fundLine) log((fundLine = step.wait)); return false; }
  const body = sdk.buildTransfer({ from: sponsorAddress, to: self, amount: step.move, fee, nonce: sponsorAccount.nonce, chainPath: marketPath.split("/") });
  const sponsorPrivate = sdk.hexToBytes(JSON.parse(readFileSync(sponsorKey, "utf8")).privateKey);
  try {
    const tx = await submit(sdk, rpcURL(), body, sponsorPrivate, authed);
    const line = `moving ${step.move} market coin of the sponsor key's block rewards to the seller's key for its offer and its close (the sponsor starts once it has landed)`;
    if (line !== fundLine) log((fundLine = line), tx);
  } catch (e) { log("moving the sponsor's block rewards to the seller's key: not taken yet (will retry)", e.message); }
  return false;
}

async function pass() {
  if (root) port = await rpcPort(root, args.lattice, authed);
  if (!checked) { log(`node ${await nodeVersion(rpcURL(), authed)}`); checked = true; }
  // The market first: a fresh node does not read it yet.
  {
    const { fragment, condition } = await readFragment();
    const missing = sellerChains({ market: marketPath }).filter((p) => !(fragment.hostedChains ?? []).includes(p));
    if (missing.length) {
      await rpc(FRAGMENT, { ...fragment, hostedChains: ordered([...(fragment.hostedChains ?? []), ...missing]) }, "PUT", condition);
      log("hosting", missing.join(" "));
    }
  }
  // Nothing is read off the market, funded, written or burned before the
  // node has synced it.
  const sync = await chainSync(rpcURL(), marketPath, authed, "market");
  if (!sync.synced) {
    if (sync.line !== syncLine) log((syncLine = sync.line));
    return;
  }
  syncLine = undefined;
  if (!mine && !args.once) {
    mine = miner({ rpc: rpcURL(), fetchImpl: authed, to: sponsorAddress, log });
    const was = mine;
    was.done.catch((e) => { log(`miner stopped (starting it again next pass): ${e.message}`); if (mine === was) mine = undefined; });
  }
  const closing = existsSync(files.closing);
  // A closing seller only serves what is paid: it needs no coin to write.
  let ready = closing || await fund(false);
  if (ready) startSponsor();
  const n = node();
  const m = await n.market(marketPath).catch((e) => {
    throw e.status === 404 ? Object.assign(new Error(`waiting for the node to host ${marketPath}`), { waiting: true }) : e;
  });
  const open = [...m.offers.keys()].filter((k) => k.startsWith(`${self}/`));
  if (!ready) {
    // Its first write waits for its fee (`fund`); once its offer is out,
    // lattice-sponsor serves it, and a write short of coin says so.
    ready = open.length > 0 || await fund(true);
    if (ready) startSponsor();
  }
  const judged = await judgeOwn({ sdk, n, m, self });
  const { owed } = judged;
  const [sellerAccount, sponsorAccount] = await Promise.all([n.account(marketPath, self), n.account(marketPath, sponsorAddress)]);
  log(report({ market: marketPath, height: m.height, seller: { address: self, balance: sellerAccount.balance }, sponsor: { address: sponsorAddress, balance: sponsorAccount.balance },
    ...judged, storage: root ? await sponsorStorage(args["sponsor-port"]) : REMOTE_STORAGE }).join("\n  "));
  if (closing) {
    if (open.length) log(`closing: waiting for the close of ${open.map((k) => k.slice(self.length + 1)).join(", ")} (run hearth stop again if it does not land)`);
    else if (!owed.size) {
      const { fragment, condition } = await readFragment();
      if (fragment.hostedChains) await rpc(FRAGMENT, undefined, "DELETE", condition);
      log("closed: nothing paid is left; no longer hosts", (fragment.hostedChains ?? []).join(" ") || "anything", "(what it stored stays)");
      quit(0);
    } else log(`closing: serving ${owed.size} paid chains`);
  }
  // One write of its key's a pass: the burn waits for a pass with no offer write.
  const wrote = !closing && ready && await ensureOffer(m).catch((e) => { log("could not write the offer (will retry)", e.message); return false; });

  // The market and every owed chain, with the chains above each; then each
  // owed chain not launched yet, from its genesis.
  try { await listInFragment(sellerChains({ market: marketPath, owed: [...owed.keys()] })); }
  catch (e) { log("could not write the fragment (will retry)", e.message); }
  for (const path of ordered([...owed.keys()])) {
    if (launched.has(path)) continue;
    try {
      const status = await launch({ rpc, path, genesis: owed.get(path) });
      if (status === "tree") { launched.add(path); log("launched", path, owed.get(path).cid); }
      else log("launching", path, `(the node holds its genesis as ${status}; again next pass)`);
    } catch (e) { log("the node did not take the genesis of", path, `(again next pass): ${e.message}`); }
  }
  if (!wrote) await ensureBurn();
}

// `hearth stop` finds this process by its pid, beside the node.
const files = sellerFiles({ root, key: resolve(args.key) });
if (startsReopened({ resume: args.resume, files })) log("put on sale by the operator: not closing");

mkdirSync(files.dir, { recursive: true });
const pidFile = files.pid;
writeFileSync(pidFile, `${process.pid}\n`);
const quit = (code) => { mine?.stop(); sponsor?.stop(); rmSync(pidFile, { force: true }); process.exit(code); };
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { log("stopping: the miner and the sponsor stop with the seller"); quit(0); });

log(`selling hosting on ${marketPath} as ${self}`);
for (;;) {
  try { await pass(); } catch (e) {
    if (e.tooOld) { console.error(`hearth: ${e.message}`); quit(2); }
    log(...(e.waiting ? [e.message] : ["pass failed:", e.message]));
  }
  if (args.once) break;
  await new Promise((r) => setTimeout(r, Number(args.interval) * 1000));
}
quit(0);
