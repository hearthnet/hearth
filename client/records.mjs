// The market chain's records. The policy filters only their keys (who signs,
// written once, the offer asserted, the host paid what the key says); what
// the values say is read here, the same way by the host, the web app and the
// tests.
//
//   offer/<host>/<id>                          the host's terms, edited in place
//   order/<host>/<id>/<payer>/<n>/<paid>/<path>  the chain's genesis, or RENEW
//                                                to pay for more time

const ADDRESS = /^bafyrei[a-z2-7]{52}$/;
export const isAddress = (text) => typeof text === "string" && ADDRESS.test(text);

/** A canonical unsigned decimal (no sign, no leading zero) as a BigInt, or undefined. */
export function decimal(text) {
  return typeof text === "string" && /^(0|[1-9][0-9]*)$/.test(text) ? BigInt(text) : undefined;
}

export const isPath = (path) => typeof path === "string" && path.length > 0 && path.split("/").every((s) => s !== "");
export const parentOf = (path) => path.split("/").slice(0, -1).join("/");

export const offerKey = (host, id) => `offer/${host}/${id}`;
export const orderKey = ({ host, id, payer, n, paid, path }) => `order/${host}/${id}/${payer}/${n}/${paid}/${path}`;
/** An order's value when it only pays for more time on a chain already ordered. */
export const RENEW = "renew";

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
 * An offer's lines, exactly these, in order, each a canonical decimal but
 * `blocks`:
 *
 *   hashrate <n>     the host's mining power in hashes per second, merged
 *                    over every chain it hosts: each gets all of it. A
 *                    claim, not a price; readers measure what each chain
 *                    gets (client/mining.mjs).
 *   throughput <n>   coin per kB/s of block capacity (maxBlockSize ÷
 *                    targetBlockTime), per period
 *   storage <n>      coin per kB of maxStateGrowth, per period
 *   period <n>       market blocks a period lasts, at least 1
 *   blocks <address> where the host's blocks pay: how readers find its work
 *
 * The host edits the record in place and deletes it to close the offer. An
 * order asserts it unchanged, so it lands only on the terms it priced.
 */
export const OFFER_FIELDS = ["hashrate", "throughput", "storage", "period", "blocks"];

/** An offer's terms, or undefined when its text is not exactly its five lines. */
export function parseOffer(text) {
  if (typeof text !== "string") return undefined;
  const lines = text.split("\n");
  if (lines.length !== OFFER_FIELDS.length) return undefined;
  const offer = {};
  for (const [i, name] of OFFER_FIELDS.entries()) {
    const prefix = `${name} `;
    if (!lines[i].startsWith(prefix)) return undefined;
    const value = lines[i].slice(prefix.length);
    offer[name] = name === "blocks" ? (isAddress(value) ? value : undefined) : decimal(value);
    if (offer[name] === undefined) return undefined;
  }
  return offer.period > 0n ? offer : undefined;
}

/** An offer's value as stored. */
export const formatOffer = (offer) => OFFER_FIELDS.map((name) => `${name} ${offer[name]}`).join("\n");

const ceilDiv = (a, b) => (a + b - 1n) / b;

/** What one chain with `spec` costs per period at `offer`. */
export const chainPrice = (offer, spec) =>
  ceilDiv(offer.throughput * BigInt(spec.maxBlockSize), BigInt(spec.targetBlockTime)) + ceilDiv(offer.storage * BigInt(spec.maxStateGrowth), 1000n);

/**
 * What one period of an order costs: every chain on its path, Nexus
 * included, by its own spec (`specs`, Nexus first, the ordered chain last),
 * at least 1.
 */
export function pathPrice(offer, specs) {
  const sum = specs.reduce((total, spec) => total + chainPrice(offer, spec), 0n);
  return sum > 0n ? sum : 1n;
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
 *
 * `parseGenesis` checks the bytes against the CIDs and reads the spec.
 */
export function parseOrderValue(text) {
  let value;
  try { value = strictJSON(text); } catch (e) { return { error: `not strict JSON: ${e.message}` }; }
  if (!isObject(value) || keys(value) !== "genesis,modules,volumes") return { error: "the order's keys are not genesis, volumes, modules" };
  const base64 = (o) => isObject(o) && Object.values(o).every((v) => typeof v === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(v) && v.length % 4 === 0);
  if (typeof value.genesis !== "string" || !/^bafy[a-z2-7]{50,}$/.test(value.genesis)) return { error: "genesis is not a CID" };
  if (!base64(value.volumes) || !Object.hasOwn(value.volumes, value.genesis)) return { error: "volumes is not base64 by CID with the genesis block's" };
  if (!base64(value.modules)) return { error: "modules is not base64 by CID" };
  return value;
}

/** An order's value as written. */
export const formatOrderValue = ({ genesis, volumes, modules = {} }) => JSON.stringify({ genesis, volumes, modules });

const bytesOf = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/**
 * The genesis an order carries, checked: `{ cid, block, spec, volumes }`
 * (`volumes` decoded by root CID), or `{ error }`. Each archive must decode
 * to its CID; the block must be a genesis (height 0, no parent) whose spec
 * is in one of the volumes and fits a ChainSpec; the modules exactly the
 * spec's, each matching its CID.
 */
export function parseGenesis(sdk, value) {
  const volumes = {};
  try {
    for (const [cid, archive] of Object.entries(value.volumes)) volumes[cid] = sdk.decodeVolumeArchive(cid, bytesOf(archive));
  } catch (e) { return { error: `a volume does not match its CID: ${e.message}` }; }
  let block;
  try { block = sdk.decodeCanonicalBlock(entryBytes(volumes[value.genesis], value.genesis)); } catch (e) { return { error: `the genesis is not a block: ${e.message}` }; }
  if (block.height !== 0n || block.parentCID !== undefined) return { error: "the block is not a genesis" };
  const spec = specIn(sdk, volumes, block.specCID);
  if (!spec) return { error: "the genesis's spec is not in its volumes" };
  for (const [name, max] of Object.entries(SPEC_FIELDS)) if (!inRange(BigInt(spec[name] ?? -1), max)) return { error: `spec ${name} is out of range` };
  if (BigInt(spec.targetBlockTime) === 0n) return { error: "spec targetBlockTime is zero" };
  const named = [...new Set((spec.wasmPolicies ?? []).map((p) => p.moduleCID))];
  if (Object.keys(value.modules).sort().join() !== named.sort().join()) return { error: "the modules are not exactly the spec's" };
  for (const [cid, base64] of Object.entries(value.modules)) if (moduleCID(sdk, base64) !== cid) return { error: `module ${cid} does not match its CID` };
  return { cid: value.genesis, block, spec, volumes };
}

/** The bytes of entry `cid` in a decoded volume (`{ rootCID, entries }`), or undefined. */
const entryBytes = (volume, cid) => volume?.entries.find((e) => e.cid === cid)?.bytes;

/** The spec `cid` names, decoded from whichever volume holds it, or undefined. */
function specIn(sdk, volumes, cid) {
  for (const volume of Object.values(volumes)) {
    const bytes = entryBytes(volume, cid);
    if (bytes) try { return sdk.decodeDagCbor(bytes); } catch { return undefined; }
  }
  return undefined;
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
