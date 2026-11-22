// Reading the market from any node that hosts it. Every record is read by
// CID from a block the node names (state.mjs), so a node can withhold or
// serve an old tip, but cannot forge a record.
import { get, list, volumeLoader } from "./state.mjs";
import { RENEW, inForce, offerText, parseOfferKey, parseOrderKey } from "./records.mjs";
import { genesisFacts } from "./verdict.mjs";

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

  return {
    node, volumes, api, hasChild, tip, block,

    /**
     * Offers, urls, orders and renewals at the tip of the market chain.
     * `urls` maps each host to its read URL; `urlValues` to its url record as
     * written (`parseHostURL` reads it).
     * `versions` maps `<host>/<id>` to every version's text (the text
     * `parseOffer` or `parseStorageOffer` takes), oldest first: what
     * `judge` reads. `offers` maps it to the version in force at the tip
     * (`inForce` in records.mjs: written at least CREATED_WINDOW blocks
     * ago), the terms an order placed now goes by; an offer whose every
     * version is newer than that is in `versions` only.
     * `orders` are the ones carrying a payload, `renewals` the ones paying
     * for more time.
     */
    async market(chainPath) {
      const t = await tip(chainPath);
      const root = t.state.generalStateCID;
      const [offerEntries, urls, orderEntries] = await Promise.all(["offer/", "url/", "order/"].map((p) => entries(root, p)));
      const versions = new Map();
      for (const [key, value] of offerEntries) {
        const ref = parseOfferKey(key);
        if (!ref) continue;
        const id = `${ref.host}/${ref.id}`;
        versions.set(id, [...(versions.get(id) ?? []), [ref.created, offerText(ref.created, value)]]);
      }
      const orders = [], renewals = [];
      for (const [key, value] of orderEntries) {
        const ref = parseOrderKey(key);
        if (!ref) continue;
        if (value === RENEW) renewals.push({ key, ...ref });
        else orders.push({ key, ...ref, buyer: ref.payer, payloadText: value });
      }
      for (const [id, list] of versions) versions.set(id, list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, text]) => text));
      const offers = new Map([...versions].flatMap(([id, texts]) => { const text = inForce(texts, t.height); return text === undefined ? [] : [[id, text]]; }));
      return { height: t.height, hash: t.hash, offers, versions,
        urls: new Map(urls.map(([key, value]) => [key.slice("url/".length), value.split("\n")[0]])),
        urlValues: new Map(urls.map(([key, value]) => [key.slice("url/".length), value])), orders, renewals };
    },

    /** Open deposits on `chainPath`: coin locked there for a payment on its parent. */
    async deposits(chainPath) {
      const t = await tip(chainPath);
      return (await entries(t.state.depositStateCID, "")).flatMap(([key, value]) => {
        const [demander, amountDemanded, nonce] = key.split("/");
        const amountDeposited = BigInt(value);
        return amountDeposited > 0n ? [{ demander, amountDemanded: BigInt(amountDemanded), nonce: BigInt(nonce), amountDeposited, key }] : [];
      });
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

    /** How `chainPath`'s genesis was built, or undefined when the node holds no such chain. */
    async genesis(chainPath) {
      let hash;
      try { ({ hash } = await api("/api/block/0", chainPath)); } catch (e) { if (e.status === 404 || e.status === 400) return undefined; throw e; }
      const blockVolume = await volumes.get(hash);
      const decoded = sdk.decodeCanonicalBlock(blockVolume.rootBytes());
      if (decoded.height !== 0n || decoded.parentCID !== undefined) throw new Error("not a genesis block");
      const within = (cid, volume) => load(cid, volume ?? blockVolume);
      const transactions = [];
      for await (const [, signed] of list(within, decoded.transactionsCID)) {
        const transaction = await within(signed.rawCID);
        const { node: body } = await within(transaction.node.body.rawCID, transaction.volume);
        const isSigned = transaction.node.signatures.length > 0 || body.signers.length > 0;
        transactions.push({ cid: signed.rawCID, signed: isSigned, credited: body.accountActions.filter((a) => BigInt(a.delta) > 0n).map((a) => a.owner) });
      }
      return { hash, ...genesisFacts(decoded, transactions) };
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
