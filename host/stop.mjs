// `hearth stop`: closes the seller's offers. A close is a newer version of
// each offer on sale whose `until` is the market's height; it takes effect
// CREATED_WINDOW blocks later (client/verdict.mjs), so orders keyed before
// then are still owed. `stop` waits until those have settled (the close
// height + CREATED_WINDOW + SETTLE, or as long as its patience allows) and
// then says what is paid. A running seller then serves what is paid itself
// (closing mode, host/sell-hosting.mjs); with no seller, or `--now`, this
// rewrites the seller's fragment to the paid chains, or deletes it.
import { reader } from "../client/market.mjs";
import { CREATED_WINDOW, SETTLE, formatOffer, isClosed, newestOffers, offerKey, parseOffer } from "../client/records.mjs";
import { recordsBody, submit } from "../client/tx.mjs";
import { judge } from "../client/verdict.mjs";
import { ordered } from "./hearth.mjs";

/** The writes that close `self`'s offers still on sale at `height` (`newest`: each offer's newest version). */
export function closingActions({ newest, self, height }) {
  return [...newest].flatMap(([k, text]) => {
    const [host, id] = k.split("/");
    const o = host === self ? parseOffer(text) : undefined;
    if (!o || isClosed(o) || o.until <= height) return [];
    const closed = { ...o, until: height };
    delete closed.mines;
    return [{ id, key: offerKey(self, id, height), newValue: formatOffer(closed), wasUntil: o.until }];
  });
}

/**
 * From `judge`'s verdicts on `orders`: the chains with paid time left,
 * `Map(path → until)`, and how many orders still settle (judged only once
 * settled: owed then if they landed before the close).
 */
export function paidTime({ orders, verdicts }) {
  const paid = new Map();
  let settling = 0;
  for (const o of orders) {
    const v = verdicts.get(o.key);
    if (v?.kind === "pending") settling++;
    if (v?.kind === "owed" && v.active && !(paid.get(o.path) > v.until)) paid.set(o.path, v.until);
  }
  return { paid, settling };
}

/** The height `self`'s newest close was written at (its offers' newest versions that close them), or undefined. */
export function closedAt({ newest, self }) {
  let at;
  for (const [k, text] of newest) {
    const o = k.startsWith(`${self}/`) ? parseOffer(text) : undefined;
    if (o && isClosed(o) && (at === undefined || o.created > at)) at = o.created;
  }
  return at;
}

/**
 * Whether a closing seller is done, and if not what it waits on: `live`
 * its offers still on sale, `closed` where its newest close was written
 * (undefined when there is none: its offers ran out, or it never had one),
 * `pending` whether an order still settles, `owed` how many chains are
 * paid. `{ done: true }` or `{ done: false, line }`.
 */
export function closingDone({ live, closed, height, pending, owed }) {
  if (live.length) return { done: false, line: `waiting for the close of ${live.map((o) => o.id).join(", ")} (run hearth stop again if it does not land)` };
  if (closed !== undefined && height < closed + CREATED_WINDOW + SETTLE) return { done: false, line: `orders settle until market block ${closed + CREATED_WINDOW + SETTLE}` };
  if (pending) return { done: false, line: "orders still settle" };
  if (owed) return { done: false, line: `serving ${owed} paid chains` };
  return { done: true };
}

/**
 * Closes the offers, waits until every order the close cannot void has
 * settled (bounded: `patience` times the time those blocks take), and,
 * unless `sellerRuns` (and not `now`), rewrites the seller's fragment.
 * `rpc(path, body, method, headers)` is the node's operator API. Returns
 * what it did, for the caller to say.
 */
export async function stop({ sdk, node, fetchImpl, rpc, privateKey, market, fee, now = false, sellerRuns = false, log = console.log, every = 5000, patience = 3 }) {
  const self = sdk.accountFromPrivateKey(privateKey).address;
  const r = reader(sdk, node, { fetchImpl });
  const blockTime = Number((await r.api("/api/chain/spec", market)).targetBlockTime);
  const wait = () => new Promise((ok) => setTimeout(ok, every));
  let m, actions;
  for (;;) {
    m = await r.market(market);
    actions = closingActions({ newest: newestOffers(m.versions), self, height: m.height });
    // A key is written once: wait out a version written at this very height.
    if (!actions.some((a) => (m.versions.get(`${self}/${a.id}`) ?? []).some((t) => t.startsWith(`created ${m.height}\n`)))) break;
    await wait();
  }
  let tx, landed = true;
  if (actions.length) {
    const at = m.height;
    const [{ nonce, balance }, info] = await Promise.all([r.account(market, self), r.api("/api/chain/info", market)]);
    const cost = BigInt(fee ?? info.minRelayFee ?? 1);
    if (balance < cost) throw new Error(`closing needs ${cost} market coin on ${market} at ${self} for the fee: send it, or earn it with hearth earn`);
    tx = await submit(sdk, node, recordsBody({ signer: self, nonce, chainPath: market.split("/"), actions: actions.map(({ key, newValue }) => ({ key, newValue })), fee: cost }), privateKey, fetchImpl);
    log(`closing ${actions.map((a) => a.id).join(", ")} at market block ${at}: ${tx}`);
    // Keyed at `at`, it lands within CREATED_WINDOW blocks or never.
    landed = false;
    for (const deadline = Date.now() + patience * Number(CREATED_WINDOW) * blockTime; !landed && Date.now() < deadline;) {
      await wait();
      m = await r.market(market);
      landed = actions.every((a) => (m.versions.get(`${self}/${a.id}`) ?? []).some((t) => t.startsWith(`created ${at}\n`)));
    }
  }
  // Orders keyed before the close takes effect are owed; they are judged
  // once settled.
  const closed = closedAt({ newest: newestOffers(m.versions), self });
  const settledAt = closed === undefined ? m.height : closed + CREATED_WINDOW + SETTLE;
  if (landed && !now && m.height < settledAt) {
    log(`waiting for market block ${settledAt}: orders placed before the close takes effect (block ${closed + CREATED_WINDOW}) are owed, judged once settled`);
    for (const deadline = Date.now() + patience * Number(settledAt - m.height) * blockTime; m.height < settledAt && Date.now() < deadline;) {
      await wait();
      m = await r.market(market);
    }
  }
  const orders = m.orders.filter((o) => o.host === self);
  const verdicts = judge({ sdk, height: m.height, versions: m.versions, orders, renewals: m.renewals.filter((x) => x.host === self) });
  const { paid, settling } = paidTime({ orders, verdicts });

  // The fragment keeps only chains with paid time (their parents are hosted
  // with them); with none, or `--now`, it goes. A running seller keeps it
  // itself.
  const keep = now ? [] : ordered([...paid.keys()]);
  let fragment, condition;
  if (now || !sellerRuns) {
    try {
      const got = await rpc("/config/fragments/hostmarket");
      fragment = got.body; condition = { "If-Match": got.etag };
    } catch (e) { if (e.status !== 404) throw e; }
    if (fragment && keep.length) await rpc("/config/fragments/hostmarket", { ...fragment, hostedChains: keep }, "PUT", condition);
    else if (fragment) await rpc("/config/fragments/hostmarket", undefined, "DELETE", condition);
  }
  return { self, height: m.height, closedAt: closed, settledAt, closed: actions, tx, landed, paid, settling, kept: keep, blockTime,
    dropped: (fragment?.hostedChains ?? []).filter((p) => !keep.includes(p)) };
}
