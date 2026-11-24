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
// One genesis per path at one offer while it is paid: the first owed order
// to land there (ties in one block by key) holds the path; another genesis
// landing there before the holder's paid time ends is void; one landing
// after it ends holds the path from then on, and so on. A same-block
// front-run (a rival order whose key sorts first) costs the rival at least
// one period, paid to the host. Which genesis holds a path on Lattice is
// Lattice's to decide (work, and a parent's commitment when the buyer makes
// one), not the market's.
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
  const live = new Set(orders.map((o) => o.key));
  for (const key of checked.keys()) if (!live.has(key)) checked.delete(key);
  const verdicts = new Map();
  const chains = new Map();  // `<host>/<id>/<path>` → the genesis holding it now: `{ genesis, until, owed }`
  const held = [];  // every holder in turn, its owed orders
  const voidOf = (o, reason) => verdicts.set(o.key, { kind: "void", reason, order: { landed: o.landed, paid: o.paid } });
  // Paid time: from where it ends, or from the block the payment landed in when it had run out.
  const pay = (chain, o, price, terms) => { chain.until = (chain.until > o.landed ? chain.until : o.landed) + (o.paid / price) * terms.period; };
  for (const o of [...orders].sort(byLanding)) {
    try {
      const parts = o.path.split("/");
      if (parts[0] !== "Nexus" || parts.length < 2 || o.path === market || market.startsWith(`${o.path}/`)) { voidOf(o, "the path is not a chain under Nexus apart from the market and the chains above it"); continue; }
      const above = pathFromNexus(o.path).slice(0, -1);
      const missing = above.find((p) => !specs.has(p));
      if (missing) { verdicts.set(o.key, { kind: "unpriced", reason: `no spec read yet for ${missing}`, order: { landed: o.landed, paid: o.paid } }); continue; }
      const terms = parseOffer(o.terms);
      const aboveSpecs = above.map((p) => specs.get(p));
      const at = `${o.host}/${o.id}/${o.path}`;
      let chain = chains.get(at);
      // The chains above alone cost at most the whole path: an order short
      // of them is void before its genesis is decoded.
      const reason = !terms ? "the offer's terms do not parse"
        : o.paid < pathPrice(terms, aboveSpecs) ? "paid less than one period for the whole path"
        : o.value === RENEW ? (chain ? undefined : "no owed order for this chain at this offer before it")
        : genesisReason(sdk, o);
      if (reason) { voidOf(o, reason); continue; }
      const genesis = o.value === RENEW ? chain.genesis : o.genesis;
      const price = pathPrice(terms, [...aboveSpecs, genesis.spec]);
      if (o.paid < price) { voidOf(o, "paid less than one period for the whole path"); continue; }
      if (o.value === RENEW) { pay(chain, o, price, terms); verdicts.set(o.key, { kind: "renewal", order: { landed: o.landed, paid: o.paid } }); continue; }
      if (chain && chain.genesis.cid !== o.genesis.cid) {
        if (o.landed < chain.until) { voidOf(o, "another genesis holds this path at this host while it is paid"); continue; }
        chain = undefined;
      }
      if (!chain) { chain = { genesis: o.genesis, until: 0n, owed: [] }; chains.set(at, chain); held.push(chain); }
      pay(chain, o, price, terms);
      chain.owed.push(o);
    } catch (e) { voidOf(o, `the order could not be judged: ${e.message}`); }
  }
  for (const { until, owed } of held) {
    for (const o of owed) verdicts.set(o.key, { kind: "owed", from: o.landed, until, active: height < until, order: { landed: o.landed, paid: o.paid }, genesis: o.genesis.cid, pins: o.genesis.pins });
  }
  return verdicts;
}

/**
 * Each order's genesis as checked, by order key: an order is written once,
 * so it is decoded once. The value is kept beside it, so another value under
 * the same key (another market) is checked again. Each `judge` drops the
 * keys its orders no longer hold.
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
