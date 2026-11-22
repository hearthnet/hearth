// The "Use it" snippet the web app shows after launch (app/snippet.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { snippet } from "../app/snippet.mjs";

const genesis = "bafyreicbllerm4n3yyknvd7hbwwmwtf27qubbihgp7umj6fzf7cr32zeua";
const use = { sdkURL: "https://cdn.example/sdk@1.2.3/browser.js", chain: "Nexus/testnet/rsvp", anchor: { genesis }, nodes: ["https://host.example", "https://other.example"], sponsors: ["https://a.example/sponsor", "https://b.example/sponsor"] };

test("the snippet is a whole page: it loads the pinned SDK, connects to this chain, writes once and reads it back", () => {
  const page = snippet(use);
  assert.match(page, /^<!doctype html>\n<script type="module">/);
  assert.ok(page.includes('import { connect } from "https://cdn.example/sdk@1.2.3/browser.js";'));
  assert.ok(page.includes('chain: "Nexus/testnet/rsvp"') && page.includes(`genesis: "${genesis}"`));
  assert.ok(page.includes('node: ["https://host.example","https://other.example"]'));
  assert.ok(!/^\s*minAgree/m.test(page), "two or more nodes: the SDK's default of two must agree");
  assert.ok(page.includes("// minAgree: 1,"), "the trade-off is offered, commented out");
  assert.ok(page.includes('sponsors: ["https://a.example/sponsor","https://b.example/sponsor"]'));
  assert.equal(page.match(/db\.set\(/g).length, 1);
  assert.equal(page.match(/db\.get\(/g).length, 1);
  assert.ok(page.trimEnd().endsWith("</script>"));
});

test("with one host's node, the snippet says its reads trust that node", () => {
  const page = snippet({ ...use, nodes: ["https://host.example"] });
  assert.ok(page.includes('node: ["https://host.example"]'));
  assert.ok(page.includes("Reads trust this one node"));
  assert.ok(!snippet(use).includes("Reads trust this one node"));
});

test("a longer chain's snippet pins a recent block, not genesis, and says to refresh it", () => {
  const page = snippet({ ...use, anchor: { checkpoint: "bafyreicheckpoint", height: 4321n } });
  assert.ok(page.includes('checkpoint: "bafyreicheckpoint"') && page.includes("block 4321"));
  assert.ok(!page.includes("genesis:"));
  assert.ok(page.includes("Refresh it when you redeploy"));
});

test("under the own-keys rules the snippet writes a key ending in the writer's address", () => {
  assert.ok(snippet({ ...use, ownKeys: true }).includes("const key = `hello/${db.address}`;"));
  assert.ok(snippet(use).includes("const key = `hello/${Date.now()}`;"));
});

test("a hostile node or sponsor URL can't close the snippet's script or add markup", () => {
  const evil = "https://x.example/</script><script>alert(1)</script>&amp;";
  const page = snippet({ ...use, nodes: [evil], sponsors: [evil], chain: "Nexus/testnet/<b>" });
  assert.equal(page.match(/<\/script>/g).length, 1, "only the snippet's own closing tag");
  assert.equal(page.match(/<script/g).length, 1);
  assert.ok(!/[<>&]/.test(page.slice(page.indexOf("connect({"), page.indexOf("const key"))), "no raw < > & in the values");
  // The escapes read back as the same strings.
  const json = page.slice(page.indexOf("node: ") + 6, page.indexOf(",\n", page.indexOf("node: ")));
  assert.deepEqual(JSON.parse(json), [evil]);
});
