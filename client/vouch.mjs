// Whether a host's own servers speak for an offer's address. Anyone can write
// an offer naming someone else's URL and take buyers' coin for a host that
// never sold anything, so readers trust an offer only when the host's domain
// names its address:
//
// - every offer: the url record's proof (by default
//   `<read URL's origin>/.well-known/lattice.json`, else on the same
//   hostname) lists the address in `sellers`, as Nostr's NIP-05 lists names;
// - a storage offer, also: its sponsor's `GET /terms` is paid to the address
//   (`payTo`) at the offer's rate on the market chain.
//
// A host with no url record names no domain, so it impersonates no one: its
// offers are sold under its key alone ("key only"), judged by its record.
import { parseHostURL } from "./records.mjs";

const json = async (fetchImpl, url) => {
  const response = await fetchImpl(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
};

/**
 * `{ ok: true }`, `{ ok: false, keyOnly: true }` when the host has no url
 * record, or `{ ok: false, reason }`: does the host's domain list `host` as a seller?
 */
export async function hostVouches({ host, urlValue, fetchImpl = (...a) => fetch(...a) }) {
  if (urlValue === undefined) return { ok: false, keyOnly: true, reason: "no URL" };
  const url = parseHostURL(urlValue);
  if (!url) return { ok: false, reason: "the url record is malformed" };
  try {
    const { sellers } = await json(fetchImpl, url.proof);
    return Array.isArray(sellers) && sellers.includes(host) ? { ok: true } : { ok: false, reason: `${new URL(url.proof).host} does not list this seller` };
  } catch (e) {
    return { ok: false, reason: `cannot read ${url.proof}: ${e.message}` };
  }
}

/** As `hostVouches`, and the storage offer's sponsor is paid to `host` at the offer's rate on `market`. */
export async function storageVouches({ host, urlValue, offer, market, fetchImpl = (...a) => fetch(...a) }) {
  const domain = await hostVouches({ host, urlValue, fetchImpl });
  if (!domain.ok) return { ok: false, reason: domain.reason };
  try {
    const terms = await json(fetchImpl, `${offer.sponsor.replace(/\/$/, "")}/terms`);
    if (terms.payTo !== host) return { ok: false, reason: "the sponsor is paid to another address" };
    if (String(terms.storageRates?.[market]) !== String(offer.bytesPerCoin)) return { ok: false, reason: "the sponsor's rate on this market is not the offer's" };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `cannot read the sponsor's terms: ${e.message}` };
  }
}

/** Whether a host's hosting offers are for sale: `verified`, `key-only`, or undefined (a url record that fails: hidden). */
export const standing = (vouch) => (vouch?.ok ? "verified" : vouch?.keyOnly ? "key-only" : undefined);
