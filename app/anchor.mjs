// Which block a buyer's page pins its reads to, and what each host's node
// says now: the SDK walks every tip back to the pinned block, at most 2,000
// blocks, so a chain past CHECKPOINT_AFTER blocks pins a recent block its
// hosts' nodes agree on instead of its genesis.

/** Past this height, a page pins a recent block rather than genesis. */
export const CHECKPOINT_AFTER = 1500n;
/** How far past its pinned block the SDK walks by default. */
export const WALK = 2000;
/** How far below the lowest node's tip the pinned block sits, so every node holds it. */
const MARGIN = 6n;

/**
 * Node URLs as the SDK compares them (case, default port, trailing slash),
 * with repeated slashes in the path folded; repeats and invalid URLs dropped,
 * order kept (the first takes the writes).
 */
export function uniqueNodes(sdk, urls) {
  const out = [];
  for (const raw of urls) {
    try {
      const url = new URL(raw);
      url.pathname = url.pathname.replace(/\/{2,}/g, "/");
      const node = sdk.normalizeNodeURL(url.toString());
      if (!out.includes(node)) out.push(node);
    } catch {}
  }
  return out;
}

async function getJSON(fetchImpl, node, path, chain, timeoutMs) {
  const url = new URL(`${node}${path}`);
  url.searchParams.set("chainPath", chain);
  const response = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Each node's tip of `chain` now: `{ node, height, hash }`, or `{ node, error }` when it did not answer. */
export function nodesNow(nodes, chain, { fetchImpl = (...a) => fetch(...a), timeoutMs = 5000 } = {}) {
  return Promise.all(nodes.map((node) => getJSON(fetchImpl, node, "/api/block/latest", chain, timeoutMs).then(
    (b) => ({ node, height: BigInt(b.height), hash: b.hash }),
    (e) => ({ node, error: e.message }))));
}

/**
 * The block a page pins: `{ genesis }` while the chain is under
 * CHECKPOINT_AFTER blocks (or no node answered), else
 * `{ checkpoint, height }`, a block MARGIN below the lowest answering tip,
 * the hash most of the answering nodes report at that height (ties to the
 * earlier node).
 */
export async function chooseAnchor({ now, chain, genesis, fetchImpl = (...a) => fetch(...a), timeoutMs = 5000 }) {
  const answered = now.filter((n) => n.error === undefined);
  if (!answered.length) return { genesis };
  const lowest = answered.reduce((m, n) => (n.height < m ? n.height : m), answered[0].height);
  if (lowest < CHECKPOINT_AFTER) return { genesis };
  const height = lowest - MARGIN;
  const hashes = await Promise.all(answered.map((n) => getJSON(fetchImpl, n.node, `/api/block/${height}`, chain, timeoutMs).then((b) => b.hash, () => undefined)));
  const votes = new Map();
  for (const hash of hashes) if (typeof hash === "string") votes.set(hash, (votes.get(hash) ?? 0) + 1);
  if (!votes.size) return { genesis };
  const [checkpoint] = [...votes].reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  return { checkpoint, height };
}

/** Why a read with two or more nodes failed `disagree`, from what each node said just before. */
export function disagreeMessage(now) {
  const answered = now.filter((n) => n.error === undefined).map((n) => n.node);
  const silent = now.filter((n) => n.error !== undefined).map((n) => n.node);
  if (!answered.length) return `None of your ${now.length} hosts' nodes answered (${silent.join(", ")}). Try again later.`;
  if (silent.length) return `Only ${answered.length} of ${now.length} hosts answered (${silent.join(", ")} didn't); reads need two to agree. Try again later, or use minAgree: 1 to trust ${answered[0]} alone.`;
  return `All ${now.length} hosts' nodes answered, but no block is held by two of them yet (they are on different tips). Try again in a minute.`;
}

/** How long `blocks` blocks take at `targetBlockTime` milliseconds each, roughly, in words. */
export function blocksTime(blocks, targetBlockTime) {
  const hours = (blocks * Number(targetBlockTime)) / 3_600_000;
  return hours < 48 ? `≈${Math.max(1, Math.round(hours))} hours` : `≈${Math.round(hours / 24)} days`;
}
