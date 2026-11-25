// Genesis blocks as the web app mints them (app/genesis.mjs, with the
// vendored builder), each with its child-only proof for its path: what an
// order carries. `respec` swaps in another spec, as only an attacker would.
import { readFileSync } from "node:fs";
import * as sdk from "../vendor/lattice-sdk.js";
import { loadGenesis } from "../vendor/lattice-genesis.js";
import { base64, chainSpec, mintGenesis } from "../app/genesis.mjs";
import { formatOrderValue, moduleCID, parseOrderValue } from "../client/records.mjs";

const { buildChildGenesis } = await loadGenesis(readFileSync(new URL("../vendor/lattice-genesis.wasm", import.meta.url)));
export const MODULE = readFileSync(new URL("../chain/policy-v31.wasm", import.meta.url)).toString("base64");
export const MODULE_CID = moduleCID(sdk, MODULE);
/** 1 MB blocks every 60 s, 1 MB state growth. */
export const SIZES = { maxBlockSize: 1000000, targetBlockTime: 60000, maxStateGrowth: 1000000, maxNumberOfTransactionsPerBlock: 1000 };
const PARENT_STATE = "bafyreidrzde55u53grvbfs4woibgygtrex3blzdre4ibqkwlorv7x346ke";

/** `{ cid, value }`: the genesis of `path` and the order value carrying it, with the policy-v31 module. */
export function mint(path, { timestamp = 1_800_000_000_000, ...sizes } = {}) {
  const spec = chainSpec({ ...SIZES, ...sizes, moduleCIDs: [MODULE_CID] });
  return mintGenesis(buildChildGenesis, { spec, path, premineTo: null, modules: { [MODULE_CID]: MODULE }, parentStateCID: PARENT_STATE, timestamp });
}

/** The order value of `value`'s genesis with its spec replaced by `spec` (any dag-cbor), no modules: a block nobody mined. */
export function respec(value, spec) {
  const v = parseOrderValue(value);
  const volume = sdk.decodeVolumeArchive(v.genesis, Buffer.from(v.volumes[v.genesis], "base64"));
  const block = sdk.decodeDagCbor(volume.entries.find((e) => e.cid === v.genesis).bytes);
  const specBytes = sdk.encodeDagCbor(spec), specCID = sdk.cidV1DagCbor(specBytes);
  const blockBytes = sdk.encodeDagCbor({ ...block, spec: { rawCID: specCID } }), cid = sdk.cidV1DagCbor(blockBytes);
  const archive = (rootCID, entries) => base64(sdk.encodeVolumeArchive({ rootCID, entries }));
  const entries = [...volume.entries.filter((e) => e.cid !== v.genesis), { cid, bytes: blockBytes }];
  const { [v.genesis]: _, [block.spec.rawCID]: __, ...others } = v.volumes;
  return formatOrderValue({ genesis: cid, volumes: { ...others, [cid]: archive(cid, entries), [specCID]: archive(specCID, [{ cid: specCID, bytes: specBytes }]) }, modules: {}, proofs: v.proofs });
}
