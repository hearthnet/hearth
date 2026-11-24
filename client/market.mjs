// Reading the market from any node that hosts it. Every record is read by
// CID from a block the node names (state.mjs), so a node can withhold or
// serve an old tip, but cannot forge a record.
import { get, list, volumeLoader } from "./state.mjs";
import { offerKey, parseOfferKey, parseOrderKey } from "./records.mjs";

/** Where receipt state keeps a receipt: a domain-separated SHA-256 of its key, in hex. */
export async function receiptStorageKey(key) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`lattice/receipt-state/v1\u0000${key}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The most blocks a reader keeps what `recentBlocks` read of. */
const BLOCK_FACTS = 5000;

/** A reader over one node: `node` is its public read URL. */
export function reader(sdk, node, { fetchImpl = (...a) => fetch(...a), cache } = {}) {
  const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(new URL("/volumes/", node).toString(), { fetch: fetchImpl }), undefined, cache ? { cache } : {});
  const load = volumeLoader(volumes, sdk.decodeDagCbor);
  const api = async (path, chainPath) => {
    const url = new URL(path, node);
    if (chainPath) url.searchParams.set("chainPath", chainPath);
    const response = await fetchImpl(url, { cache: "no-store" });
    if (!response.ok) throw Object.assign(new Error(`${url.pathname}: HTTP ${response.status}`), { status: response.status });
    return response.json();
  };

  /** Whether `parentPath` has committed a child directory named `directory` (every page of /api/chain/children). */
  const hasChild = async (parentPath, directory) => {
    for (let after; ;) {
      const page = await api(`/api/chain/children?limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`, parentPath);
      if ((page.directories ?? []).includes(directory)) return true;
      if (!page.next) return false;
      after = page.next;
    }
  };

  /** The node's tip of `chainPath`: its hash, height, spec and state roots, read by CID. */
  async function tip(chainPath) {
    const { hash } = await api("/api/block/latest", chainPath);
    return block(hash);
  }

  async function block(hash) {
    const volume = await volumes.get(hash);
    const decoded = sdk.decodeCanonicalBlock(volume.rootBytes());
    const state = sdk.decodeCanonicalLatticeState((await volumes.get(decoded.postStateCID)).rootBytes());
    return { hash, height: decoded.height, specCID: decoded.specCID, block: decoded, volume, state };
  }

  const blockFacts = new Map();  // block hash → what recentBlocks reads of it (a block never changes)

  const entries = async (root, prefix) => {
    const out = [];
    for await (const entry of list(load, root, prefix)) out.push(entry);
    return out;
  };

  const stateAt = async (chainPath, height) => (await block((await api(`/api/block/${height}`, chainPath)).hash)).state.generalStateCID;
  const landings = new Map();  // order key → { landed, terms }: an order is written once and never deleted
  /**
   * Where an order landed: the lowest market height whose state holds its
   * key (bisected: a key is written once and never removed), and the
   * offer's text in that block.
   */
  async function landing(chainPath, key, ref, height) {
    if (landings.has(key)) return landings.get(key);
    let lo = 0n, hi = height;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if (await get(load, await stateAt(chainPath, mid), key) !== undefined) hi = mid; else lo = mid + 1n;
    }
    const found = { landed: lo, terms: await get(load, await stateAt(chainPath, lo), offerKey(ref.host, ref.id)) };
    landings.set(key, found);
    return found;
  }

  return {
    node, volumes, api, hasChild, tip, block,

    /**
     * Offers and orders at the tip of the market chain. `offers` maps
     * `<host>/<id>` to the offer's text now: the terms an order placed now
     * asserts. `orders` (renewals among them, their value RENEW) each carry
     * `landed`, the market height it landed at, and `terms`, the offer's
     * text in that block: what `judge` reads.
     */
    async market(chainPath) {
      const t = await tip(chainPath);
      const root = t.state.generalStateCID;
      const [offerEntries, orderEntries] = await Promise.all(["offer/", "order/"].map((p) => entries(root, p)));
      const offers = new Map();
      for (const [key, value] of offerEntries) {
        const ref = parseOfferKey(key);
        if (ref) offers.set(`${ref.host}/${ref.id}`, value);
      }
      const orders = [];
      for (const [key, value] of orderEntries) {
        const ref = parseOrderKey(key);
        if (!ref) continue;
        const { landed, terms } = await landing(chainPath, key, ref, t.height);
        orders.push({ key, ...ref, value, landed, terms });
      }
      return { height: t.height, hash: t.hash, offers, orders };
    },

    /** The spec `chainPath` runs, from its tip block by CID, or undefined when the node holds no such chain. */
    async spec(chainPath) {
      let t;
      try { t = await tip(chainPath); } catch (e) { if (e.status === 404 || e.status === 400) return undefined; throw e; }
      return (await load(t.block.specCID, t.volume)).node;
    },

    /** `Map(path → spec)` for every chain above each of `paths`, those this node holds. */
    async specsAbove(paths) {
      const above = new Set(paths.flatMap((p) => p.split("/").slice(0, -1).map((_, i, s) => s.slice(0, i + 1).join("/"))));
      const out = new Map();
      await Promise.all([...above].map(async (p) => { const spec = await this.spec(p); if (spec) out.set(p, spec); }));
      return out;
    },

    /**
     * Open deposits on `chainPath`: coin locked there for a payment on its
     * parent. A bounded read: at most `limit` entries of deposit state (spent
     * ones, kept as a zero marker, count too), in key order, of the keys
     * starting with `prefix` (`<demander>/` reads one seller's). The array's
     * `complete` is false when it stopped at `limit`.
     */
    async deposits(chainPath, { prefix = "", limit = 1000 } = {}) {
      const t = await tip(chainPath);
      const out = [];
      out.complete = true;
      let read = 0;
      for await (const [key, value] of list(load, t.state.depositStateCID, prefix)) {
        if (read++ >= limit) { out.complete = false; break; }
        const [demander, amountDemanded, nonce] = key.split("/");
        const amountDeposited = BigInt(value);
        if (amountDeposited > 0n) out.push({ demander, amountDemanded: BigInt(amountDemanded), nonce: BigInt(nonce), amountDeposited, key });
      }
      return out;
    },

    /** Whether a deposit is still open (its amount) on `chainPath`: 0n once withdrawn, undefined if absent. */
    async deposit(chainPath, d) {
      const t = await tip(chainPath);
      const value = await get(load, t.state.depositStateCID, `${d.demander}/${d.amountDemanded}/${d.nonce}`);
      return value === undefined ? undefined : BigInt(value);
    },

    /** The withdrawer the parent's receipt for a deposit records, or undefined. */
    async receipt(parentPath, directory, d) {
      const t = await tip(parentPath);
      return get(load, t.state.receiptStateCID, await receiptStorageKey(`${directory}/${d.demander}/${d.amountDemanded}/${d.nonce}`));
    },

    /** An account's balance and nonce on `chainPath`, as the node reports them. */
    async account(chainPath, address) {
      const a = await api(`/api/state/account/${address}`, chainPath);
      return { balance: BigInt(a.balance ?? 0), nonce: BigInt(a.nonce ?? 0) };
    },

    /**
     * `chainPath`'s newest blocks back to `since` (ms), at most `max` of
     * them, each `{ hash, height, target, rewardRecipient, timestamp }`: from
     * the tip the node names, each block read by its CID and the next by the
     * parent it links (a node can serve an old tip, but cannot forge a block
     * or a link). It stops after the first block `stop(block)` is true of.
     * `pages` (blocks / 25) is kept for older callers. The array's
     * `complete` is false when it stopped at `max` before reaching `since`
     * (or genesis, or a `stop` block): a capped read, which says nothing of
     * the blocks before it.
     */
    async recentBlocks(chainPath, { since = 0, max = 100, pages, stop = () => false } = {}) {
      const limit = pages === undefined ? max : Math.min(max, pages * 25);
      const out = [];
      out.complete = true;
      let { hash } = await api("/api/block/latest", chainPath);
      for (;;) {
        if (!hash) break;
        if (out.length >= limit) { out.complete = false; break; }
        if (!blockFacts.has(hash)) {
          const b = sdk.decodeCanonicalBlock((await volumes.get(hash)).rootBytes());
          // Bounded: past BLOCK_FACTS entries, the oldest read goes.
          if (blockFacts.size >= BLOCK_FACTS) blockFacts.delete(blockFacts.keys().next().value);
          blockFacts.set(hash, { hash, height: b.height, target: b.target, rewardRecipient: b.rewardRecipient, timestamp: Number(b.timestamp), parent: b.parentCID });
        }
        const { parent, ...facts } = blockFacts.get(hash);
        if (facts.timestamp <= since) break;
        out.push(facts);
        if (stop(facts)) break;
        hash = parent;
      }
      return out;
    },

  };
}

/**
 * Whether the node at `readURL` itself holds the Volume `root`: its public
 * `GET /volumes?cids=` answers only what the node holds, never reading from
 * peers, and the archive must decode to `root`.
 */
export async function holdsVolume(sdk, readURL, root, fetchImpl = (...a) => fetch(...a)) {
  const response = await fetchImpl(`${readURL.replace(/\/$/, "")}/volumes?cids=${root}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const record = sdk.decodeVolumeRecords(new Uint8Array(await response.arrayBuffer())).find((r) => r.rootCID === root);
  if (!record) return false;
  sdk.decodeVolumeArchive(root, record.archive);
  return true;
}
