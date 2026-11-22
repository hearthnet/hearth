// Whether a host is at work, from what a buyer can check itself:
//
//   listed   the offer is open, and the sponsor it names (https, or
//            loopback) answers `GET /terms` bound to this host: its own
//            address (`address`; `fundTo` from a lattice-sponsor before it
//            named it) is the one the offer's blocks pay (`blocks`), and it
//            pays the seller (`payTo`, lattice-sponsor run with
//            `--pay-to <seller>`). A check of liveness and consistency: a
//            host's own sponsor answering for its own address, not proof
//            that it hosts anything.
//   serving  the offer's block address is credited on the buyer's chain
//            within the last max(24 h, SERVING_BLOCKS target block times),
//            as the buyer's own node read the blocks by CID
//   live     separately, the chain has a block within its last three target
//            block times, from anyone
//
// Every clock comparison allows CLOCK_SLACK_MS: block timestamps are the
// miner's clock, and the buyer's may differ.
//
// Blocks are `{ rewardRecipient, timestamp }`, as the reader's
// `recentBlocks` returns them (client/market.mjs). Reads are bounded: at most
// MAX_BLOCKS blocks per check, so on a fast chain (more than MAX_BLOCKS
// blocks in the window) a check that finds no credit before the cap says
// `unknown`, not that the host is not serving.
import { isClosed } from "./records.mjs";

/** How far a block timestamp and this clock may disagree. */
export const CLOCK_SLACK_MS = 2 * 60 * 1000;
/** A host is serving while its address has a block within max(24 h, this many target block times). */
export const SERVING_BLOCKS = 10;
/** The most blocks one check reads. */
export const MAX_BLOCKS = 1000;

/** How far back a block crediting the host counts, at the chain's target block time (ms). */
export const servingWindow = (targetBlockTime) => Math.max(24 * 3600 * 1000, SERVING_BLOCKS * Number(targetBlockTime));

/**
 * `{ ok: true }` when the offer (parsed, at market `height`) is open and
 * `terms` (its sponsor's `GET /terms`) bind it to `host`; else `{ ok: false, reason }`.
 */
export function listed({ offer, terms, host, height }) {
  if (!offer || isClosed(offer) || offer.until <= height) return { ok: false, reason: "the offer is not open" };
  if (!offer.blocks) return { ok: false, reason: "the offer names no address its blocks pay" };
  if (!offer.sponsor) return { ok: false, reason: "the offer names no sponsor" };
  if (!sponsorURL(offer.sponsor)) return { ok: false, reason: "its sponsor is not an https URL" };
  if (!terms) return { ok: false, reason: "its sponsor does not answer" };
  if ((terms.address ?? terms.fundTo) !== offer.blocks) return { ok: false, reason: "its sponsor's address is not the one its blocks pay" };
  if (terms.payTo !== host) return { ok: false, reason: "its sponsor does not pay this host" };
  return { ok: true };
}

/** Whether `url` is a sponsor to ask: https, or http on loopback (a sponsor beside the reader). */
export function sponsorURL(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch { return false; }
}

/**
 * `{ ok: true }` when a block in `blocks` credits the offer's block address
 * within `servingWindow`, else `{ ok: false, reason }`: `"unknown"` when
 * `complete` is false (the blocks stop short of the window's start).
 */
export function serving({ blocks, offer, targetBlockTime, now = Date.now(), complete = true }) {
  if (!offer?.blocks) return { ok: false, reason: "the offer names no address its blocks pay" };
  const since = now - servingWindow(targetBlockTime) - CLOCK_SLACK_MS;
  if (blocks.some((b) => b.rewardRecipient === offer.blocks && Number(b.timestamp) > since)) return { ok: true };
  // The read stopped at its cap before the window's start: no verdict.
  return complete ? { ok: false, reason: "no block of this chain pays the host lately" } : { ok: false, reason: "unknown" };
}

/** `{ ok: true }` when `blocks` hold one within the last three target block times, else `{ ok: false, reason }`. */
export function live({ blocks, targetBlockTime, now = Date.now() }) {
  const since = now - 3 * Number(targetBlockTime) - CLOCK_SLACK_MS;
  return blocks.some((b) => Number(b.timestamp) > since) ? { ok: true } : { ok: false, reason: "no recent block" };
}

/** `listed`, asking the offer's sponsor for its terms (`fetchImpl`, `timeout` ms). */
export async function checkListed({ offer, host, height, fetchImpl = (...a) => fetch(...a), timeout = 10_000 }) {
  let terms;
  if (offer?.sponsor && sponsorURL(offer.sponsor)) {
    try {
      const response = await fetchImpl(`${offer.sponsor.replace(/\/$/, "")}/terms`, { cache: "no-store", signal: AbortSignal.timeout(timeout) });
      if (response.ok) terms = await response.json();
    } catch {}
  }
  return listed({ offer, terms, host, height });
}

/**
 * `serving` and `live` of `chain`, reading its blocks through `reader` from
 * the tip back to `servingWindow` (at most MAX_BLOCKS), stopping at the
 * first that credits the host. Hitting MAX_BLOCKS first gives `"unknown"`.
 */
export async function checkServing({ reader, chain, offer, targetBlockTime, now = Date.now() }) {
  const blocks = await reader.recentBlocks(chain, { since: now - servingWindow(targetBlockTime) - CLOCK_SLACK_MS, max: MAX_BLOCKS,
    stop: (b) => offer?.blocks !== undefined && b.rewardRecipient === offer.blocks });
  return { ...serving({ blocks, offer, targetBlockTime, now, complete: blocks.complete !== false }), live: live({ blocks, targetBlockTime, now }) };
}
