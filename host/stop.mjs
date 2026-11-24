// `hearth stop`: deletes the seller's offers, so no order lands on it again
// (an order asserts the offer it priced). Orders already in a block are
// owed for their paid time. A running seller then serves what is paid
// itself (closing mode, host/sell-hosting.mjs); with no seller, or `--now`,
// this rewrites the seller's fragment to the paid chains, or deletes it.
import { reader } from "../client/market.mjs";
import { closeWrite, recordsBody, submit } from "../client/tx.mjs";
import { sellerChains } from "./hearth.mjs";
import { judgeOwn } from "./status.mjs";

/**
 * Deletes every offer of the key, waits (up to `patience` market blocks'
 * time) until the deletion is in a block, and, unless `sellerRuns` (and not
 * `now`), rewrites the seller's fragment. `rpc(path, body, method,
 * headers)` is the node's operator API. Returns what it did, for the caller
 * to say: `paid` maps each chain with paid time left to the market block it
 * ends at.
 */
export async function stop({ sdk, node, fetchImpl, rpc, privateKey, market, fee, now = false, sellerRuns = false, log = console.log, every = 5000, patience = 10 }) {
  const self = sdk.accountFromPrivateKey(privateKey).address;
  const r = reader(sdk, node, { fetchImpl });
  const blockTime = Number((await r.api("/api/chain/spec", market)).targetBlockTime);
  let m = await r.market(market);
  const mine = () => [...m.offers].filter(([k]) => k.startsWith(`${self}/`)).map(([k, old]) => ({ id: k.slice(self.length + 1), old }));
  const closed = mine().map((o) => o.id);
  let tx, landed = true;
  if (closed.length) {
    const [{ nonce, balance }, info] = await Promise.all([r.account(market, self), r.api("/api/chain/info", market)]);
    const cost = BigInt(fee ?? info.minRelayFee ?? 1);
    if (balance < cost) throw new Error(`closing needs ${cost} market coin on ${market} at ${self} for the fee: send it, or earn it with hearth earn`);
    tx = await submit(sdk, node, recordsBody({ signer: self, nonce, chainPath: market.split("/"), actions: mine().map(({ id, old }) => closeWrite({ host: self, id, old })), fee: cost }), privateKey, fetchImpl);
    log(`closing ${closed.join(", ")} at market block ${m.height}: ${tx}`);
    landed = false;
    for (const deadline = Date.now() + patience * blockTime; !landed && Date.now() < deadline;) {
      await new Promise((ok) => setTimeout(ok, every));
      m = await r.market(market);
      landed = !mine().length;
    }
  }
  const { until: paid } = await judgeOwn({ sdk, n: r, m, self });

  // The fragment keeps only the market and the chains with paid time (with
  // the chains above them); with none, or `--now`, it goes. A running
  // seller keeps it itself.
  const keep = now || !paid.size ? [] : sellerChains({ market, owed: [...paid.keys()] });
  let fragment, condition;
  if (now || !sellerRuns) {
    try {
      const got = await rpc("/config/fragments/hostmarket");
      fragment = got.body; condition = { "If-Match": got.etag };
    } catch (e) { if (e.status !== 404) throw e; }
    if (fragment && keep.length) await rpc("/config/fragments/hostmarket", { ...fragment, hostedChains: keep }, "PUT", condition);
    else if (fragment) await rpc("/config/fragments/hostmarket", undefined, "DELETE", condition);
  }
  return { self, height: m.height, blockTime, closed, tx, landed, paid, kept: keep,
    dropped: (fragment?.hostedChains ?? []).filter((p) => !keep.includes(p)) };
}
