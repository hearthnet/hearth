// Launching an owed chain on the seller's node from the genesis its order
// carries: the node stores the genesis's Volumes and policy modules as
// operator pins, then takes the genesis block with its child-only proofs as
// a header synced from a peer would carry them (`POST /child-blocks`).
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 * already list `path` (the seller's fragment) or it refuses the block. With
 * `pinned` (`launchPins`), it first records the CIDs the node does not pin
 * yet: what `unpin` may later take down.
 */
export async function launch({ rpc, path, genesis, pinned }) {
  if (pinned) {
    // Recorded before it pins, and only what the node did not pin already (its sponsor's, say).
    const { body } = await rpc("/pins");
    pinned.add(genesisPins(genesis).filter((cid) => !(body.pins ?? []).includes(cid)));
  }
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

/** Where a seller keeps what its launches pinned for `market`: one file per market, beside its key. */
export const launchPinsFile = (dir, market) => join(dir, `launch-pins-${market.replaceAll("/", "_")}.json`);

/**
 * The CIDs this seller's launches pinned, kept in `file` (a JSON list of
 * CIDs, written whole by rename). A file that is not one is said (`warn`)
 * and read as empty.
 */
export function launchPins(file, warn = console.warn) {
  let cids = [];
  try {
    const read = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(read) && read.every((c) => typeof c === "string")) cids = read;
    else warn(`${file} is not a list of CIDs: read as empty`);
  } catch (e) { if (e.code !== "ENOENT") warn(`${file} could not be read (${e.message}): read as empty`); }
  const set = new Set(cids);
  const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify([...set].sort())); renameSync(`${file}.tmp`, file); };
  return { has: (cid) => set.has(cid), add(more) { for (const c of more) set.add(c); save(); }, delete(cid) { set.delete(cid); save(); } };
}

/** What launching `genesis` pins: each Volume and each module. */
export const genesisPins = (genesis) => [...new Set([...Object.keys(genesis.volumes), ...Object.keys(genesis.modules)])];

/**
 * Unpins each of `released` (as `judgeOwn` lists them) that this seller's
 * launches pinned (`pinned`, `launchPins`) and the node still pins (`GET
 * /pins`, then `DELETE /pins/<cid>`). Returns those it unpinned.
 */
export async function unpin({ rpc, released, pinned }) {
  const mine = released.filter((cid) => pinned.has(cid));
  if (!mine.length) return [];
  const { body } = await rpc("/pins");
  const gone = mine.filter((cid) => (body.pins ?? []).includes(cid));
  for (const cid of gone) { await rpc(`/pins/${cid}`, undefined, "DELETE"); pinned.delete(cid); }
  return gone;
}
