#!/usr/bin/env node
// Sells hosting on the market chain from a running Lattice node, as a client
// of its operator API: beside the node (--root, the loopback API and cookie)
// or anywhere else (--node and --token-file, the node's remote operator
// listener, with an admin token; see README.md).
//
//   node host/sell-hosting.mjs (--root /var/lib/lattice | --node http://10.0.0.5:8090 --token-file token) \
//     --market Nexus/testnet/hosts --key host.json --offer offer.json [--url https://host.example] \
//     [--proof https://host.example:8650/.well-known/lattice.json] [--storage-offer storage.json] \
//     [--sponsor-bin lattice-sponsor] [--sponsor-port 8650] [--sponsor-url https://host.example/sponsor] \
//     [--storage-rate 10240] [--lattice /usr/local/bin/lattice] [--interval 30] [--resume]
//
// It needs a node of Lattice 4.0.1 or newer, and says so otherwise. Each
// pass waits until the node has synced the market (`syncing market: h / H`)
// before it reads anything there, funds, writes or burns.
//
// It writes its offer and url (once its key holds the fee; until then it
// says how to fund it, or to earn it with `hearth earn`, and checks again
// each pass), then each pass, at the market's tip, reads its own orders,
// judges them as every reader does (client/verdict.mjs) and lists exactly
// the chains it owes in its own fragment of the node's configuration,
// `hostmarket` (config.d/hostmarket.json):
//
// - an owed chain not yet on its parent is created once from its payload
//   (spec, premine, genesis transactions and modules), `POST /chains`, which
//   answers the same for the same payload again; one already there is synced
//   from its peers, and its genesis compared with the payload;
// - one `PUT /config/fragments/hostmarket` lists the owed chains, sent with
//   the version it read (`If-Match`, or `If-None-Match: *` when there was
//   none); a chain whose paid time ran out is left out, and the node stops it
//   unless another layer (the operator's, the deploy's) lists it; what it
//   stored stays;
// - the fragment also lists the market and the parents its offers still on
//   sale sell under (the operator chose them by running the seller), so a
//   fresh node hosts them; an owed chain is listed only under those or a
//   parent the node hosts for another layer, so a sale never makes the node
//   host a parent the operator did not choose.
//
// It makes the blocks of the market and of every chain it hosts for its
// orders (host/pace.mjs): each at that chain's own target block time, about
// one hash a block, paid to its sponsor's key, never to the seller's.
//
// Beside the node (--root) it runs lattice-sponsor (host/sponsor.mjs,
// restarted with backoff if it exits) with its own key, `sponsor.json`
// beside the seller's (mode 0600; it owns nothing but the float the blocks
// pay it), on --sponsor-port: fees for clients who pay with work, and
// permanent pins at --storage-rate bytes per market coin. It listens on
// loopback unless --sponsor-url names where the public reaches it (an https
// URL in front of the port); the offer names that URL (`sponsor`), or no
// sponsor, and always the address its blocks pay (`blocks`).
//
// An offer sells for 30 days (its file's `duration`, in market blocks,
// otherwise). A seller the operator starts writes a version from its file
// once (on sale again for its duration); one started with --resume (the
// installed service) never does, and never reopens a closed offer. Either
// writes a new version when the address its blocks pay or its sponsor
// change, and nothing else: an offer that ran out stays off sale until the
// operator runs `hearth sell` again.
//
// `hearth stop` closes the offers and marks the seller closing (`closing`
// beside its pid, `sellerFiles`): from then on it writes no offer, keeps
// pacing and sponsoring the chains with paid time, and once none is left
// (and every order the close cannot void has settled) it deletes its
// fragment and exits 0.
//
// With --burn <amount> it burns, once, what this key's burned total on
// --burn-chain (default the market) lacks of the amount (see `burn` in
// hearth.mjs).
//
// With --storage-offer it also writes a storage offer once: the host's storage
// sponsor (paid to this key's address) keeps files for coin at that offer's
// rate. The sponsor does the selling; there is nothing for this seller to do
// for a storage order.
//
// The url record names where the host's domain lists its sellers (--proof,
// default `<url's origin>/.well-known/lattice.json`); readers trust an offer
// only when that list names its address.
//
// It never restarts the node. Failures are logged and retried next pass.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const sdk = await import(join(HERE, "../vendor/lattice-sdk.js"));
const { reader } = await import(join(HERE, "../client/market.mjs"));
const { judge } = await import(join(HERE, "../client/verdict.mjs"));
const { parseOffer, formatOffer, offerText, offerKey, urlKey, specJSON, parentOf, parseStorageOffer, formatStorageOffer, formatHostURL, parseHostURL, newestOffers, isHTTPS, isClosed } = await import(join(HERE, "../client/records.mjs"));
const { offerActions, recordsBody, submit, keyFileJSON } = await import(join(HERE, "../client/tx.mjs"));
const { periodBlocks, durationBlocks, ordered, sellerChains, liveOffers, currentOffer, fundingMessage, burn, burnChain, parseAmount, rpcPort, nodeSecret, authedFetch,
  nodeVersion, chainSync, ensureKey, operatorRPC, sellerFiles, startsReopened, DEFAULT_STORAGE_RATE } = await import(join(HERE, "hearth.mjs"));
const { closedAt, closingDone } = await import(join(HERE, "stop.mjs"));
const { pacer } = await import(join(HERE, "pace.mjs"));
const { sponsorArgs, sponsorBinary, supervise } = await import(join(HERE, "sponsor.mjs"));

const { values: args } = parseArgs({
  options: {
    root: { type: "string" }, node: { type: "string" }, "token-file": { type: "string" },
    market: { type: "string" }, key: { type: "string" }, offer: { type: "string" },
    id: { type: "string" }, url: { type: "string" }, proof: { type: "string" }, "storage-offer": { type: "string" }, lattice: { type: "string", default: "lattice" },
    interval: { type: "string", default: "30" }, once: { type: "boolean", default: false }, fee: { type: "string" },
    burn: { type: "string" }, "burn-chain": { type: "string" },
    "sponsor-bin": { type: "string", default: "lattice-sponsor" }, "sponsor-port": { type: "string", default: "8650" },
    "sponsor-url": { type: "string" }, "storage-rate": { type: "string", default: String(DEFAULT_STORAGE_RATE) },
    resume: { type: "boolean", default: false },
  },
});
for (const name of ["market", "key"]) if (!args[name]) throw new Error(`--${name} is required`);
if (!args.root === !args.node) throw new Error("give --root (beside the node) or --node with --token-file (remote)");
if (args.node && !args["token-file"]) throw new Error("--node needs --token-file");

const root = args.root && resolve(args.root);
const marketPath = args.market;
const burnAmount = args.burn === undefined ? undefined : parseAmount(args.burn, "--burn");
const burnOn = burnChain(args["burn-chain"] ?? marketPath, marketPath);
const key = JSON.parse(readFileSync(args.key, "utf8"));
const privateKey = sdk.hexToBytes(key.privateKey);
const self = sdk.accountFromPrivateKey(privateKey).address;
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

// ---- the sponsor's key: where the blocks pay, never the seller's ----

const sponsorKey = join(dirname(resolve(args.key)), "sponsor.json");
const { address: sponsorAddress, created: sponsorMade } = ensureKey(sdk, sponsorKey, keyFileJSON);
if (sponsorAddress === self) throw new Error(`${sponsorKey} is the seller's key: the sponsor's key must own nothing a draft could reach; move it away`);
const sponsorURL = args["sponsor-url"];
if (sponsorURL !== undefined && !isHTTPS(sponsorURL)) throw new Error(`--sponsor-url is the sponsor's public https URL, not ${sponsorURL}`);
if (!/^[1-9][0-9]*$/.test(args["storage-rate"])) throw new Error(`--storage-rate is bytes per market coin, a whole number, not ${args["storage-rate"]}`);
const sponsorBin = root ? sponsorBinary(args["sponsor-bin"]) : undefined;
log(`${sponsorMade ? "made the sponsor's key" : "sponsor key"} ${sponsorKey}: blocks pay ${sponsorAddress}`);
if (!root) log("with --node this seller runs no sponsor (lattice-sponsor reaches a node only on its loopback): run one beside the node yourself");

// ---- the node: its operator API, and nothing else of it ----

// Beside the node, its loopback port is the configuration's `rpc`
// (`rpcPort`), read again each pass.
let port;
const rpcURL = () => args.node ?? `http://127.0.0.1:${port}`;
const authed = authedFetch(() => nodeSecret({ root, tokenFile: args.node && args["token-file"] }));
const node = () => reader(sdk, rpcURL(), { fetchImpl: authed });

const rpc = operatorRPC(rpcURL, authed);

/** The `POST /chains` body for one chain: what fixes its genesis. */
function chainBody(path, payload) {
  return {
    path,
    spec: JSON.parse(specJSON(payload.spec)),
    ...(payload.premineTo ? { premineTo: payload.premineTo } : {}),
    ...(payload.genesisTransactions.length ? { genesisTransactions: JSON.parse(specJSON(payload.genesisTransactions)) } : {}),
    ...(Object.keys(payload.modules).length ? { policyModules: Object.keys(payload.modules).sort().map((cid) => payload.modules[cid]) } : {}),
  };
}

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

/**
 * The chains the node hosts for its other layers: those another layer lists,
 * with their ancestors (hosted implied by them).
 */
function hostedForOthers(status) {
  const kept = new Set();
  for (const chain of status.chains ?? []) {
    if (!(chain.from ?? []).some((layer) => layer !== "hostmarket")) continue;
    for (let path = chain.path; path.includes("/"); path = parentOf(path)) kept.add(path);
  }
  return kept;
}

/**
 * The parents it sells under: its offer's (`current`: as written on the
 * market, else as its file has it), and those of its offers still on sale
 * (`live`), so chains owed on an older offer stay hosted.
 */
let live = [], current;
const parents = () => [...new Set([...(current ? [current.parent] : []), ...live.map((o) => o.parent)])];
/** The chains its fragment lists besides the owed ones: the market, and the parents it sells under. */
const own = () => sellerChains({ market: marketPath, parents: parents() });

// ---- the offer ----

const offerFile = args.offer ? JSON.parse(readFileSync(args.offer, "utf8")) : undefined;
const offerId = args.id ?? offerFile?.id ?? "1";
current = currentOffer({ self, id: offerId, file: offerFile });
const storageFile = args["storage-offer"] ? JSON.parse(readFileSync(args["storage-offer"], "utf8")) : undefined;
if (storageFile && (!storageFile.id || storageFile.id === offerId)) throw new Error("the storage offer needs an id of its own, not the hosting offer's");
const urlValue = args.url && formatHostURL(args.url, args.proof);
if (urlValue && !parseHostURL(urlValue)) throw new Error("--proof must be an https URL on --url's hostname");

/**
 * Sends its writes once the key holds the market coin for them (offer, url,
 * storage offer: three fees). Until then it says what to send (or to earn
 * it with `hearth earn`), and waits.
 */
async function send(actions) {
  const n = node();
  const [{ nonce, balance }, info] = await Promise.all([n.account(marketPath, self), n.api("/api/chain/info", marketPath)]);
  const fee = BigInt(args.fee ?? info.minRelayFee ?? 1);
  const short = fundingMessage({ address: self, need: { chain: marketPath, amount: fee * 3n, balance }, interval: args.interval });
  if (short) throw new Error(short);
  return submit(sdk, rpcURL(), recordsBody({ signer: self, nonce, chainPath: marketPath.split("/"), actions, fee }), privateKey, authed);
}

let told;
/** What a version sells, and until when: printed once before it is first written. */
function tell(offer, height, targetBlockTime) {
  const text = `selling ${offer.capacity} chains under ${offer.parent} at ${offer.price} market coin per ${offer.period} market blocks`
    + `, ${sponsorURL ? `sponsoring writes and storage at ${sponsorURL}` : "with no public sponsor (no --sponsor-url)"}`
    + `, until market block ${offer.until} (about ${new Date(Date.now() + Number(offer.until - height) * Number(targetBlockTime)).toISOString().slice(0, 10)}): `
    + "an offer stays on sale until then; close it with `hearth stop`";
  if (text !== told) console.log((told = text));
}

// `hearth stop` finds this process by its pid, beside the node.
const files = sellerFiles({ root, key: resolve(args.key) });
// Whether to write a version from its file once: the operator started it.
let reopen = startsReopened({ resume: args.resume, files }), saidOff;
if (reopen) log("put on sale by the operator: writes a version from its file once, and is not closing");

/**
 * The version of its offer to write now, or undefined: one from its file
 * when there is none yet or the operator started this seller (`reopen`);
 * else the newest with its blocks address and sponsor as they are now,
 * when either changed. Never a closed or ended offer again by itself.
 */
async function nextVersion(m, newest) {
  const spec = await node().api("/api/chain/spec", marketPath);
  const was = parseOffer(newest.get(`${self}/${offerId}`));
  if (was?.created === m.height) return undefined;  // written at this height already
  let offer;
  if (!was || reopen) {
    offer = { ...Object.fromEntries(Object.entries(offerFile).map(([k, v]) => [k, typeof v === "number" ? BigInt(v) : v])), created: m.height };
    if (offer.until === undefined) offer.until = m.height + durationBlocks(offerFile.duration, spec.targetBlockTime);
    if (typeof offer.period === "string") offer.period = periodBlocks(offer.period, spec.targetBlockTime);
    delete offer.id; delete offer.duration; delete offer.mines;
  } else if (isClosed(was) || was.until <= m.height) {
    const line = `offer ${offerId} is ${isClosed(was) ? "closed" : "over"}: run hearth sell to put it on sale again`;
    if (line !== saidOff) log((saidOff = line));
    return undefined;
  } else {
    if (was.blocks === sponsorAddress && was.sponsor === sponsorURL) return undefined;
    offer = { ...was, created: m.height };
    delete offer.mines;
  }
  offer.blocks = sponsorAddress;
  if (sponsorURL) offer.sponsor = sponsorURL; else delete offer.sponsor;
  if (!parseOffer(offerText(offer.created, formatOffer(offer)))) throw new Error("the offer file does not make a valid offer");
  tell(offer, m.height, spec.targetBlockTime);
  return offer;
}

async function ensureOffer(m, newest) {
  const offer = offerFile && await nextVersion(m, newest);
  if (offer) {
    const actions = offerActions({ host: self, id: offerId, offer, height: m.height, url: urlValue, oldURL: m.urlValues.get(self) });
    log("writing offer", offerKey(self, offerId, m.height), await send(actions));
    reopen = false;
    return true;
  }
  if (storageFile && !m.versions.has(`${self}/${storageFile.id}`)) {
    const offer = { sponsor: storageFile.sponsor, bytesPerCoin: BigInt(storageFile.bytesPerCoin), capacity: BigInt(storageFile.capacity),
      until: storageFile.until !== undefined ? BigInt(storageFile.until) : m.height + BigInt(storageFile.duration ?? 525600) };
    const value = formatStorageOffer(offer);
    if (!storageFile.id || !parseStorageOffer(offerText(m.height, value))) throw new Error("the storage offer file does not make a valid storage offer");
    log("writing storage offer", offerKey(self, storageFile.id, m.height), await send([{ key: offerKey(self, storageFile.id, m.height), newValue: value }]));
    return true;
  }
  if (urlValue && m.urlValues.get(self) !== urlValue) {
    log("writing url", await send([{ key: urlKey(self), ...(m.urlValues.has(self) ? { oldValue: m.urlValues.get(self) } : {}), newValue: urlValue }]));
    return true;
  }
  return false;
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

let warned = false, checked = false, syncLine, sponsor, pace, paced = [marketPath];

/** The sponsor beside the node, started once its port is known. */
function startSponsor() {
  if (!root || sponsor || args.once) return;
  const dir = join(dirname(resolve(args.key)), "sponsor");
  mkdirSync(dir, { recursive: true });
  sponsor = supervise({ bin: sponsorBin, log, args: sponsorArgs({ node: rpcURL(), cookieFile: join(root, "chains/Nexus/.cookie"), key: sponsorKey,
    port: args["sponsor-port"], publicURL: sponsorURL, market: marketPath, storageRate: args["storage-rate"], storageFile: join(dir, "storage.json"), payTo: self }) });
  log(`sponsor on ${sponsorURL ? `every interface, port ${args["sponsor-port"]}, public at ${sponsorURL}` : `127.0.0.1:${args["sponsor-port"]} only (no --sponsor-url: the offer names no sponsor)`}`);
}

async function pass() {
  if (root) port = await rpcPort(root, args.lattice, authed);
  if (!checked) { log(`Lattice ${await nodeVersion(rpcURL(), authed)}`); checked = true; startSponsor(); }
  // The market and the offer's parent first: a fresh node reads neither yet.
  {
    const { fragment, condition } = await readFragment();
    const missing = own().filter((p) => !(fragment.hostedChains ?? []).includes(p));
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
  if (!pace && !args.once) {
    pace = pacer({ rpc: rpcURL(), fetchImpl: authed, to: sponsorAddress, chains: () => paced, log });
    const was = pace;
    was.done.catch((e) => { log(`pacer stopped (starting it again next pass): ${e.message}`); if (pace === was) pace = undefined; });
  }
  const closing = existsSync(files.closing);
  const n = node();
  const m = await n.market(marketPath).catch((e) => {
    throw e.status === 404 ? Object.assign(new Error(`waiting for the node to host ${marketPath}`), { waiting: true }) : e;
  });
  const newest = newestOffers(m.versions);
  live = liveOffers(newest, self, m.height);
  current = currentOffer({ offers: newest, self, id: offerId, file: offerFile });
  if (offerFile && !newest.has(`${self}/${offerId}`) && !warned) {
    warned = true;
    for (const o of live) log(`offer ${o.id} stays on sale until market block ${o.until} beside ${offerId}: close every offer with \`hearth stop\``);
  }
  // Storage orders are the sponsor's to serve.
  const mine = m.orders.filter((o) => o.host === self && !(m.versions.get(`${o.host}/${o.id}`) ?? []).some((t) => parseStorageOffer(t)));
  const { status } = (await rpc("/config")).body;
  const hosted = new Set((status.chains ?? []).filter((c) => c.actual === "hosted").map((c) => c.path));

  // Genesis as this node sees it, for paths it hosts.
  const genesis = new Map();
  for (const path of new Set(mine.map((o) => o.path))) {
    if (!hosted.has(path)) continue;
    const facts = await n.genesis(path).catch(() => undefined);
    if (facts) genesis.set(path, facts);
  }
  const verdicts = judge({ sdk, height: m.height, versions: m.versions, orders: mine, renewals: m.renewals.filter((r) => r.host === self), genesis });
  const owed = new Map();
  for (const o of mine) {
    const v = verdicts.get(o.key);
    if (v.kind === "owed" && v.active && !owed.has(o.path)) owed.set(o.path, v.payload);
  }
  const counts = {};
  for (const v of verdicts.values()) counts[v.kind] = (counts[v.kind] ?? 0) + 1;
  log(`market ${m.height}: ${mine.length} orders`, JSON.stringify(counts), `owed now: ${[...owed.keys()].join(" ") || "none"}`);
  if (closing) {
    // Done once every offer is closed, every order the close cannot void
    // has settled, and nothing paid is left.
    const state = closingDone({ live, closed: closedAt({ newest, self }), height: m.height, pending: !!counts.pending, owed: owed.size });
    if (state.done) {
      const { fragment, condition } = await readFragment();
      if (fragment.hostedChains) await rpc(FRAGMENT, undefined, "DELETE", condition);
      log("closed: nothing paid is left; no longer hosts", (fragment.hostedChains ?? []).join(" ") || "anything", "(what it stored stays)");
      quit(0);
    }
    log(`closing: ${state.line}`);
  } else if (await ensureOffer(m, newest)) return;

  // List every owed chain under an offer's parent or a parent the node
  // hosts for another layer, creating each one not yet on its parent first.
  // A chain it could not check this pass stays as its fragment has it.
  const { fragment, condition } = await readFragment();
  const others = hostedForOthers(status);
  const listed = own();
  for (const path of ordered([...owed.keys()])) {
    const parent = parentOf(path), directory = path.split("/").at(-1);
    if (!sellerChains({ market: marketPath, parents: parents(), owed: [path], others }).includes(path)) { log("not hosting", path, `(${parent} is not an offer's parent, and the node does not host it)`); continue; }
    const keep = () => { if ((fragment.hostedChains ?? []).includes(path)) listed.push(path); };
    let committed;
    try { committed = await n.hasChild(parent, directory); } catch (e) { log("cannot list", parent, e.message); keep(); continue; }
    if (!committed) {
      try {
        if ((await rpc("/chains", chainBody(path, owed.get(path)))).body.created) log("created", path);
      } catch (e) { log("the node did not create", path, e.message); keep(); continue; }
    }
    listed.push(path);
  }
  const before = [...(fragment.hostedChains ?? [])].sort().join(" ");
  if (before !== [...listed].sort().join(" ")) {
    try {
      await rpc(FRAGMENT, { ...fragment, hostedChains: ordered(listed) }, "PUT", condition);
      log("hosting", listed.join(" ") || "nothing", "(was", (before || "nothing") + ")");
    } catch (e) { log("could not write the fragment (will retry)", e.message); }
  }
  paced = ordered([marketPath, ...listed.filter((p) => owed.has(p))]);
  await ensureBurn();
}

mkdirSync(files.dir, { recursive: true });
const pidFile = files.pid;
writeFileSync(pidFile, `${process.pid}\n`);
const quit = (code) => { pace?.stop(); sponsor?.stop(); rmSync(pidFile, { force: true }); process.exit(code); };
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { log("stopping: the pacer and the sponsor stop with the seller"); quit(0); });

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
