// The genesis the web app mints for a buyer's chain (app/genesis.mjs), with
// the vendored builder (vendor/lattice-genesis.wasm), and the order value
// that carries it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { loadGenesis } from "../vendor/lattice-genesis.js";
import { base64, chainSpec, mintGenesis } from "../app/genesis.mjs";
import { moduleCID, parseGenesis, parseOrderValue } from "../client/records.mjs";

const { buildChildGenesis } = await loadGenesis(readFileSync(new URL("../vendor/lattice-genesis.wasm", import.meta.url)));
const BUYER = sdk.accountFromPrivateKey(new Uint8Array(32).fill(1)).address;
const PARENT_STATE = "bafyreidrzde55u53grvbfs4woibgygtrex3blzdre4ibqkwlorv7x346ke";
const RULES = readFileSync(new URL("../app/rules/write_once.wasm", import.meta.url)).toString("base64");
const CID = moduleCID(sdk, RULES);
const spec = chainSpec({ maxBlockSize: 20000, targetBlockTime: 30000, maxStateGrowth: 10000, maxNumberOfTransactionsPerBlock: 100, premineCoin: 21000, moduleCIDs: [CID] });
const mint = (build) => mintGenesis(build, { spec, path: "Nexus/testnet/my-app", premineTo: BUYER, modules: { [CID]: RULES }, parentStateCID: PARENT_STATE, timestamp: 1_800_000_000_000 });

test("a spec rounds the premine up to whole block rewards and names each module once as a transaction policy", () => {
  assert.equal(spec.premine, 210);
  assert.deepEqual(spec.wasmPolicies, [{ moduleCID: CID, abiVersion: 1, scope: "transaction", entrypoint: "lattice_validate_transaction" }]);
});

test("the order carries the minted genesis, which checks out against its CIDs, spec, modules and proof", () => {
  const { cid, value } = mint(buildChildGenesis);
  const parsed = parseOrderValue(value);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.proofs.length, 1, "the genesis's child-only proof");
  const g = parseGenesis(sdk, parsed, "Nexus/testnet/my-app");
  assert.equal(g.error, undefined);
  assert.equal(g.cid, cid);
  assert.equal(BigInt(g.spec.maxBlockSize), 20000n);
  assert.equal(mint(buildChildGenesis).cid, cid, "the same inputs make the same genesis");
});

test("without a proof of the genesis's work, minting fails before anything is paid", () => {
  assert.throws(() => mint((input) => ({ ...buildChildGenesis(input), proofs: undefined })), /no proof of the genesis's work/);
});

test("base64 of more bytes than one spread takes", () => {
  const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
  assert.equal(base64(bytes), Buffer.from(bytes).toString("base64"));
});
