// What a host owes for each order, judged the same way by the host itself
// and by anyone reading the market chain. Only settled orders are judged
// (the market height is at least `created + SETTLE`): by then no order or
// offer can land ahead of them. Whether an order is owed reads only settled
// orders and offers, so a renewal never changes another order's verdict.
//
//   void   the buyer's fault, from the order's own bytes and the offer
//   full   the offer had already sold `capacity` chains
//   taken  an earlier order for the path, at any host, named another
//          payload (`elsewhere` when it was at another host: then not the
//          host's fault), or the path holds another genesis
//   owed   served from `created + SETTLE` until its paid time runs out, or
//          the offer ends, whichever is first
//
// An offer has versions (`offer/<host>/<id>/<height>` for each height it was
// written at). A version takes effect CREATED_WINDOW blocks after its
// height (`inForce` in records.mjs): a key may name any of the last
// CREATED_WINDOW heights, so a host that sees an order could still write a
// version keyed below it, but never one in force at it. An order goes by
// the version in force at its own height, and so does each payment's price.
// A version that ends where it was written closes the offer (`hearth
// stop`): an order where it is in force is void, and a renewal there buys
// nothing. An offer ends at the latest `until` any version names, so a close
// never cuts short time paid before it.
//
// Paid time: a chain's orders and renewals at one offer, oldest first, each
// add `floor(paid / price) * period` (the price and period in force at the
// payment's height) from where paid time ends, or from the payment's own
// height when it had run out.
//
// Full and taken are not the buyer's fault, and the host can cause both (its
// own orders cost it only fees): readers count them against the host as
// paid, not served.
import { SETTLE, CREATED_WINDOW, inForce, isClosed, parseOffer, parsePayload, parentOf, pathPrice, moduleCID, parseStorageOffer, parseStorageOrderValue, isRootCID } from "./records.mjs";

const byHeight = (a, b) => (a.created !== b.created ? (a.created < b.created ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * `orders`: `[{ key, host, id, buyer, created, paid, path, payloadText }]`
 * and `renewals`: `[{ key, host, id, payer, created, paid, path }]`, as
 * `market` returns them. `versions` (required): `Map("<host>/<id>" →
 * [text, ...])`, every version of every offer, as `market` returns them.
 * `genesis`: `Map(path → facts)` for paths whose genesis is known, facts as
 * `genesisFacts` returns; a path absent from it has no genesis yet.
 * Returns `Map(order key → verdict)`.
 */
export function judge({ sdk, height, versions, orders, renewals = [], genesis = new Map() }) {
  if (!(versions instanceof Map)) throw new TypeError("judge needs `versions`, every version of every offer (market().versions): one text per offer cannot show which version was in force");
  const terms = new Map([...versions].map(([key, texts]) => [key, texts.map(parseOffer).filter(Boolean)]));
  const termsAt = (key, h) => { const t = inForce(versions.get(key), h); return t === undefined ? undefined : parseOffer(t); };
  const ends = (key) => (terms.get(key) ?? []).reduce((end, v) => (v.until > end ? v.until : end), 0n);
  const verdicts = new Map();
  const settled = [];
  for (const o of orders) {
    if ((versions.get(`${o.host}/${o.id}`) ?? []).some((t) => parseStorageOffer(t))) continue;  // judgeStorage's
    const order = { created: o.created, paid: o.paid };
    if (height < o.created + SETTLE) verdicts.set(o.key, { kind: "pending", settlesAt: o.created + SETTLE, order });
    else settled.push({ ...o, order });
  }
  settled.sort(byHeight);

  const counted = new Map();  // offer → Set of chains it sold
  const firstAtPath = new Map();  // path → the earliest non-void, non-full order for it, at any host
  const owed = new Map();  // `<host>/<id>/<path>` → { offer, orders } owed for that chain
  for (const o of settled) {
    const key = `${o.host}/${o.id}`;
    const offer = termsAt(key, o.created);
    const reason = !terms.get(key)?.length ? "no such offer"
      : !offer ? `no version of the offer was in force at market block ${o.created} (a version takes effect ${CREATED_WINDOW} blocks after it is written)`
      : voidReason(sdk, o, offer);
    if (reason) { verdicts.set(o.key, { kind: "void", reason, order: o.order }); continue; }
    const chain = `${o.path}\n${o.payloadText}`;
    const sold = counted.get(`${o.host}/${o.id}`) ?? new Set();
    counted.set(`${o.host}/${o.id}`, sold);
    if (!sold.has(chain)) {
      if (BigInt(sold.size) >= offer.capacity) { verdicts.set(o.key, { kind: "full", reason: `the offer had sold its ${offer.capacity} chains`, order: o.order }); continue; }
      sold.add(chain);
    }
    // The first order decides the path, from the orders alone: a genesis a
    // reader knows never changes which order is first.
    const first = firstAtPath.get(o.path) ?? (firstAtPath.set(o.path, o), o);
    if (first.payloadText !== o.payloadText) {
      const elsewhere = first.host !== o.host;
      verdicts.set(o.key, { kind: "taken", elsewhere, reason: `an earlier order for the path${elsewhere ? ", at another host," : " at this host"} named another payload`, order: o.order });
      continue;
    }
    const facts = genesis.get(o.path);
    if (facts && !sameGenesis(sdk, facts, o.payload)) {
      verdicts.set(o.key, { kind: "taken", reason: "the path holds a genesis not built from this payload", order: o.order });
      continue;
    }
    const chainAt = `${o.host}/${o.id}/${o.path}`;
    owed.has(chainAt) ? owed.get(chainAt).push(o) : owed.set(chainAt, [o]);
  }

  for (const [chainAt, owedOrders] of owed) {
    const start = owedOrders[0].created, key = `${owedOrders[0].host}/${owedOrders[0].id}`;
    // Each payment at the version in force at its own height; a renewal
    // where none is, or where it is a close, buys nothing.
    const payments = [...owedOrders, ...renewals.filter((r) => `${r.host}/${r.id}/${r.path}` === chainAt && r.created >= start)]
      .map((p) => ({ ...p, terms: termsAt(key, p.created) }))
      .filter((p) => p.terms && !isClosed(p.terms))
      .sort(byHeight);
    const paidUntil = payments.reduce((end, p) => (end > p.created ? end : p.created) + (p.paid / pathPrice(p.terms, p.path)) * p.terms.period, 0n);
    const until = paidUntil < ends(key) ? paidUntil : ends(key);
    for (const o of owedOrders) verdicts.set(o.key, { kind: "owed", from: o.created + SETTLE, until, active: height < until, order: o.order, payload: o.payload });
  }
  return verdicts;
}

/**
 * Verdicts for storage orders (orders at storage offers), from the same
 * `offers` and `orders` as `judge`. Settled orders, oldest first:
 *
 *   void   the order is not a storage order the offer takes: created outside
 *          its time, a path that is not one root CID, a value that is not
 *          `bytes <n>`, or paid for fewer bytes than it names
 *   full   the offer's earlier owed orders already fill its capacity
 *   owed   kept until the host takes it down (`hearth unpin`); a storage
 *          sponsor never unpins by itself
 *
 * A root ordered again at the same offer counts its bytes once.
 * Returns `Map(order key → verdict)`.
 */
export function judgeStorage({ height, offers, orders }) {
  const verdicts = new Map();
  const used = new Map();  // offer → { bytes, roots }
  const settled = [];
  for (const o of orders) {
    const offer = parseStorageOffer(offers.get(`${o.host}/${o.id}`));
    if (!offer) continue;
    const order = { created: o.created, paid: o.paid };
    if (height < o.created + SETTLE) verdicts.set(o.key, { kind: "pending", settlesAt: o.created + SETTLE, order });
    else settled.push({ ...o, offer, order });
  }
  for (const o of settled.sort(byHeight)) {
    const bytes = parseStorageOrderValue(o.payloadText);
    const reason = o.created < o.offer.created || o.created > o.offer.until ? "created outside the offer's time"
      : !isRootCID(o.path) ? "the path is not a file's root CID"
      : bytes === undefined || bytes === 0n ? "the value is not bytes <n>"
      : o.paid * o.offer.bytesPerCoin < bytes ? "paid for fewer bytes than it names" : undefined;
    if (reason) { verdicts.set(o.key, { kind: "void", reason, order: o.order }); continue; }
    const at = `${o.host}/${o.id}`;
    const u = used.get(at) ?? { bytes: 0n, roots: new Set() };
    used.set(at, u);
    if (!u.roots.has(o.path)) {
      if (u.bytes + bytes > o.offer.capacity) { verdicts.set(o.key, { kind: "full", reason: `the offer had sold ${u.bytes} of its ${o.offer.capacity} bytes`, order: o.order }); continue; }
      u.bytes += bytes;
      u.roots.add(o.path);
    }
    verdicts.set(o.key, { kind: "owed", from: o.created + SETTLE, root: o.path, bytes, active: true, order: o.order });
  }
  return verdicts;
}

/** Why an order is void, from bytes alone; undefined when it is not. Sets `o.payload`. */
function voidReason(sdk, o, offer) {
  if (isClosed(offer)) return `the offer was closed at market block ${offer.created}`;
  if (o.created > offer.until) return "created outside the offer's time";
  if (o.paid < pathPrice(offer, o.path)) return "paid less than one period";
  if (parentOf(o.path) !== offer.parent || o.path.split("/").length !== offer.parent.split("/").length + 1) return `the path is not directly under ${offer.parent}`;
  if (typeof o.payloadText !== "string") return "no payload";
  const payload = parsePayload(o.payloadText);
  if (payload.error) return payload.error;
  const { spec } = payload;
  if (spec.maxBlockSize > offer.maxBlockSize) return "maxBlockSize is over the offer's";
  if (spec.maxStateGrowth > offer.maxStateGrowth) return "maxStateGrowth is over the offer's";
  if (spec.targetBlockTime < offer.minTargetBlockTime) return "targetBlockTime is under the offer's";
  if (spec.maxNumberOfTransactionsPerBlock > offer.maxNumberOfTransactionsPerBlock) return "maxNumberOfTransactionsPerBlock is over the offer's";
  const named = [...new Set(spec.wasmPolicies.map((p) => p.moduleCID))];
  if (offer.modules !== "any" && named.some((cid) => !offer.modules.includes(cid))) return "a policy module is not one the offer runs";
  if (Object.keys(payload.modules).sort().join() !== named.sort().join()) return "the modules are not exactly the spec's";
  for (const [cid, bytes] of Object.entries(payload.modules)) if (moduleCID(sdk, bytes) !== cid) return `module ${cid} does not match its CID`;
  o.payload = payload;
  return undefined;
}

/**
 * What a chain's genesis block shows of how it was built: its spec CID, the
 * account its premine paid (or null), and its signed transactions' CIDs.
 * `block` is the decoded genesis block; `transactions` its signed
 * transactions as `{ cid, signed: boolean, credited: [address] }`.
 */
export function genesisFacts(block, transactions) {
  const premine = transactions.filter((t) => !t.signed).flatMap((t) => t.credited);
  return {
    specCID: block.specCID,
    premineTo: premine.length === 1 ? premine[0] : premine.length === 0 ? null : "several",
    transactions: transactions.filter((t) => t.signed).map((t) => t.cid).sort(),
  };
}

/** Whether a genesis is the one the payload builds. */
export function sameGenesis(sdk, facts, payload) {
  if (facts.specCID !== sdk.cidV1DagCbor(sdk.encodeDagCbor(payload.spec))) return false;
  if (facts.premineTo !== payload.premineTo) return false;
  const wanted = payload.genesisTransactions.map((t) => signedCID(sdk, t)).sort();
  return wanted.length === facts.transactions.length && wanted.every((cid, i) => cid === facts.transactions[i]);
}

/** The CID of a signed transaction in the form `POST /transactions` takes. */
function signedCID(sdk, request) {
  try {
    const { signatures, body } = request.transaction;
    return sdk.signedTransactionCID(signatures, fromWire(body));
  } catch {
    return "malformed";
  }
}

const big = (v) => BigInt(v);
/** A wire transaction body (numbers as text) as the SDK's body. */
export function fromWire(body) {
  return {
    ...body,
    nonce: big(body.nonce),
    accountActions: body.accountActions.map((a) => ({ owner: a.owner, delta: big(a.delta) })),
    depositActions: body.depositActions.map((a) => ({ ...a, nonce: big(a.nonce), amountDemanded: big(a.amountDemanded), amountDeposited: big(a.amountDeposited) })),
    receiptActions: body.receiptActions.map((a) => ({ ...a, nonce: big(a.nonce), amountDemanded: big(a.amountDemanded) })),
    withdrawalActions: body.withdrawalActions.map((a) => ({ ...a, nonce: big(a.nonce), amountDemanded: big(a.amountDemanded), amountWithdrawn: big(a.amountWithdrawn) })),
  };
}
