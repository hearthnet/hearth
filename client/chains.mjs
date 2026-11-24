// Reading chains a node may not host: the specs above an ordered path come
// from the home node when it serves the chain, else from the fastest node
// the network declares for it (`/api/chain/endpoints`, through the SDK's
// EndpointResolver). The web app and the seller read them the same way, so
// both price an order the same.
import { reader } from "./market.mjs";
import { pathFromNexus } from "./records.mjs";

/** How long a spec read from a node other than the home one is kept. */
export const REMOTE_SPEC_MS = 10 * 60_000;

/** Nodes for `chainPath` that `entry`'s network declares: `[{ url, declaresSubmit }]`, none on failure. */
export async function declaredNodes(sdk, entry, chainPath, fetchImpl = (...a) => fetch(...a)) {
  try {
    return await new sdk.EndpointResolver(new sdk.NodeClient(entry, ["Nexus"], { fetch: fetchImpl }), { fetch: fetchImpl }).resolve(chainPath.split("/"), AbortSignal.timeout(10_000));
  } catch { return []; }
}

/**
 * Readers over `home` (a `reader`), finding other nodes through `entry`
 * (default the home node). The home node is read with its reader's fetch
 * (which may carry its credential), every other node with `fetchImpl`.
 */
export function chainReaders(sdk, home, { entry = home.node, fetchImpl: others = (...a) => fetch(...a) } = {}) {
  const fetchImpl = (input, init) => (new URL(input).origin === new URL(home.node).origin ? home.fetch : others)(input, init);
  /** A reader of `chainPath`: the home node when it serves the chain, else the fastest node `entry` lists for it. */
  const readers = new Map();
  async function readerOf(chainPath) {
    if (readers.has(chainPath)) return readers.get(chainPath);
    const path = chainPath.split("/");
    let found;
    try { await home.api("/api/chain/info", chainPath); found = home; } catch {}
    if (!found) {
      const hosts = await declaredNodes(sdk, entry, chainPath, fetchImpl);
      try { found = reader(sdk, await Promise.any(hosts.map(async ({ url }) => { await new sdk.NodeClient(url, path, { fetch: fetchImpl }).chainInfo(AbortSignal.timeout(5_000)); return url; })), { fetchImpl }); }
      catch { throw new Error(`No node found that serves ${chainPath}. Try again, or give ?node= a node that serves it and the market.`); }
    }
    readers.set(chainPath, found);
    return found;
  }

  /**
   * A chain's spec, read from its tip by CID: the home node's kept once
   * read; one read from another node (trusted, not checked) kept for at
   * most REMOTE_SPEC_MS, then read again, through a node found again.
   */
  const specs = new Map();  // path → { read, until }
  function specOf(chainPath) {
    if (!(specs.get(chainPath)?.until > Date.now())) {
      const entry = { until: Infinity };
      entry.read = (async () => {
        const own = await home.spec(chainPath);
        if (own) return own;
        if (readers.get(chainPath) !== home) readers.delete(chainPath);
        entry.until = Date.now() + REMOTE_SPEC_MS;
        return (await readerOf(chainPath)).spec(chainPath);
      })();
      specs.set(chainPath, entry);
      const drop = () => { if (specs.get(chainPath) === entry) specs.delete(chainPath); };
      entry.read.then((s) => { if (!s) drop(); }, drop);
    }
    return specs.get(chainPath).read.catch(() => undefined);
  }

  /** `Map(path → spec)` of every chain from Nexus down to each of `paths`, those that could be read. */
  async function specsDownTo(paths) {
    const all = [...new Set(paths.flatMap(pathFromNexus))];
    const read = await Promise.all(all.map(specOf));
    return new Map(all.map((p, i) => [p, read[i]]).filter(([, s]) => s));
  }

  return { readerOf, specOf, specsDownTo };
}
