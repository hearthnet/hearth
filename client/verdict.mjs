// What a host owes for each order, judged the same way by the host itself
// and by anyone reading the market chain. An order is judged by the offer's
// terms in the block it landed in: it asserted those terms unchanged, so
// they are the ones it was priced at. The policy already refused an order
// whose path is not a child of one of the offer's `under` paths, or that
// paid less than its price. Nothing waits: the verdict is final once the
// order is in a block.
//
//   void   the buyer's fault, from the order's own bytes and the offer: a
//          path no chain can have (not under Nexus, or the market or a
//          chain above it), a genesis that does not check out, or one whose
//          spec is above the offer's throughput or storage (a renewal's
//          genesis too)
//   owed   served from the block it landed in until its paid time runs out
//
// Paid time: a chain's owed orders and its renewals at one host, oldest
// first, each add `floor(paid / price) * period` (the price and period of
// the terms it landed on) from where paid time ends, or from the block the
// payment landed in when it had run out.
//
// One genesis per path at one host (whichever of its offers) while it is
// paid: the first owed order to land there (ties in one block by key)
// holds the path, and renewals at any of the host's offers pay for it; another genesis
// landing there before the holder's paid time ends is void; one landing
// after it ends holds the path from then on, and so on. A same-block
// front-run (a rival order whose key sorts first) costs the rival at least
// one period, paid to the host. Which genesis holds a path on Lattice is
// Lattice's to decide (work, and a parent's commitment when the buyer makes
// one), not the market's.
import { isRenewal, overLimits, parseGenesis, renewedGenesis, parseOffer, parseOrderValue } from "./records.mjs";

export const byLanding = (a, b) => (a.landed !== b.landed ? (a.landed < b.landed ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * `orders`: `[{ key, host, id, payer, paid, path, value, landed, terms }]`
 * as `market` returns them: `value` the record's text (the genesis, or
 * `renew <genesis>` for a renewal), `landed` the market height it landed at, `terms`
 * the offer's text in that block. `market` is the market chain's path.
 * Returns `Map(order key → verdict)`; an order that cannot be judged is
 * void, never the call.
 */
export function judge({ sdk, height, orders, market }) {
  const live = new Set(orders.map((o) => o.key));
  for (const key of checked.keys()) if (!live.has(key)) checked.delete(key);
  const verdicts = new Map();
  const chains = new Map();  // `<host>/<path>` → the genesis holding it now: `{ genesis, until, owed }`
  const held = [];  // every holder in turn, its owed orders
  const voidOf = (o, reason) => verdicts.set(o.key, { kind: "void", reason, order: { landed: o.landed, paid: o.paid } });
  // Paid time: from where it ends, or from the block the payment landed in when it had run out.
  const pay = (chain, o, terms) => { chain.until = (chain.until > o.landed ? chain.until : o.landed) + (o.paid / terms.price) * terms.period; };
  for (const o of [...orders].sort(byLanding)) {
    try {
      const parts = o.path.split("/");
      if (parts[0] !== "Nexus" || parts.length < 2 || o.path === market || market.startsWith(`${o.path}/`)) { voidOf(o, "the path is not a chain under Nexus apart from the market and the chains above it"); continue; }
      const terms = parseOffer(o.terms);
      const at = `${o.host}/${o.path}`;
      let chain = chains.get(at);
      const reason = !terms ? "the offer's terms do not parse"
        : isRenewal(o.value) ? (!chain ? "no owed order for this chain at this host before it"
          : renewedGenesis(o.value) === undefined ? "the renewal names no genesis"
          : renewedGenesis(o.value) !== chain.genesis.cid ? "the renewal names another genesis than the one holding this path at this host" : undefined)
        : genesisReason(sdk, o);
      if (reason) { voidOf(o, reason); continue; }
      const genesis = isRenewal(o.value) ? chain.genesis : o.genesis;
      const over = overLimits(terms, genesis.spec);
      if (over) { voidOf(o, over); continue; }
      if (isRenewal(o.value)) { pay(chain, o, terms); verdicts.set(o.key, { kind: "renewal", order: { landed: o.landed, paid: o.paid } }); continue; }
      if (chain && chain.genesis.cid !== o.genesis.cid) {
        if (o.landed < chain.until) { voidOf(o, "another genesis holds this path at this host while it is paid"); continue; }
        chain = undefined;
      }
      if (!chain) { chain = { genesis: o.genesis, until: 0n, owed: [] }; chains.set(at, chain); held.push(chain); }
      pay(chain, o, terms);
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

/**
 * The genesis holding `path` at `host` in `verdicts` (as `judge` gives
 * them): the one its latest owed order carries, paid or not, or undefined.
 */
export function holderOf({ orders, verdicts, host, path }) {
  let latest;
  for (const o of orders) {
    const v = verdicts.get(o.key);
    if (o.host === host && o.path === path && v?.kind === "owed" && (!latest || v.from > latest.from)) latest = v;
  }
  return latest?.genesis;
}
