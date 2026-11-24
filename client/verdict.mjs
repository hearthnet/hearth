// What a host owes for each order, judged the same way by the host itself
// and by anyone reading the market chain. An order is judged by the offer's
// terms in the block it landed in: it asserted those terms unchanged, so
// they are the ones it was priced at. Nothing waits: the verdict is final
// once the order is in a block.
//
//   void   the buyer's fault, from the order's own bytes and the offer: a
//          genesis that does not check out, or less than one period paid
//          for the whole path
//   owed   served from the block it landed in until its paid time runs out
//
// Paid time: a chain's owed order and its renewals at one offer, oldest
// first, each add `floor(paid / price) * period` (the price and period of
// the terms it landed on) from where paid time ends, or from the block the
// payment landed in when it had run out.
//
// Which genesis holds a path is Lattice's to decide (work, and a parent's
// commitment when the buyer makes one), not the market's.
import { RENEW, parseGenesis, parseOffer, parseOrderValue, pathFromNexus, pathPrice } from "./records.mjs";

const byLanding = (a, b) => (a.landed !== b.landed ? (a.landed < b.landed ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * `orders`: `[{ key, host, id, payer, paid, path, value, landed, terms }]`
 * as `market` returns them: `value` the record's text (the genesis, or
 * RENEW for a renewal), `landed` the market height it landed at, `terms`
 * the offer's text in that block. `specs`: `Map(path → spec)` of the chains
 * above each ordered path (Nexus first); an order whose path has one
 * missing is `unpriced` until a reader has it. Returns
 * `Map(order key → verdict)`.
 */
export function judge({ sdk, height, orders, specs = new Map() }) {
  const verdicts = new Map();
  const chains = new Map();  // `<host>/<id>/<path>` → the owed order there that renewals pay for, and its payments
  const payments = [];
  for (const o of [...orders].sort(byLanding)) {
    const terms = parseOffer(o.terms);
    const order = { landed: o.landed, paid: o.paid };
    const above = pathFromNexus(o.path).slice(0, -1);
    if (above.some((p) => !specs.has(p))) { verdicts.set(o.key, { kind: "unpriced", reason: `no spec read yet for ${above.find((p) => !specs.has(p))}`, order }); continue; }
    if (o.value === RENEW) { payments.push(o); continue; }
    const reason = !terms ? "the offer's terms do not parse"
      : genesisReason(sdk, o) ?? (o.paid < pathPrice(terms, [...above.map((p) => specs.get(p)), o.genesis.spec]) ? "paid less than one period for the whole path" : undefined);
    if (reason) { verdicts.set(o.key, { kind: "void", reason, order }); continue; }
    const at = `${o.host}/${o.id}/${o.path}`;
    if (!chains.has(at)) chains.set(at, { first: o, owed: [] });
    chains.get(at).owed.push(o);
    payments.push(o);
  }
  const paidUntil = new Map();
  for (const p of payments.sort(byLanding)) {
    const chain = chains.get(`${p.host}/${p.id}/${p.path}`);
    if (!chain || p.landed < chain.first.landed) {
      if (p.value === RENEW) verdicts.set(p.key, { kind: "void", reason: "no owed order for this chain at this offer before it", order: { landed: p.landed, paid: p.paid } });
      continue;
    }
    const terms = parseOffer(p.terms);
    const genesis = (p.value === RENEW ? chain.first : p).genesis;
    const price = pathPrice(terms, [...pathFromNexus(p.path).slice(0, -1).map((q) => specs.get(q)), genesis.spec]);
    const key = `${p.host}/${p.id}/${p.path}`;
    const end = paidUntil.get(key) ?? 0n;
    paidUntil.set(key, (end > p.landed ? end : p.landed) + (p.paid / price) * terms.period);
    if (p.value === RENEW) verdicts.set(p.key, { kind: "renewal", order: { landed: p.landed, paid: p.paid } });
  }
  for (const [key, chain] of chains) {
    const until = paidUntil.get(key);
    for (const o of chain.owed) verdicts.set(o.key, { kind: "owed", from: o.landed, until, active: height < until, order: { landed: o.landed, paid: o.paid }, genesis: o.genesis.cid });
  }
  return verdicts;
}

/** Why an order's genesis does not check out, or undefined (then `o.genesis` holds it). */
function genesisReason(sdk, o) {
  const value = parseOrderValue(o.value);
  if (value.error) return value.error;
  const genesis = parseGenesis(sdk, value);
  if (genesis.error) return genesis.error;
  o.genesis = { ...genesis, value };
  return undefined;
}
