// The devnet market's chain: chain/spec.json running chain/policy.wasm,
// named by that module's own CID (chain/market.json holds the market's).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "../vendor/lattice-sdk.js";
import { moduleCID } from "../client/records.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const POLICY = join(ROOT, "chain/policy.wasm");
export const SPEC = join(ROOT, "chain/spec.json");

/** chain/policy.wasm's module CID. */
export const policyCID = () => moduleCID(sdk, readFileSync(POLICY).toString("base64"));

/**
 * `lattice child create <market>`'s arguments after the path: chain/spec.json
 * with `overrides` (e.g. `targetBlockTime`), written into `dir`, its policy
 * module, and the premine's account.
 */
export function marketArgs({ dir, premineTo, overrides = {} }) {
  const spec = JSON.parse(readFileSync(SPEC, "utf8"));
  if (spec.wasmPolicies.some((p) => p.moduleCID !== policyCID())) throw new Error("chain/spec.json does not name chain/policy.wasm's CID");
  const file = join(dir, "market-spec.json");
  writeFileSync(file, JSON.stringify({ ...spec, ...overrides }));
  return ["--spec", file, "--policy-module", POLICY, "--premine-to", premineTo];
}
