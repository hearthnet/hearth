// The one transaction that launches a chain at several hosts: an order at
// each chosen offer, all naming the same path and carrying the same genesis.
import { orderWrite, recordsBody } from "../client/tx.mjs";
import { RENEW, parseOffer } from "../client/records.mjs";

/**
 * Throws when a chosen offer (`[{ host, id, terms }]`, `terms` its text as
 * the buyer saw it) is gone or has other terms in `offers` (`<host>/<id>` →
 * text now), or when `payer` already has an order for `path` at one of these
 * hosts in `orders` (a payment that landed: launching again would pay twice).
 * The market refuses an order whose offer changed anyway; this says why first.
 */
export function launchCheck({ chosen, offers, orders, payer, path, name = (host) => host }) {
  for (const { host, id, terms } of chosen) {
    if (orders.some((o) => o.host === host && o.path === path && o.payer === payer && o.value !== RENEW)) throw new Error(`You already paid for ${path} at ${name(host)}: see Your apps.`);
    const now = offers.get(`${host}/${id}`);
    if (now === undefined) throw new Error(`The offer at ${name(host)} has closed; choose again.`);
    if (now !== terms || !parseOffer(terms)) throw new Error(`${name(host)} changed its terms; review again.`);
  }
}

/**
 * The body ordering `path` at each chosen offer (at most one per host),
 * sorted by host, each `periods` periods priced over `specs` (every chain on
 * the path, Nexus first, the new chain last), carrying `value`. `nonce`, the
 * payer's market nonce, also tells its orders apart (`n`).
 */
export function launchBody({ chosen, payer, nonce, path, value, specs, periods, chainPath, fee }) {
  const hosts = chosen.map((c) => c.host);
  if (new Set(hosts).size !== hosts.length) throw new Error("one offer per host");
  const written = [...chosen].sort((a, b) => (a.host < b.host ? -1 : 1))
    .map(({ host, id, terms }) => orderWrite({ host, id, terms, payer, n: nonce, path, value, specs, periods }));
  return {
    keys: written.map((w) => w.actions[1].key),
    paid: written.reduce((sum, w) => sum + w.paid, 0n),
    body: recordsBody({ signer: payer, nonce, chainPath, actions: written.flatMap((w) => w.actions), payments: written.flatMap((w) => w.payments), fee }),
  };
}

/**
 * One attempt at the launch transaction, read fresh from `reader`: the
 * nonce first, then the market. A payment that lands between the two reads
 * then shows as an order (refused by `launchCheck`) while the nonce is the
 * one it used, so a second payment is never signed with a fresh nonce.
 */
export async function launchAttempt({ reader, market, chosen, payer, path, value, specs, periods, chainPath, fee, name }) {
  const { nonce } = await reader.account(market, payer);
  const latest = await reader.market(market);
  launchCheck({ chosen, offers: latest.offers, orders: latest.orders, payer, path, name });
  return launchBody({ chosen, payer, nonce, path, value, specs, periods, chainPath, fee: await fee() });
}
