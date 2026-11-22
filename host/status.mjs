// What the seller reports each pass and `hearth status` prints once: both
// keys' balances, its orders and what they paid, the chains it owes, and
// the storage its sponsor has pinned against its budget (its `/terms`).
import { judge } from "../client/verdict.mjs";
import { SETTLE, parseStorageOffer } from "../client/records.mjs";
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
  const verdicts = judge({ sdk, height: m.height, versions: m.versions, orders: mine, renewals, genesis });
  const owed = new Map(), until = new Map();
  for (const o of mine) {
    const v = verdicts.get(o.key);
    if (v.kind === "owed" && v.active && !owed.has(o.path)) { owed.set(o.path, v.payload); until.set(o.path, v.until); }
  }
  const counts = {};
  for (const v of verdicts.values()) counts[v.kind] = (counts[v.kind] ?? 0) + 1;
  return { mine, renewals, verdicts, owed, until, counts };
}

/**
 * The report's lines: `seller` and `sponsor` are `{ address, balance }` on
 * the market; `earned` counts what buyers paid this seller's key in orders
 * and renewals that have settled (`settling`: those that have not); `owes`
 * names each chain owed now and the market block its paid time ends;
 * `storage` is the sponsor's `{ budget, stored, held }` (`sponsorStorage`),
 * or undefined when it reports none.
 */
export function report({ market, height, seller, sponsor, mine, renewals, counts, until, storage }) {
  const settled = (p) => height >= p.created + SETTLE;
  const sum = (ps) => ps.reduce((s, p) => s + p.paid, 0n);
  const payments = [...mine, ...renewals];
  const earned = sum(payments.filter(settled)), settling = sum(payments.filter((p) => !settled(p)));
  const owes = [...until].map(([path, end]) => `${path} (to market block ${end})`);
  return [
    `market ${market} at block ${height}: the seller's key ${seller.address} holds ${seller.balance}; the sponsor's key ${sponsor.address} holds ${sponsor.balance} (its block rewards)`,
    `${mine.length} orders ${JSON.stringify(counts)} and ${renewals.length} renewals: earned ${earned} coin${settling ? `, ${settling} more settling` : ""}`,
    `owes hosting to ${owes.length ? owes.join(", ") : "no chain now"}`,
    storage
      ? `storage pinned by the sponsor: ${formatBytes(storage.stored, true)} of its ${formatBytes(storage.budget, true)} budget, ${formatBytes(storage.held, true)} held for uploads being paid, `
        + `${formatBytes(Math.max(0, storage.budget - storage.stored - storage.held), true)} left`
      : "storage: no lattice-sponsor reporting it on the sponsor port (not running yet, or older than its storage report)",
  ];
}
