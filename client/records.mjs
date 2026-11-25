// The market chain's records. The policy filters their keys (who signs,
// written once, the offer asserted, the host paid what the key says) and an
// order's asserted offer (its parent and price); what the values say is read
// here, the same way by the host, the web app and the tests.
//
//   offer/<host>/<id>                          the host's terms, edited in place
//   order/<host>/<id>/<payer>/<n>/<paid>/<path>  the chain's genesis, or
//                                                `renew <genesis CID>` to pay
//                                                for more time on that genesis

// An account address in its one canonical spelling, as the policy's
// `is_address`: base32 CIDv1 dag-cbor sha2-256, `bafyrei` then 52 characters,
// the unused bits of the eighth (its top two, a-h) and the last (its low two) zero.
const ADDRESS = /^bafyrei[a-h][a-z2-7]{50}[aeimquy4]$/;
export const isAddress = (text) => typeof text === "string" && ADDRESS.test(text);

/** A canonical unsigned decimal (no sign, no leading zero) as a BigInt, or undefined. */
export function decimal(text) {
  return typeof text === "string" && /^(0|[1-9][0-9]*)$/.test(text) ? BigInt(text) : undefined;
}

export const isPath = (path) => typeof path === "string" && path.length > 0 && path.split("/").every((s) => s !== "");
export const parentOf = (path) => path.split("/").slice(0, -1).join("/");

export const offerKey = (host, id) => `offer/${host}/${id}`;
export const orderKey = ({ host, id, payer, n, paid, path }) => `order/${host}/${id}/${payer}/${n}/${paid}/${path}`;
/** What an order's value starts with when it only pays for more time on a chain already ordered. */
export const RENEW = "renew";
/** A renewal's value: `renew <cid>`, naming the genesis it pays for. */
export const renewValue = (cid) => `${RENEW} ${cid}`;
/** Whether an order's value is a renewal (a genesis is JSON, so never starts so). */
export const isRenewal = (value) => typeof value === "string" && value.startsWith(RENEW);
/** The genesis CID a renewal's value names, or undefined when it is not exactly `renew <cid>`. */
export const renewedGenesis = (value) => /^renew (bafy[a-z2-7]{50,})$/.exec(value)?.[1];

/** `{ host, id }` from an `offer/` key, or undefined. */
export function parseOfferKey(key) {
  const parts = key.split("/");
  if (parts[0] !== "offer" || parts.length !== 3) return undefined;
  const [, host, id] = parts;
  return isAddress(host) && id !== "" ? { host, id } : undefined;
}

/** `{ host, id, payer, n, paid, path }` from an `order/` key, or undefined. */
export function parseOrderKey(key) {
  const parts = key.split("/");
  if (parts[0] !== "order" || parts.length < 7) return undefined;
  const [, host, id, payer, count, amount, ...rest] = parts;
  const n = decimal(count), paid = decimal(amount);
  if (!isAddress(host) || !isAddress(payer) || id === "" || n === undefined || !paid || rest.some((s) => s === "")) return undefined;
  return { host, id, payer, n, paid, path: rest.join("/") };
}

// ---- offers ----

/**
 * An offer's lines, exactly these, in order, each a canonical decimal up to
 * 2^64 - 1 but `blocks` and `under`:
 *
 *   hashrate <n>     the host's mining power in hashes per second, merged
 *                    over every chain it hosts: each gets all of it. A
 *                    claim, not a price; readers measure what each chain
 *                    gets (client/mining.mjs).
 *   price <n>        coin per period for one chain, at least 1
 *   period <n>       market blocks a period lasts, at least 1
 *   throughput <n>   the largest block rate it takes, maxBlockSize ÷
 *                    targetBlockTime, in bytes per second
 *   storage <n>      the largest maxStateGrowth it takes, bytes per block
 *   blocks <address> where the host's blocks pay: how readers find its work
 *   under <path>     a parent chain it sells under: one line each, at least
 *                    one, sorted (by bytes), no two the same
 *
 * The host edits the record in place and deletes it to close the offer. An
 * order asserts it unchanged, so it lands only on the terms it was priced
 * at; the policy (policy/src/lib.rs) reads it the same way, and refuses an
 * order whose path is not a child of an `under` path or that pays less than
 * `price`.
 */
export const OFFER_FIELDS = ["hashrate", "price", "period", "throughput", "storage", "blocks"];

const U64_MAX = (1n << 64n) - 1n;
const utf8 = new TextEncoder();
/** `a` before `b` by their UTF-8 bytes, as the policy orders `under` lines. */
function bytesBefore(a, b) {
  const x = utf8.encode(a), y = utf8.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i];
  return x.length < y.length;
}

/** An offer's terms (`under` a list of paths), or undefined when its text is not exactly its lines. */
export function parseOffer(text) {
  if (typeof text !== "string") return undefined;
  const lines = text.split("\n");
  if (lines.length <= OFFER_FIELDS.length) return undefined;
  const offer = {};
  for (const [i, name] of OFFER_FIELDS.entries()) {
    const prefix = `${name} `;
    if (!lines[i].startsWith(prefix)) return undefined;
    const value = lines[i].slice(prefix.length);
    offer[name] = name === "blocks" ? (isAddress(value) ? value : undefined) : decimal(value);
    if (offer[name] === undefined || (name !== "blocks" && offer[name] > U64_MAX)) return undefined;
  }
  offer.under = [];
  for (const line of lines.slice(OFFER_FIELDS.length)) {
    const path = line.startsWith("under ") ? line.slice(6) : undefined;
    if (!isPath(path) || (offer.under.length && !bytesBefore(offer.under.at(-1), path))) return undefined;
    offer.under.push(path);
  }
  return offer.price > 0n && offer.period > 0n ? offer : undefined;
}

/** An offer's value as stored: `under` sorted, each once. */
export const formatOffer = (offer) => [...OFFER_FIELDS.map((name) => `${name} ${offer[name]}`),
  ...[...new Set(offer.under)].sort((a, b) => (bytesBefore(a, b) ? -1 : 1)).map((path) => `under ${path}`)].join("\n");

/** Whether `offer` sells under `path`'s parent: the policy refuses an order elsewhere. */
export const sellsUnder = (offer, path) => offer.under.includes(parentOf(path));

/**
 * Why a chain with `spec` is too big for `offer`, or undefined: its block
 * rate (maxBlockSize bytes each targetBlockTime ms) above `throughput`
 * bytes a second, or its maxStateGrowth above `storage`. Compared in whole
 * numbers, so nothing rounds.
 */
export function overLimits(offer, spec) {
  if (BigInt(spec.maxBlockSize) * 1000n > offer.throughput * BigInt(spec.targetBlockTime)) return "its spec's block rate (maxBlockSize ÷ targetBlockTime) is above the offer's throughput";
  if (BigInt(spec.maxStateGrowth) > offer.storage) return "its spec's maxStateGrowth is above the offer's storage";
  return undefined;
}

// ---- orders ----

/**
 * An order's value: the chain's genesis as the buyer minted it, strict JSON
 * with exactly these keys:
 *
 *   genesis   the genesis block's CID
 *   volumes   base64 Volume archives by root CID: every Volume a node holds
 *             for the genesis (its block, state and spec)
 *   modules   base64 policy modules by CID: exactly the spec's
 *   proofs    the genesis's work: base64 child-only proofs, each the bytes a
 *             header synced between nodes carries, which the seller hands
 *             its node with the genesis (`POST /child-blocks`)
 *
 * `parseGenesis` checks the bytes against the CIDs and reads the spec.
 */
export function parseOrderValue(text) {
  let value;
  try { value = strictJSON(text); } catch (e) { return { error: `not strict JSON: ${e.message}` }; }
  if (!isObject(value) || keys(value) !== "genesis,modules,proofs,volumes") return { error: "the order's keys are not genesis, volumes, modules, proofs" };
  const base64 = (o) => isObject(o) && Object.values(o).every((v) => typeof v === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(v) && v.length % 4 === 0);
  if (typeof value.genesis !== "string" || !/^bafy[a-z2-7]{50,}$/.test(value.genesis)) return { error: "genesis is not a CID" };
  if (!base64(value.volumes) || !Object.hasOwn(value.volumes, value.genesis)) return { error: "volumes is not base64 by CID with the genesis block's" };
  if (!base64(value.modules)) return { error: "modules is not base64 by CID" };
  if (!Array.isArray(value.proofs) || !value.proofs.length || !base64({ ...value.proofs })) return { error: "proofs is not a list of base64 proofs" };
  return value;
}

/** An order's value as written. */
export const formatOrderValue = ({ genesis, volumes, modules = {}, proofs }) => JSON.stringify({ genesis, volumes, modules, proofs });

const bytesOf = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/**
 * The genesis an order for `path` carries, checked: `{ cid, block, spec,
 * volumes }` (`volumes` decoded by root CID), or `{ error }`. Each archive
 * must decode to its CID, and be the genesis's own (reached from its block,
 * not through the parent's state, or one of the spec's modules); the block
 * must be a genesis (height 0, no parent) whose children index and spec are
 * in the volumes, the spec fitting a ChainSpec; the modules exactly the
 * spec's, each matching its CID; and every proof a child-only proof of this
 * block at `path`. Never throws on what an order carries.
 */
export function parseGenesis(sdk, value, path) {
  const volumes = {};
  try {
    for (const [cid, archive] of Object.entries(value.volumes)) volumes[cid] = sdk.decodeVolumeArchive(cid, bytesOf(archive));
  } catch (e) { return { error: `a volume does not match its CID: ${e.message}` }; }
  const blockBytes = entryBytes(volumes[value.genesis], value.genesis);
  let block;
  try { block = sdk.decodeCanonicalBlock(blockBytes); } catch (e) { return { error: `the genesis is not a block: ${e.message}` }; }
  if (block.height !== 0n || block.parentCID !== undefined) return { error: "the block is not a genesis" };
  const entries = new Map(Object.values(volumes).flatMap((v) => v.entries.map((e) => [e.cid, e.bytes])));
  if (!entries.has(block.childrenCID)) return { error: "the genesis's children index is not in its volumes" };
  const spec = specIn(sdk, entries, block.specCID);
  if (!isObject(spec)) return { error: "the genesis's spec is not in its volumes" };
  for (const [name, max] of Object.entries(SPEC_FIELDS)) if (!inRange(integer(spec[name]), max)) return { error: `spec ${name} is out of range` };
  for (const name of ["targetBlockTime", "maxBlockSize", "maxStateGrowth"]) if (integer(spec[name]) === 0n) return { error: `spec ${name} is zero` };
  const policies = spec.wasmPolicies ?? [];
  if (!Array.isArray(policies) || !policies.every((p) => isObject(p) && typeof p.moduleCID === "string")) return { error: "spec wasmPolicies is not a list of policies" };
  const named = [...new Set(policies.map((p) => p.moduleCID))];
  if (Object.keys(value.modules).sort().join() !== named.sort().join()) return { error: "the modules are not exactly the spec's" };
  for (const [cid, base64] of Object.entries(value.modules)) if (moduleCID(sdk, base64) !== cid) return { error: `module ${cid} does not match its CID` };
  const own = reachable(sdk, entries, value.genesis, block.parentStateCID);
  const extra = Object.keys(volumes).find((cid) => !own.has(cid) && !named.includes(cid));
  if (extra) return { error: `volume ${extra} is not the genesis's own` };
  for (const proof of value.proofs) {
    const decoded = sdk.decodeChildBlockProof(bytesOf(proof));
    const verified = decoded && sdk.verifyChildBlockProof(decoded, blockBytes, path.split("/"));
    // `ok` alone says the proof is well formed; `work` that its hash meets the genesis's target.
    if (!verified?.ok || verified.evidence.work === undefined) return { error: `a proof does not prove this genesis at ${path}` };
  }
  return { cid: value.genesis, block, spec, volumes };
}

/** The bytes of entry `cid` in a decoded volume (`{ rootCID, entries }`), or undefined. */
const entryBytes = (volume, cid) => volume?.entries.find((e) => e.cid === cid)?.bytes;

/** The spec `cid` names, decoded from `entries` (CID → bytes), or undefined. */
function specIn(sdk, entries, cid) {
  try { return entries.has(cid) ? sdk.decodeDagCbor(entries.get(cid)) : undefined; } catch { return undefined; }
}

/** Every CID linked from `root` through `entries` (CID → bytes), `root` included, never through `skip`. */
function reachable(sdk, entries, root, skip) {
  const seen = new Set([root]), queue = [root];
  const links = (node, out) => {
    if (Array.isArray(node)) for (const x of node) links(x, out);
    else if (isObject(node) && !(node instanceof Uint8Array)) {
      if (typeof node.rawCID === "string") out.push(node.rawCID);
      else for (const x of Object.values(node)) links(x, out);
    }
    return out;
  };
  while (queue.length) {
    let node;
    try { node = sdk.decodeDagCbor(entries.get(queue.pop())); } catch { continue; }
    for (const cid of links(node, [])) if (cid !== skip && !seen.has(cid)) { seen.add(cid); queue.push(cid); }
  }
  return seen;
}

// ---- payloads ----

/**
 * Strict JSON: exactly what JSON.parse takes, but a duplicate key is an
 * error and every number must be a plain integer (no fraction, exponent or
 * minus zero), returned as a BigInt. One payload has one reading.
 */
export function strictJSON(text) {
  let at = 0;
  const fail = (why) => { throw new Error(`${why} at ${at}`); };
  const space = () => { while (" \t\n\r".includes(text[at]) && at < text.length) at++; };
  const value = () => {
    space();
    const c = text[at];
    if (c === "{") {
      at++; const out = Object.create(null); space();
      if (text[at] === "}") { at++; return out; }
      for (;;) {
        space(); if (text[at] !== '"') fail("expected a key");
        const key = string();
        if (Object.hasOwn(out, key)) fail(`duplicate key ${key}`);
        space(); if (text[at++] !== ":") fail("expected :");
        out[key] = value(); space();
        if (text[at] === ",") { at++; continue; }
        if (text[at++] === "}") return out;
        fail("expected , or }");
      }
    }
    if (c === "[") {
      at++; const out = []; space();
      if (text[at] === "]") { at++; return out; }
      for (;;) {
        out.push(value()); space();
        if (text[at] === ",") { at++; continue; }
        if (text[at++] === "]") return out;
        fail("expected , or ]");
      }
    }
    if (c === '"') return string();
    for (const [word, v] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(word, at)) { at += word.length; return v; }
    }
    const m = /^-?(0|[1-9][0-9]*)/.exec(text.slice(at));
    if (!m) fail("unexpected character");
    if (/^[.eE]/.test(text.slice(at + m[0].length))) fail("only integers are allowed");
    if (m[0] === "-0") fail("minus zero");
    at += m[0].length;
    return BigInt(m[0]);
  };
  const string = () => {
    const start = at;
    at++;
    while (text[at] !== '"') {
      if (at >= text.length) fail("unterminated string");
      if (text[at] === "\\") at++;
      else if (text.charCodeAt(at) < 0x20) fail("control character in a string");
      at++;
    }
    at++;
    return JSON.parse(text.slice(start, at));
  };
  const out = value();
  space();
  if (at !== text.length) fail("trailing text");
  return out;
}

const U64 = (1n << 64n) - 1n, I64 = (1n << 63n) - 1n, U16 = 0xffffn;
const SPEC_FIELDS = {
  maxNumberOfTransactionsPerBlock: U64, maxStateGrowth: I64, maxBlockSize: I64, premine: U64,
  targetBlockTime: U64, initialReward: U64, halvingInterval: U64, halfLife: U64,
};
const keys = (object) => Object.keys(object).sort().join(",");
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const inRange = (v, max) => typeof v === "bigint" && v >= 0n && v <= max;
/** A decoded integer as a BigInt, or undefined. */
const integer = (v) => (typeof v === "bigint" ? v : Number.isSafeInteger(v) ? BigInt(v) : undefined);

/** The CID of a policy module, from its base64 bytes, as Lattice names it. */
export const moduleCID = (sdk, base64) => sdk.cidV1DagCbor(sdk.encodeDagCbor({ bytes: base64 }));

/**
 * Where coin is burned for `host`: an address nobody can sign for (its
 * preimage is no public key), so what it holds is gone. Anyone can burn for a
 * host by sending coin there; the balance on each chain is that chain's burn.
 */
export const burnAddress = (sdk, host) => sdk.cidV1DagCbor(sdk.encodeDagCbor({ domain: "lattice burn v1", host }));

/** The chains from Nexus down to `path`, Nexus first: where burns for a market count. */
export const pathFromNexus = (path) => path.split("/").map((_, i, s) => s.slice(0, i + 1).join("/"));

/** A spec as JSON a node reads, numbers as plain integers. */
export const specJSON = (spec) => JSON.stringify(spec, (_, v) => (typeof v === "bigint" ? `__n${v}__` : v), 2).replace(/"__n(\d+)__"/g, "$1");

export const isHTTPS = (text) => {
  try { const u = new URL(text); return u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)); } catch { return false; }
};
