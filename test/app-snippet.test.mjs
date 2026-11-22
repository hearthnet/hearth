// The "Use it" snippet the web app shows after launch (app/snippet.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { snippet } from "../app/snippet.mjs";

const use = { sdkURL: "https://cdn.example/sdk@1.2.3/browser.js", chain: "Nexus/testnet/rsvp", node: "https://host.example", sponsors: ["https://a.example/sponsor", "https://b.example/sponsor"] };

test("the snippet is a whole page: it loads the pinned SDK, connects to this chain, writes once and reads it back", () => {
  const page = snippet(use);
  assert.match(page, /^<!doctype html>\n<script type="module">/);
  assert.ok(page.includes('import { connect } from "https://cdn.example/sdk@1.2.3/browser.js";'));
  assert.ok(page.includes('chain: "Nexus/testnet/rsvp"') && page.includes('node: "https://host.example"'));
  assert.ok(page.includes('sponsors: ["https://a.example/sponsor","https://b.example/sponsor"]'));
  assert.equal(page.match(/db\.set\(/g).length, 1);
  assert.equal(page.match(/db\.get\(/g).length, 1);
  assert.ok(page.trimEnd().endsWith("</script>"));
});

test("under the own-keys rules the snippet writes a key ending in the writer's address", () => {
  assert.ok(snippet({ ...use, ownKeys: true }).includes("const key = `hello/${db.address}`;"));
  assert.ok(snippet(use).includes("const key = `hello/${Date.now()}`;"));
});

test("a hostile node or sponsor URL can't close the snippet's script or add markup", () => {
  const evil = "https://x.example/</script><script>alert(1)</script>&amp;";
  const page = snippet({ ...use, node: evil, sponsors: [evil], chain: "Nexus/testnet/<b>" });
  assert.equal(page.match(/<\/script>/g).length, 1, "only the snippet's own closing tag");
  assert.equal(page.match(/<script/g).length, 1);
  assert.ok(!/[<>&]/.test(page.slice(page.indexOf("connect({"), page.indexOf("const key"))), "no raw < > & in the values");
  // The escapes read back as the same strings.
  const json = page.slice(page.indexOf("node: ") + 6, page.indexOf(",\n", page.indexOf("node: ")));
  assert.equal(JSON.parse(json), evil);
});
