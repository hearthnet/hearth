// Which writes a chain accepts under each of the web app's rule presets
// (app/rules, built by app/rules/build.sh), run through the same context and
// entrypoint the Lattice host uses (policy/test/host.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { context, validate } from "../policy/test/host.mjs";
import { accountFromPrivateKey, encodeTransactionBody } from "../vendor/lattice-sdk.js";

const load = (name) => new WebAssembly.Module(readFileSync(new URL(`../app/rules/${name}.wasm`, import.meta.url)));
const ownKeys = load("own_keys"), writeOnce = load("write_once");
const PATH = ["Nexus", "testnet", "my-app"];

function accepts(module, actions, signers) {
  const { bytes } = encodeTransactionBody({ accountActions: [], actions, depositActions: [], receiptActions: [], withdrawalActions: [], signers, nonce: 1n, chainPath: PATH });
  return validate(context(bytes, { path: PATH }), module);
}

const ALICE = accountFromPrivateKey(new Uint8Array(32).fill(1)).address;
const BOB = accountFromPrivateKey(new Uint8Array(32).fill(2)).address;
const SPONSOR = accountFromPrivateKey(new Uint8Array(32).fill(3)).address;

test("own keys: a person writes, changes and deletes only keys ending in their address", () => {
  assert.ok(accepts(ownKeys, [{ key: `events/1/${ALICE}`, newValue: "Street cleanup" }], [ALICE]));
  assert.ok(accepts(ownKeys, [{ key: ALICE, newValue: "profile" }], [ALICE]));
  assert.ok(accepts(ownKeys, [{ key: `rsvp/${BOB}/1/${ALICE}`, oldValue: "yes", newValue: "no" }], [ALICE]), "an address earlier in the key does not own it");
  assert.ok(accepts(ownKeys, [{ key: `events/1/${ALICE}`, oldValue: "x" }], [ALICE]));
  assert.ok(!accepts(ownKeys, [{ key: `events/1/${BOB}`, newValue: "not mine" }], [ALICE]));
  assert.ok(!accepts(ownKeys, [{ key: `events/1/${BOB}`, oldValue: "x", newValue: "y" }], [ALICE]));
  assert.ok(!accepts(ownKeys, [{ key: `a/${ALICE}`, newValue: "1" }, { key: `b/${BOB}`, newValue: "2" }], [ALICE]), "one bad write refuses the transaction");
  assert.ok(!accepts(ownKeys, [{ key: "events/1", newValue: "no owner" }], [ALICE]));
  assert.ok(!accepts(ownKeys, [{ key: `${ALICE}/events/1`, newValue: "owner first" }], [ALICE]));
  assert.ok(!accepts(ownKeys, [{ key: `events${ALICE}`, newValue: "no separator" }], [ALICE]), "the address must be a whole segment");
});

test("own keys: a fee sponsor's co-signature lends it nothing", () => {
  // A sponsored write: the writer signs first, the sponsor after it.
  assert.ok(accepts(ownKeys, [{ key: `events/1/${ALICE}`, newValue: "paid in work" }], [ALICE, SPONSOR]));
  assert.ok(!accepts(ownKeys, [{ key: `events/1/${SPONSOR}`, newValue: "the sponsor's key" }], [ALICE, SPONSOR]));
  assert.ok(!accepts(ownKeys, [{ key: `a/${ALICE}`, newValue: "1" }, { key: `b/${BOB}`, newValue: "2" }], [ALICE, BOB]), "only the first signer's keys");
});

test("own keys: a transaction that writes nothing passes", () => {
  assert.ok(accepts(ownKeys, [], [ALICE]));
});

test("write once: anyone creates a key; nobody changes or deletes it", () => {
  assert.ok(accepts(writeOnce, [{ key: "guestbook/1", newValue: "hi" }], [ALICE]));
  assert.ok(accepts(writeOnce, [{ key: "guestbook/2", newValue: "hello" }, { key: "guestbook/3", newValue: "hey" }], [BOB]));
  assert.ok(!accepts(writeOnce, [{ key: "guestbook/1", oldValue: "hi", newValue: "edited" }], [ALICE]));
  assert.ok(!accepts(writeOnce, [{ key: "guestbook/1", oldValue: "hi" }], [ALICE]));
  assert.ok(!accepts(writeOnce, [{ key: "guestbook/4", newValue: "ok" }, { key: "guestbook/1", oldValue: "hi", newValue: "x" }], [ALICE]));
});
