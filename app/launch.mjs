// The one transaction that launches a chain at several hosts: an order at
// each chosen offer, all naming the same path and payload.
import { orderWrite, recordsBody } from "../client/tx.mjs";
import { inForce, isClosed, parseOffer } from "../client/records.mjs";

/**
 * The terms each chosen offer (`[[<host>/<id>, text], …]`, the version text
 * the buyer saw) sells at `height`, as `launchBody` takes them. Throws when a
 * host's version in force is no longer the one chosen, when it has closed, or
 * when `buyer` already has an order for `path` at one of these hosts in
 * `orders` (a payment that landed: launching again would pay twice).
 */
export function launchTerms({ chosen, versions, orders, buyer, path, height, name = (host) => host }) {
  for (const [k] of chosen) {
    const host = k.split("/")[0];
    if (orders.some((o) => o.host === host && o.path === path && o.buyer === buyer)) throw new Error(`You already paid for ${path} at ${name(host)}: see Your orders.`);
  }
  return chosen.map(([k, text]) => {
    const host = k.split("/")[0];
    if (inForce(versions.get(k), height) !== text) throw new Error(`${name(host)} changed its terms; review again.`);
    const offer = parseOffer(text);
    if (!offer || isClosed(offer) || offer.until <= height) throw new Error(`The offer at ${name(host)} has closed; review again.`);
    return [k, offer];
  });
}

/**
 * The body ordering `path` at each of `offers` (`[[<host>/<id>, terms], …]`,
 * at most one per host), sorted by host, so each host's write and payment
 * come together in one order.
 */
export function launchBody({ offers, buyer, path, payload, periods, height, nonce, chainPath, fee }) {
  const hosts = offers.map(([k]) => k.split("/")[0]);
  if (new Set(hosts).size !== hosts.length) throw new Error("one offer per host");
  const written = [...offers].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, offer]) => {
    const [host, id] = k.split("/");
    return orderWrite({ host, id, offer, buyer, path, payload, periods, height });
  });
  return {
    keys: written.map((w) => w.actions[0].key),
    body: recordsBody({ signer: buyer, nonce, chainPath, actions: written.flatMap((w) => w.actions), payments: written.flatMap((w) => w.payments), fee }),
  };
}

/**
 * One attempt at the launch transaction, read fresh from `reader`: the
 * nonce first, then the market. A payment that lands between the two reads
 * then shows as an order (refused by `launchTerms`) while the nonce is the
 * one it used, so a second payment can never be signed with a fresh nonce.
 * Each order is priced at the version in force at the market's height.
 */
export async function launchAttempt({ reader, market, chosen, buyer, path, payload, periods, chainPath, fee, name }) {
  const { nonce } = await reader.account(market, buyer);
  const latest = await reader.market(market);
  const offers = launchTerms({ chosen, versions: latest.versions, orders: latest.orders, buyer, path, height: latest.height, name });
  return launchBody({ offers, buyer, path, payload, periods, height: latest.height, nonce, chainPath, fee: await fee() });
}
