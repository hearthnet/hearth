// Reading chains a node may not host: from the home node when it serves the
// chain, else from the fastest node the network declares for it
// (`/api/chain/endpoints`, through the SDK's EndpointResolver).
import { reader } from "./market.mjs";

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

  return { readerOf };
}
