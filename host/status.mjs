// What the seller reports each pass and `hearth status` prints once: both
// keys' balances, its orders and what they paid, the chains it owes, and
// the storage its sponsor has pinned against its budget (its `/terms`).
import { judge } from "../client/verdict.mjs";
import { SETTLE, inForce, isClosed, parseOffer, parseStorageOffer } from "../client/records.mjs";
import { formatBytes } from "./hearth.mjs";

/** Whether an order or renewal is at one of this seller's hosting offers (storage orders are its sponsor's). */
const hosting = (m, o) => !(m.versions.get(`${o.host}/${o.id}`) ?? []).some((t) => parseStorageOffer(t));

/**
 * This seller's hosting orders on the market read `m`, judged as every
 * reader judges them, with the genesis the node holds for each path it
 * hosts (`hosted`): `{ mine, renewals, verdicts, owed, counts }`, `owed`
 * mapping each chain owed now to its payload.
 */
export async function judgeOwn({ sdk, n, m, self, hosted }) {
  const mine = m.orders.filter((o) => o.host === self && hosting(m, o));
  const renewals = m.renewals.filter((r) => r.host === self && hosting(m, r));
  const genesis = new Map();
  for (const path of new Set(mine.map((o) => o.path))) {
    if (!hosted.has(path)) continue;
    const facts = await n.genesis(path).catch(() => undefined);
    if (facts) genesis.set(path, facts);
  }
  // Every host's orders: the first order for a path, at any host, decides it (verdict.mjs).
  const verdicts = judge({ sdk, height: m.height, versions: m.versions, orders: m.orders.filter((o) => hosting(m, o)), renewals, genesis });
  const owed = new Map(), until = new Map();
  for (const o of mine) {
    const v = verdicts.get(o.key);
    if (v.kind === "owed" && v.active && !owed.has(o.path)) { owed.set(o.path, v.payload); until.set(o.path, v.until); }
  }
  const counts = {};
  for (const o of mine) { const k = verdicts.get(o.key).kind; counts[k] = (counts[k] ?? 0) + 1; }
  return { mine, renewals, verdicts, owed, until, counts, ...earnings({ m, self, mine, renewals, verdicts }) };
}

/**
 * What other buyers paid this seller for hosting: `earned`, in settled
 * orders it owes (or owed) hosting for, and settled renewals of those
 * chains that bought time (made where a version of the offer that is not a
 * close was in force); `settling`, in its orders and renewals not settled
 * yet. Void, full and taken orders, and the seller's own, count in
 * neither: the coin of a void order is the buyer's loss, not a sale.
 */
export function earnings({ m, self, mine, renewals, verdicts }) {
  const others = (p) => (p.buyer ?? p.payer) !== self;
  const settled = (p) => m.height >= p.created + SETTLE;
  let earned = 0n, settling = 0n;
  for (const o of mine.filter(others)) {
    if (!settled(o)) settling += o.paid;
    else if (verdicts.get(o.key)?.kind === "owed") earned += o.paid;
  }
  for (const r of renewals.filter(others)) {
    if (!settled(r)) { settling += r.paid; continue; }
    const served = mine.some((o) => o.id === r.id && o.path === r.path && o.created <= r.created && verdicts.get(o.key)?.kind === "owed");
    const terms = parseOffer(inForce(m.versions.get(`${r.host}/${r.id}`), r.created));
    if (served && terms && !isClosed(terms)) earned += r.paid;
  }
  return { earned, settling };
}

/** The report's storage line with a remote node (`--node`). */
export const REMOTE_STORAGE = "storage: not read with --node (the sponsor runs beside the remote node; run hearth status there)";

/**
 * The report's lines: `seller` and `sponsor` are `{ address, balance }` on
 * the market; `earned` and `settling` as `earnings` counts them; `until`
 * names each chain owed now and the market block its paid time ends;
 * `storage` is the sponsor's `{ budget, stored, held }` (`sponsorStorage`),
 * undefined when it reports none, or a line saying why it was not read.
 */
export function report({ market, height, seller, sponsor, mine, renewals, counts, until, earned, settling, storage }) {
  const owes = [...until].map(([path, end]) => `${path} (to market block ${end})`);
  return [
    `market ${market} at block ${height}: the seller's key ${seller.address} holds ${seller.balance}; the sponsor's key ${sponsor.address} holds ${sponsor.balance} (its block rewards)`,
    `${mine.length} orders ${JSON.stringify(counts)} and ${renewals.length} renewals: earned ${earned} coin from buyers${settling ? `, ${settling} more settling` : ""}`,
    `owes hosting to ${owes.length ? owes.join(", ") : "no chain now"}`,
    typeof storage === "string" ? storage : storage
      ? `storage pinned by the sponsor: ${formatBytes(storage.stored, true)} of its ${formatBytes(storage.budget, true)} budget, ${formatBytes(storage.held, true)} held for uploads being paid, `
        + `${formatBytes(Math.max(0, storage.budget - storage.stored - storage.held), true)} left`
      : "storage: no sponsor reporting it on the sponsor port (not running yet, or older than its storage report)",
  ];
}
