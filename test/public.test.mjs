// hearth sell --public: the proxy buyers reach through the tunnel, the tunnel's URL, and cloudflared's install.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startProxy, startTunnel } from "../host/public.mjs";
import { installTools } from "../host/runtime.mjs";

const temp = () => mkdtempSync(join(tmpdir(), "hearth-public-"));
const echo = (name) => new Promise((ok) => {
  const s = createServer((req, res) => { let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => { res.setHeader("X-From", name); res.end(JSON.stringify({ name, method: req.method, url: req.url, body })); }); });
  s.listen(0, "127.0.0.1", () => ok(s));
});

test("the proxy: the proof lists the seller, /sponsor goes to the sponsor without the prefix, the rest to the node", async () => {
  const node = await echo("node"), sponsor = await echo("sponsor");
  const proxy = await startProxy({ nodePort: node.address().port, sponsorPort: sponsor.address().port, seller: "bafyseller" });
  const at = (p, init) => fetch(`http://127.0.0.1:${proxy.port}${p}`, init);
  try {
    const proof = await at("/.well-known/lattice.json");
    assert.equal(proof.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await proof.json(), { sellers: ["bafyseller"] });
    assert.deepEqual(await (await at("/sponsor/terms")).json(), { name: "sponsor", method: "GET", url: "/terms", body: "" });
    assert.deepEqual(await (await at("/sponsor/work", { method: "POST", body: "{\"a\":1}" })).json(), { name: "sponsor", method: "POST", url: "/work", body: "{\"a\":1}" });
    assert.equal((await (await at("/api/chain/info?chainPath=Nexus")).json()).url, "/api/chain/info?chainPath=Nexus");
    assert.equal((await at("/sponsorship")).headers.get("x-from"), "node", "only the /sponsor path itself is the sponsor's");
  } finally { proxy.close(); node.close(); sponsor.close(); }
});

test("the proxy says which side does not answer", async () => {
  const proxy = await startProxy({ nodePort: 1, sponsorPort: 1, seller: "bafyseller" });
  try {
    const r = await fetch(`http://127.0.0.1:${proxy.port}/sponsor/terms`);
    assert.equal(r.status, 502);
    assert.match(await r.text(), /sponsor does not answer/);
  } finally { proxy.close(); }
});

test("the tunnel's URL is the one cloudflared prints; one that prints none fails with its last lines", async () => {
  const dir = temp();
  const fake = (name, script) => { const f = join(dir, name); writeFileSync(f, `#!/bin/sh\n${script}\n`); chmodSync(f, 0o755); return f; };
  const { url, child } = await startTunnel({ bin: fake("good", "echo 'INF Requesting new quick Tunnel' >&2; echo 'INF |  https://brave-otter-12.trycloudflare.com  |' >&2; sleep 30"), port: 1 });
  assert.equal(url, "https://brave-otter-12.trycloudflare.com");
  child.kill("SIGTERM");
  await assert.rejects(startTunnel({ bin: fake("bad", "echo 'ERR failed to request quick Tunnel' >&2; exit 1"), port: 1 }), /exited \(1\) before giving a URL:\nERR failed to request quick Tunnel/);
});

test("a pinned tool from its own URL: a bare binary, or a tarball with it at the top, checked against its SHA-256", async () => {
  const bare = Buffer.from("#!/bin/sh\necho bare\n");
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const pinned = { tun: { version: "1", bins: ["tun"], urls: { "linux-amd64": "https://example.test/tun" }, sha256: { "linux-amd64": sha(bare) } } };
  const fetches = [];
  const fetchImpl = async (u) => { fetches.push(u); return new Response(bare); };
  const home = temp();
  const paths = await installTools({ home, platform: "linux-amd64", fetchImpl, log: () => {}, pinned });
  assert.deepEqual(fetches, ["https://example.test/tun"], "no releases.json for a tool with its own URL");
  assert.equal(readFileSync(paths.tun, "utf8"), bare.toString());
  await assert.rejects(installTools({ home: temp(), platform: "linux-amd64", fetchImpl: async () => new Response("other"), log: () => {}, pinned }), /not the pinned/);
});
