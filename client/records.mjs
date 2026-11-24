// The market chain's records. The policy filters only their keys (who signs,
// written once, a recent height, the host paid what the key says); what the
// values say is read here, the same way by the host, the web app and the tests.
//
//   offer/<host>/<id>/<height>                         the host's terms
//   url/<host>                                         the host's public read URL
//   order/<host>/<id>/<payer>/<height>/<paid>/<path>   the chain's payload, or
//                                                      RENEW to pay for more time

/** Blocks back a key's height may be (the policy's window). */
export const CREATED_WINDOW = 10n;
/** Blocks past `created` before an order is judged: the window plus six confirmations. */
export const SETTLE = CREATED_WINDOW + 6n;

const ADDRESS = /^bafyrei[a-z2-7]{52}$/;
export const isAddress = (text) => typeof text === "string" && ADDRESS.test(text);

/** A canonical unsigned decimal (no sign, no leading zero) as a BigInt, or undefined. */
export function decimal(text) {
  return typeof text === "string" && /^(0|[1-9][0-9]*)$/.test(text) ? BigInt(text) : undefined;
}

export const offerKey = (host, id, height) => `offer/${host}/${id}/${height}`;
export const urlKey = (host) => `url/${host}`;
export const orderKey = ({ host, id, payer, height, paid, path }) => `order/${host}/${id}/${payer}/${height}/${paid}/${path}`;
/** An order's value when it only pays for more time on a chain already ordered. */
export const RENEW = "renew";

/** `{ host, id, created }` from an `offer/` key, or undefined. */
export function parseOfferKey(key) {
  const parts = key.split("/");
  if (parts[0] !== "offer" || parts.length !== 4) return undefined;
  const [, host, id, height] = parts;
  const created = decimal(height);
  return isAddress(host) && id !== "" && created !== undefined ? { host, id, created } : undefined;
}

/** `{ host, id, payer, created, paid, path }` from an `order/` key, or undefined. */
export function parseOrderKey(key) {
  const parts = key.split("/");
  if (parts[0] !== "order" || parts.length < 7) return undefined;
  const [, host, id, payer, height, amount, ...rest] = parts;
  const created = decimal(height), paid = decimal(amount);
  if (!isAddress(host) || !isAddress(payer) || id === "" || created === undefined || !paid || rest.some((s) => s === "")) return undefined;
  return { host, id, payer, created, paid, path: rest.join("/") };
}

// ---- offers ----

/**
 * An offer's lines, in order. Numbers are canonical decimals. `created` is not
 * stored in the value: it is the height in the offer's key, and readers put it
 * back as the first line (see `market` in market.mjs).
 */
export const OFFER_FIELDS = [
  "created", "parent", "price", "period", "until", "capacity",
  "maxBlockSize", "maxStateGrowth", "minTargetBlockTime", "maxNumberOfTransactionsPerBlock",
  "modules",
];
const OFFER_NUMBERS = new Set(["created", "price", "period", "until", "capacity", "maxBlockSize", "maxStateGrowth", "minTargetBlockTime", "maxNumberOfTransactionsPerBlock"]);

/**
 * An offer's terms, or undefined when its text is not exactly the eleven
 * lines in order, then these optional lines, each at most once, in this
 * order. An offer that does not parse counts as no offer at all.
 *
 *   blocks <address>   where the host's own blocks pay (`offer.blocks`): its
 *                      sponsor's key, which its pacer credits on the market
 *                      and on every chain it hosts (client/service.mjs
 *                      checks them). Offers written before hosts made blocks
 *                      may end with `blocks mine` or `blocks commit`
 *                      instead; they parse, without it.
 *   sponsor <url>      the host's fee and storage sponsor (lattice-sponsor),
 *                      an https URL (`offer.sponsor`); without the line the
 *                      host runs no public sponsor.
 *   mines <n>          read from old offers only: a claimed mining rate in
 *                      hashes per second (`offer.mines`). Nothing writes it.
 *   whole path         the price is per chain on the ordered path, Nexus
 *                      included (`offer.wholePath`, `pathPrice`): a host
 *                      runs every chain on it. Without the line (offers
 *                      written before 2.1) the price is per order.
 *
 * A version whose `until` is at or below its own `created` is a close
 * (`isClosed`): `hearth stop` writes one.
 */
export function parseOffer(text) {
  if (typeof text !== "string") return undefined;
  const lines = text.split("\n");
  const rest = lines.splice(OFFER_FIELDS.length);
  const optional = {};
  if (/^blocks (mine|commit)$/.test(rest[0])) rest.shift();
  else if (rest[0]?.startsWith("blocks ")) {
    optional.blocks = rest.shift().slice("blocks ".length);
    if (!isAddress(optional.blocks)) return undefined;
  }
  if (rest[0]?.startsWith("sponsor ")) {
    optional.sponsor = rest.shift().slice("sponsor ".length);
    if (!isHTTPS(optional.sponsor)) return undefined;
  }
  if (rest[0]?.startsWith("mines ")) {
    optional.mines = decimal(rest.shift().slice("mines ".length));
    if (!optional.mines) return undefined;
  }
  if (rest[0] === "whole path") { rest.shift(); optional.wholePath = true; }
  if (rest.length || lines.length !== OFFER_FIELDS.length) return undefined;
  const offer = {};
  for (const [i, name] of OFFER_FIELDS.entries()) {
    const prefix = `${name} `;
    if (!lines[i].startsWith(prefix)) return undefined;
    const value = lines[i].slice(prefix.length);
    if (OFFER_NUMBERS.has(name)) {
      offer[name] = decimal(value);
      if (offer[name] === undefined) return undefined;
    } else offer[name] = value;
  }
  if (offer.price === 0n || offer.period === 0n || offer.capacity === 0n) return undefined;
  if (!isPath(offer.parent)) return undefined;
  if (offer.modules === "any") offer.modules = "any";
  else {
    const cids = offer.modules === "" ? [] : offer.modules.split(",");
    if (cids.some((cid) => !/^bafyrei[a-z2-7]{52}$/.test(cid)) || new Set(cids).size !== cids.length) return undefined;
    offer.modules = cids;
  }
  for (const name of ["blocks", "sponsor", "mines", "wholePath"]) if (optional[name] !== undefined) offer[name] = optional[name];
  return offer;
}

/** Whether an offer version closes its offer: it ends where it was written. */
export const isClosed = (offer) => offer.until <= offer.created;

/** An offer's text for `parseOffer`: `created` from its key, then its stored value. */
export const offerText = (created, value) => `created ${created}\n${value}`;

/** An offer's value as stored: its lines without `created`, then `blocks`, `sponsor` and `whole path` when it has them (never `mines`). */
export function formatOffer(offer) {
  return OFFER_FIELDS.filter((name) => name !== "created").map((name) => {
    const value = name !== "modules" ? offer[name] : offer.modules === "any" ? "any" : offer.modules.join(",");
    return `${name} ${value}`;
  }).join("\n") + (offer.blocks === undefined ? "" : `\nblocks ${offer.blocks}`) + (offer.sponsor === undefined ? "" : `\nsponsor ${offer.sponsor}`)
    + (offer.wholePath ? "\nwhole path" : "");
}

/** What one period of `offer` costs for `path`: its price for each chain on the path with `whole path`, else its price. */
export const pathPrice = (offer, path) => (offer.wholePath ? offer.price * BigInt(path.split("/").length) : offer.price);

/** Where an offer text's `created` line says it was written, or undefined. */
const createdOf = (text) => { const m = /^created (0|[1-9][0-9]*)\n/.exec(text ?? ""); return m ? BigInt(m[1]) : undefined; };

/**
 * The text of the version in force at `height` among `texts` (an offer's
 * versions, as `market` returns them, hosting or storage): the newest
 * written at or below `height - CREATED_WINDOW`, or undefined when none is.
 * A key may name any of the last CREATED_WINDOW heights, so a version takes
 * effect only once no record keyed at or after it can still be written
 * ahead of it: a host cannot backdate a version over an order it has seen.
 *
 * The bounds, exactly: the policy takes a key height k in a block at height
 * h when h - 10 <= k <= h, and a version keyed c is in force for an order
 * keyed o when c + 10 <= o. So that version landed at or before o, in a
 * block no later than the order's. Clients key an order at the tip they see
 * (o = the tip, the order landing at o + 1 or later), so the version was in
 * a block before the order's, written before the order could be seen.
 */
export function inForce(texts, height) {
  let found, at;
  for (const text of texts ?? []) {
    const c = createdOf(text);
    if (c !== undefined && c + CREATED_WINDOW <= height && (at === undefined || c > at)) { found = text; at = c; }
  }
  return found;
}

/** The hosting offer in force at `height` (`inForce`), parsed, or undefined. */
export const offerAt = (texts, height) => parseOffer(inForce(texts, height));

/** Each offer's newest version (`Map("<host>/<id>" → text)`), from `market`'s `versions`. */
export const newestOffers = (versions) => new Map([...versions].flatMap(([k, texts]) => {
  const parsed = texts.map((t) => [t, parseOffer(t)]).filter(([, o]) => o);
  return parsed.length ? [[k, parsed.reduce((a, b) => (b[1].created > a[1].created ? b : a))[0]]] : [];
}));

export const isPath = (path) => typeof path === "string" && path.length > 0 && path.split("/").every((s) => s !== "");
export const parentOf = (path) => path.split("/").slice(0, -1).join("/");

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

/**
 * A payload's reading, `{ spec, premineTo, modules, genesisTransactions }`,
 * or `{ error }`. Exactly those four keys; the spec exactly a ChainSpec's
 * nine fields in their ranges, each policy exactly its fields; `modules`
 * base64 by CID. Bytes against bytes only: nothing here runs a policy.
 */
export function parsePayload(text) {
  let payload;
  try { payload = strictJSON(text); } catch (e) { return { error: `not strict JSON: ${e.message}` }; }
  if (!isObject(payload) || keys(payload) !== "genesisTransactions,modules,premineTo,spec") return { error: "the payload's keys are not spec, premineTo, modules, genesisTransactions" };
  const { spec, premineTo, modules, genesisTransactions } = payload;
  if (!isObject(spec) || keys(spec) !== [...Object.keys(SPEC_FIELDS), "wasmPolicies"].sort().join(",")) return { error: "the spec's fields are not a ChainSpec's" };
  for (const [name, max] of Object.entries(SPEC_FIELDS)) if (!inRange(spec[name], max)) return { error: `spec ${name} is out of range` };
  if (!Array.isArray(spec.wasmPolicies)) return { error: "spec wasmPolicies is not a list" };
  for (const policy of spec.wasmPolicies) {
    const k = isObject(policy) ? keys(policy) : "";
    if (k !== "abiVersion,entrypoint,moduleCID,scope" && k !== "abiVersion,entrypoint,moduleCID,scope,sourceCID") return { error: "a policy's fields are not a WasmPolicyRef's" };
    if (!inRange(policy.abiVersion, U16) || typeof policy.entrypoint !== "string" || typeof policy.moduleCID !== "string"
      || (policy.scope !== "transaction" && policy.scope !== "action") || (k.endsWith("sourceCID") && typeof policy.sourceCID !== "string")) return { error: "a policy is malformed" };
  }
  if (premineTo !== null && !isAddress(premineTo)) return { error: "premineTo is not an address" };
  if ((spec.premine > 0n) !== (premineTo !== null)) return { error: "premineTo must name an account exactly when the spec has a premine" };
  if (!isObject(modules) || Object.values(modules).some((v) => typeof v !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(v) || v.length % 4 !== 0)) return { error: "modules is not base64 by CID" };
  if (!Array.isArray(genesisTransactions)) return { error: "genesisTransactions is not a list" };
  return { spec, premineTo, modules, genesisTransactions };
}

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

/** A payload's canonical text (what the web app writes). */
export function formatPayload({ spec, premineTo, modules, genesisTransactions }) {
  return specJSON({ spec, premineTo: premineTo ?? null, modules: modules ?? {}, genesisTransactions: genesisTransactions ?? [] }).replace(/\n\s*/g, "");
}

// ---- storage offers and orders ----
//
// A storage offer is an `offer/` record whose text is these lines, in order:
// the host's storage sponsor (lattice-sponsor `--sell-storage`, paid to the
// host's address with `--pay-to`) keeps files for good at `bytesPerCoin`, up
// to `capacity` bytes in all. A storage order is an `order/` record at that
// offer whose path is the file's root CID and whose value is `bytes <n>`, the
// size the sponsor counted for it; the order pays the host in the same
// transaction, and the buyer claims that payment at the sponsor (`POST /pay`).

export const STORAGE_FIELDS = ["created", "kind", "sponsor", "bytesPerCoin", "capacity", "until"];
const STORAGE_NUMBERS = new Set(["created", "bytesPerCoin", "capacity", "until"]);

/** A storage offer's terms, or undefined when its text is not exactly its six lines. */
export function parseStorageOffer(text) {
  if (typeof text !== "string") return undefined;
  const lines = text.split("\n");
  if (lines.length !== STORAGE_FIELDS.length) return undefined;
  const offer = {};
  for (const [i, name] of STORAGE_FIELDS.entries()) {
    if (!lines[i].startsWith(`${name} `)) return undefined;
    const value = lines[i].slice(name.length + 1);
    offer[name] = STORAGE_NUMBERS.has(name) ? decimal(value) : value;
    if (offer[name] === undefined) return undefined;
  }
  if (offer.kind !== "storage" || !isHTTPS(offer.sponsor) || offer.bytesPerCoin === 0n || offer.capacity === 0n) return undefined;
  return offer;
}

/** A storage offer's value as stored: its lines without `created`. */
export const formatStorageOffer = (offer) =>
  STORAGE_FIELDS.filter((name) => name !== "created").map((name) => `${name} ${name === "kind" ? "storage" : offer[name]}`).join("\n");

/** A storage order's value. */
export const storageOrderValue = (bytes) => `bytes ${bytes}`;
/** The bytes a storage order's value names, or undefined. */
export const parseStorageOrderValue = (text) => (typeof text === "string" && text.startsWith("bytes ") ? decimal(text.slice(6)) : undefined);

/** A file's root CID, as a storage order's path names it. */
export const isRootCID = (text) => typeof text === "string" && /^bafy[a-z2-7]{50,}$/.test(text);

/** An https URL, or plain http on this machine (local tests). */
export const isHTTPS = (text) => {
  try { const u = new URL(text); return u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)); } catch { return false; }
};

// ---- a host's url record ----
//
// `url/<host>` holds the host's public read URL, optionally followed by a line
// `proof <url>`: where the host's domain lists the addresses that sell for it
// (`{"sellers": [address, ...]}`): `/.well-known/lattice.json` on the read URL's
// hostname, on another port. Without that line it is
// `<read URL's origin>/.well-known/lattice.json`. The path is fixed, as NIP-05
// fixes it, so no other route on the domain can answer for it.

/** `{ read, proof }` from a url record's value, or undefined. */
export function parseHostURL(value) {
  if (typeof value !== "string") return undefined;
  const [read, extra, ...rest] = value.split("\n");
  if (rest.length || !isHTTPS(read)) return undefined;
  let proof = `${new URL(read).origin}/.well-known/lattice.json`;
  if (extra !== undefined) {
    if (!extra.startsWith("proof ") || !isHTTPS(extra.slice(6))) return undefined;
    proof = extra.slice(6);
    const p = new URL(proof);
    if (p.hostname !== new URL(read).hostname || p.pathname !== "/.well-known/lattice.json" || p.search || p.username || p.password) return undefined;
  }
  return { read, proof };
}

/** A url record's value for a read URL and, if given, where its proof is. */
export const formatHostURL = (read, proof) => (proof ? `${read}\nproof ${proof}` : read);
