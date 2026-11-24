// Launching an owed chain on the seller's node from the genesis its order
// carries: the node stores the genesis's Volumes and policy modules as
// operator pins, then takes the genesis block with its child-only proofs as
// a header synced from a peer would carry them (`POST /child-blocks`).
import * as sdk from "../vendor/lattice-sdk.js";

const base64 = (bytes) => Buffer.from(bytes).toString("base64");

/**
 * Hands the node at `rpc` (`rpc(route, body)`, the operator API as
 * `operatorRPC` makes it) the genesis of `path`: `genesis` is
 * `{ cid, volumes, modules, proofs }` as an owed order carries it
 * (`judgeOwn`). Every Volume and module is pinned (`POST /pins`, again
 * each time: a pin of what the node holds changes nothing), then the block
 * is submitted. Returns the node's status for it: `tree` once the node
 * weighs it; anything else, the caller tries again next pass. The node must
 * already list `path` (the seller's fragment) or it refuses the block.
 */
export async function launch({ rpc, path, genesis }) {
  const volumes = Object.entries(genesis.volumes).map(([cid, archive]) => sdk.decodeVolumeArchive(cid, Buffer.from(archive, "base64")));
  for (const v of volumes) await rpc("/pins", { cid: v.rootCID, entries: Object.fromEntries(v.entries.map((e) => [e.cid, base64(e.bytes)])) });
  for (const [cid, module] of Object.entries(genesis.modules)) {
    if (!Object.hasOwn(genesis.volumes, cid)) await rpc("/pins", { cid, entries: { [cid]: base64(sdk.encodeDagCbor({ bytes: module })) } });
  }
  const entry = (cid, what) => {
    const bytes = volumes.flatMap((v) => v.entries).find((e) => e.cid === cid)?.bytes;
    if (!bytes) throw new Error(`the genesis of ${path} carries no ${what} (${cid})`);
    return bytes;
  };
  const blockBytes = entry(genesis.cid, "block");
  const block = sdk.decodeCanonicalBlock(blockBytes);
  const { body } = await rpc("/child-blocks", {
    chainPath: path.split("/"),
    block: base64(blockBytes),
    children: base64(entry(block.childrenCID, "child index")),
    spec: base64(entry(block.specCID, "spec")),
    proofs: genesis.proofs,
  });
  return body.status;
}

/**
 * Unpins each of `released` (as `judgeOwn` lists them) that the node still
 * pins (`GET /pins`, then `DELETE /pins/<cid>`). Returns those it unpinned.
 */
export async function unpin({ rpc, released }) {
  if (!released.length) return [];
  const { body } = await rpc("/pins");
  const gone = released.filter((cid) => (body.pins ?? []).includes(cid));
  for (const cid of gone) await rpc(`/pins/${cid}`, undefined, "DELETE");
  return gone;
}
