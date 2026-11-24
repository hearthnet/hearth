// What a host owes for each order, judged the same way by the host itself
// and by anyone reading the market chain. An order is judged by the offer's
// terms in the block it landed in: it asserted those terms unchanged, so
// they are the ones it was priced at. Nothing waits: the verdict is final
// once the order is in a block.
//
//   void   the buyer's fault, from the order's own bytes and the offer: a
//          path no chain can have (not under Nexus, or the market or a
//          chain above it), a genesis that does not check out, or less than
//          one period paid for the whole path (a renewal too)
//   owed   served from the block it landed in until its paid time runs out
//
// Paid time: a chain's owed order and its renewals at one offer, oldest
// first, each add `floor(paid / price) * period` (the price and period of
// the terms it landed on) from where paid time ends, or from the block the
// payment landed in when it had run out.
//
// One genesis per path at one offer: the first owed order to land there
// (ties by key) fixes it; a later order there with another genesis is void.
// Which genesis holds a path on Lattice is Lattice's to decide (work, and a
// parent's commitment when the buyer makes one), not the market's.
import { RENEW, parseGenesis, parseOffer, parseOrderValue, pathFromNexus, pathPrice } from "./records.mjs";

export const byLanding = (a, b) => (a.landed !== b.landed ? (a.landed < b.landed ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * `orders`: `[{ key, host, id, payer, paid, path, value, landed, terms }]`
 * as `market` returns them: `value` the record's text (the genesis, or
 * RENEW for a renewal), `landed` the market height it landed at, `terms`
 * the offer's text in that block. `market` is the market chain's path.
 * `specs`: `Map(path → spec)` of the chains above each ordered path (Nexus
 * first); an order whose path has one missing is `unpriced` until a reader
 * has it. Returns `Map(order key → verdict)`; an order that cannot be
 * judged is void, never the call.
 */
export function judge({ sdk, height, orders, market, specs = new Map() }) {
  const verdicts = new Map();
  const chains = new Map();  // `<host>/<id>/<path>` → the owed order there that renewals pay for, and its payments
  const payments = [];
  const voidOf = (o, reason) => verdicts.set(o.key, { kind: "void", reason, order: { landed: o.landed, paid: o.paid } });
  for (const o of [...orders].sort(byLanding)) {
    try {
      const parts = o.path.split("/");
      if (parts[0] !== "Nexus" || parts.length < 2 || o.path === market || market.startsWith(`${o.path}/`)) { voidOf(o, "the path is not a chain under Nexus apart from the market and the chains above it"); continue; }
      const above = pathFromNexus(o.path).slice(0, -1);
      const missing = above.find((p) => !specs.has(p));
      if (missing) { verdicts.set(o.key, { kind: "unpriced", reason: `no spec read yet for ${missing}`, order: { landed: o.landed, paid: o.paid } }); continue; }
      const terms = parseOffer(o.terms);
      const aboveSpecs = above.map((p) => specs.get(p));
      // The chains above alone cost at most the whole path: an order short
      // of them is void before its genesis is decoded.
      const reason = !terms ? "the offer's terms do not parse"
        : o.paid < pathPrice(terms, aboveSpecs) ? "paid less than one period for the whole path"
        : o.value === RENEW ? undefined
        : genesisReason(sdk, o) ?? (o.paid < pathPrice(terms, [...aboveSpecs, o.genesis.spec]) ? "paid less than one period for the whole path" : undefined);
      if (reason) { voidOf(o, reason); continue; }
      if (o.value === RENEW) { payments.push(o); continue; }
      const at = `${o.host}/${o.id}/${o.path}`;
      if (!chains.has(at)) chains.set(at, { first: o, owed: [] });
      const chain = chains.get(at);
      if (chain.first.genesis.cid !== o.genesis.cid) { voidOf(o, "another genesis holds this path at this host"); continue; }
      chain.owed.push(o);
      payments.push(o);
    } catch (e) { voidOf(o, `the order could not be judged: ${e.message}`); }
  }
  const paidUntil = new Map();
  for (const p of payments.sort(byLanding)) {
    const key = `${p.host}/${p.id}/${p.path}`;
    const chain = chains.get(key);
    if (!chain || p.landed < chain.first.landed) {
      if (p.value === RENEW) voidOf(p, "no owed order for this chain at this offer before it");
      continue;
    }
    const terms = parseOffer(p.terms);
    const price = pathPrice(terms, [...pathFromNexus(p.path).slice(0, -1).map((q) => specs.get(q)), chain.first.genesis.spec]);
    if (p.paid < price) { voidOf(p, "paid less than one period for the whole path"); continue; }
    const end = paidUntil.get(key) ?? 0n;
    paidUntil.set(key, (end > p.landed ? end : p.landed) + (p.paid / price) * terms.period);
    if (p.value === RENEW) verdicts.set(p.key, { kind: "renewal", order: { landed: p.landed, paid: p.paid } });
  }
  for (const [key, chain] of chains) {
    const until = paidUntil.get(key);
    for (const o of chain.owed) verdicts.set(o.key, { kind: "owed", from: o.landed, until, active: height < until, order: { landed: o.landed, paid: o.paid }, genesis: o.genesis.cid, pins: o.genesis.pins });
  }
  return verdicts;
}

/**
 * Each order's genesis as checked, by order key: an order is written once,
 * so it is decoded once. The value is kept beside it, so another value under
 * the same key (another market) is checked again.
 */
const checked = new Map();

/** Why an order's genesis does not check out, or undefined (then `o.genesis` holds `{ cid, spec, pins }`). */
function genesisReason(sdk, o) {
  let c = checked.get(o.key);
  if (c?.value !== o.value) {
    const value = parseOrderValue(o.value);
    const genesis = value.error ? value : parseGenesis(sdk, value, o.path);
    c = { value: o.value, result: genesis.error ? { reason: genesis.error } : { genesis: { cid: genesis.cid, spec: genesis.spec, pins: [...Object.keys(value.volumes), ...Object.keys(value.modules)] } } };
    checked.set(o.key, c);
  }
  o.genesis = c.result.genesis;
  return c.result.reason;
}
