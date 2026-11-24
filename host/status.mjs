// What the seller reports each pass and `hearth status` prints once: both
// keys' balances, its orders and what they paid, the chains it owes, and
// the storage its sponsor has pinned against its budget (its `/terms`).
import { byLanding, judge } from "../client/verdict.mjs";
import { chainReaders } from "../client/chains.mjs";
import { parentOf, parseOrderValue } from "../client/records.mjs";
import { formatBytes } from "./hearth.mjs";

/**
 * This seller's orders on the market `market` read `m`, judged as every
 * reader judges them, with the specs above each ordered path read as the
 * web app reads them (`chains`, client/chains.mjs: the node `n`, else the
 * nodes it lists): `{ mine, verdicts, owed, until, unsure, released,
 * counts, earned }`, `owed` mapping each chain owed now to the genesis the
 * first owed order there carries (`{ cid, volumes, modules, proofs }`, as
 * `parseOrderValue` reads it), `unsure` the paths with an order unpriced or
 * that could not be judged (it may be owed), `released` the Volumes and
 * modules of chains no longer owed that no chain owed now needs (none while
 * a path in `hosted`, those the seller hosts now, is unsure): what to unpin.
 */
export async function judgeOwn({ sdk, n, m, self, market, hosted = [], chains = chainReaders(sdk, n) }) {
  const mine = m.orders.filter((o) => o.host === self).sort(byLanding);
  const specs = await chains.specsDownTo([...new Set(mine.map((o) => parentOf(o.path)))].filter(Boolean));
  const verdicts = judge({ sdk, height: m.height, orders: mine, market, specs });
  const owed = new Map(), until = new Map(), kept = new Set(), ended = new Set();
  for (const o of mine) {
    const v = verdicts.get(o.key);
    if (v.kind !== "owed") continue;
    for (const cid of v.pins) (v.active ? kept : ended).add(cid);
    if (v.active && !owed.has(o.path)) {
      const value = parseOrderValue(o.value);
      owed.set(o.path, { cid: value.genesis, volumes: value.volumes, modules: value.modules, proofs: value.proofs });
      until.set(o.path, v.until);
    }
  }
  const counts = {};
  for (const v of verdicts.values()) counts[v.kind] = (counts[v.kind] ?? 0) + 1;
  const unsure = [...new Set(mine.filter((o) => { const v = verdicts.get(o.key); return v.kind === "unpriced" || v.reason?.startsWith("the order could not be judged"); }).map((o) => o.path))];
  // Nothing is released while a chain it hosts has an order that may be owed.
  const released = unsure.some((p) => hosted.includes(p)) ? [] : [...ended].filter((cid) => !kept.has(cid));
  return { mine, verdicts, owed, until, unsure, released, counts, earned: earnings({ self, mine, verdicts }) };
}

/**
 * The chains the seller lists this pass: every path owed now (`owed`,
 * `judgeOwn`), and each it hosts now (`hosted`) that is `unsure`
 * (`judgeOwn`): only a lapse or a void drops a chain, never a spec not
 * read yet.
 */
export function hostingList({ owed, unsure, hosted }) {
  return [...new Set([...owed.keys(), ...unsure.filter((p) => hosted.includes(p))])];
}

/**
 * What other buyers paid this seller: its owed orders and the renewals that
 * bought time on them. Void orders, and the seller's own, do not count: the
 * coin of a void order is the buyer's loss, not a sale.
 */
export function earnings({ self, mine, verdicts }) {
  return mine.filter((o) => o.payer !== self && ["owed", "renewal"].includes(verdicts.get(o.key)?.kind)).reduce((sum, o) => sum + o.paid, 0n);
}

/** The report's storage line with a remote node (`--node`). */
export const REMOTE_STORAGE = "storage: not read with --node (the sponsor runs beside the remote node; run hearth status there)";

/**
 * The report's lines: `seller` and `sponsor` are `{ address, balance }` on
 * the market; `earned` as `earnings` counts it; `until`
 * names each chain owed now and the market block its paid time ends;
 * `storage` is the sponsor's `{ budget, stored, held }` (`sponsorStorage`),
 * undefined when it reports none, or a line saying why it was not read.
 */
export function report({ market, height, seller, sponsor, mine, counts, until, earned, storage }) {
  const owes = [...until].map(([path, end]) => `${path} (to market block ${end})`);
  return [
    `market ${market} at block ${height}: the seller's key ${seller.address} holds ${seller.balance}; the sponsor's key ${sponsor.address} holds ${sponsor.balance} (its block rewards)`,
    `${mine.length} orders and renewals ${JSON.stringify(counts)}: earned ${earned} coin from buyers`,
    `owes hosting to ${owes.length ? owes.join(", ") : "no chain now"}`,
    typeof storage === "string" ? storage : storage
      ? `storage pinned by the sponsor: ${formatBytes(storage.stored, true)} of its ${formatBytes(storage.budget, true)} budget, ${formatBytes(storage.held, true)} held for uploads being paid, `
        + `${formatBytes(Math.max(0, storage.budget - storage.stored - storage.held), true)} left`
      : "storage: no sponsor reporting it on the sponsor port (not running yet, or older than its storage report)",
  ];
}
