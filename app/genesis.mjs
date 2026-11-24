// The buyer's chain, minted in this browser: its spec from what the buyer
// chose, and its genesis built by vendor/lattice-genesis.js exactly as a node
// builds it. The order carries the genesis (client/records.mjs,
// `formatOrderValue`), so a host runs the chain the buyer made.
import { formatOrderValue } from "../client/records.mjs";

/** Coin each block pays whoever makes it. */
export const BLOCK_REWARD = 100;

/** Bytes as base64, in slices (a large spread overflows the stack). */
export function base64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * A ChainSpec, numbers as the genesis builder reads them (plain JSON
 * numbers): blocks of `maxBlockSize` bytes every `targetBlockTime` ms, at
 * most `maxStateGrowth` bytes of new state a block, `premineCoin` (rounded
 * up to whole block rewards) to the buyer, and one transaction policy per
 * module CID.
 */
export function chainSpec({ maxBlockSize, targetBlockTime, maxStateGrowth, maxNumberOfTransactionsPerBlock, premineCoin = 0, moduleCIDs = [] }) {
  return {
    maxNumberOfTransactionsPerBlock, maxStateGrowth, maxBlockSize,
    premine: Math.ceil(premineCoin / BLOCK_REWARD), targetBlockTime,
    initialReward: BLOCK_REWARD, halvingInterval: 1000000, halfLife: 100,
    wasmPolicies: moduleCIDs.map((moduleCID) => ({ moduleCID, abiVersion: 1, scope: "transaction", entrypoint: "lattice_validate_transaction" })),
  };
}

/**
 * The genesis of `path` on top of the parent's state `parentStateCID`, and
 * the order value that carries it: `{ cid, value }`. `build` is
 * `buildChildGenesis` (vendor/lattice-genesis.js); `modules` the policy
 * modules by CID, base64. Throws when the builder gives no proof of the
 * genesis's work: a host cannot start the chain without one.
 */
export function mintGenesis(build, { spec, path, premineTo, modules = {}, parentStateCID, timestamp = Date.now() }) {
  const out = build({ spec, chainPath: path, premineTo: spec.premine > 0 ? premineTo : null, genesisTransactions: [], parentStateCID, timestamp });
  if (!Array.isArray(out.proofs) || out.proofs.length === 0) {
    throw new Error("This page's genesis builder made no proof of the genesis's work (vendor/lattice-genesis.js returned no proofs), so a host could not start the chain. Nothing was paid; reload the page for a newer builder.");
  }
  const volumes = Object.fromEntries(Object.entries(out.volumes).map(([cid, bytes]) => [cid, base64(bytes)]));
  const proofs = out.proofs.map((p) => (typeof p === "string" ? p : base64(p)));
  return { cid: out.cid, value: formatOrderValue({ genesis: out.cid, volumes, modules, proofs }) };
}
