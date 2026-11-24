// hearth sell --public: the proxy the public reaches through the tunnel, the tunnel's URL, and cloudflared's install.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openTunnel, startProxy, startTunnel } from "../host/public.mjs";
import { installTools } from "../host/runtime.mjs";

const temp = () => mkdtempSync(join(tmpdir(), "hearth-public-"));
const echo = (name) => new Promise((ok) => {
  const s = createServer((req, res) => { let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => { res.setHeader("X-From", name); res.end(JSON.stringify({ name, method: req.method, url: req.url, body })); }); });
  s.listen(0, "127.0.0.1", () => ok(s));
});

test("the proxy: /sponsor goes to the sponsor without the prefix, the rest to the node", async () => {
  const node = await echo("node"), sponsor = await echo("sponsor");
  const proxy = await startProxy({ nodePort: node.address().port, sponsorPort: sponsor.address().port });
  const at = (p, init) => fetch(`http://127.0.0.1:${proxy.port}${p}`, init);
  try {
    assert.equal((await (await at("/.well-known/lattice.json")).json()).name, "node", "no proof of a domain: there are no url records");
    assert.deepEqual(await (await at("/sponsor/terms")).json(), { name: "sponsor", method: "GET", url: "/terms", body: "" });
    assert.deepEqual(await (await at("/sponsor/work", { method: "POST", body: "{\"a\":1}" })).json(), { name: "sponsor", method: "POST", url: "/work", body: "{\"a\":1}" });
    assert.equal((await (await at("/api/chain/info?chainPath=Nexus")).json()).url, "/api/chain/info?chainPath=Nexus");
    assert.equal((await at("/sponsorship")).headers.get("x-from"), "node", "only the /sponsor path itself is the sponsor's");
    assert.equal((await (await at("/sponsor?x=1")).json()).url, "/?x=1", "a query on the sponsor's root");
    assert.equal((await (await at("/sponsor")).json()).url, "/");
  } finally { proxy.close(); node.close(); sponsor.close(); }
});

test("the proxy forwards no header a client could pose as another address with, nor hop-by-hop ones", async () => {
  const seen = [];
  const node = await new Promise((ok) => { const s = createServer((req, res) => { seen.push(req.headers); res.setHeader("Connection", "close"); res.end("ok"); }); s.listen(0, "127.0.0.1", () => ok(s)); });
  const proxy = await startProxy({ nodePort: node.address().port, sponsorPort: 1 });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/api/chain/info`, { headers: { "X-Forwarded-For": "6.6.6.6", Forwarded: "for=6.6.6.6", "X-Real-IP": "6.6.6.6", "Proxy-Authorization": "x", Accept: "application/json" } });
    const h = seen[0];
    for (const k of ["x-forwarded-for", "forwarded", "x-real-ip", "proxy-authorization"]) assert.equal(h[k], undefined, k);
    assert.equal(h.accept, "application/json", "end-to-end headers pass");
    assert.equal(h.host, `127.0.0.1:${node.address().port}`);
  } finally { proxy.close(); node.close(); }
});

test("a body stays framed though Connection names content-length: one request reaches the node, never two", async () => {
  const { connect } = await import("node:net");
  const seen = [];
  const node = await new Promise((ok) => { const s = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { seen.push({ url: req.url, body: b }); res.end("ok"); }); }); s.listen(0, "127.0.0.1", () => ok(s)); });
  const proxy = await startProxy({ nodePort: node.address().port, sponsorPort: 1 });
  try {
    const inner = "GET /smuggled HTTP/1.1\r\nHost: x\r\n\r\n";
    await new Promise((ok) => {
      const c = connect(proxy.port, "127.0.0.1", () => c.write(`GET /api/x HTTP/1.1\r\nHost: x\r\nConnection: content-length\r\nContent-Length: ${inner.length}\r\n\r\n${inner}`));
      c.on("data", () => { c.end(); ok(); });
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(seen.map((x) => x.url), ["/api/x"], "no second request");
    assert.equal(seen[0].body, inner, "the body arrives as the body");
  } finally { proxy.close(); node.close(); }
});

test("the proxy says which side does not answer", async () => {
  const proxy = await startProxy({ nodePort: 1, sponsorPort: 1 });
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

test("behind the proxy the sponsor stays on loopback; without one, a public sponsor URL opens every interface", async () => {
  const { sponsorArgs } = await import("../host/sponsor.mjs");
  const base = { node: "http://127.0.0.1:8080", cookieFile: "c", key: "k", port: 8650, market: "Nexus/hearth", storageRate: 1, storageFile: "s", storageBudget: 1, payTo: "p" };
  const host = (o) => { const a = sponsorArgs({ ...base, ...o }); return a[a.indexOf("--host") + 1]; };
  assert.equal(host({ publicURL: "https://x.trycloudflare.com/sponsor", loopback: true }), "127.0.0.1");
  assert.equal(host({ publicURL: "https://host.example/sponsor" }), "0.0.0.0");
  assert.equal(host({}), "127.0.0.1");
});

test("a quick tunnel Cloudflare refuses for now is tried again, then the last failure stands", async () => {
  let n = 0; const said = [];
  const start = async () => { if (++n < 3) throw new Error("cloudflared exited (1) before giving a URL:\nquick tunnel provisioning failed with status 429: [10000] Tunnelstore request failed"); return { url: "https://ok.trycloudflare.com" }; };
  assert.deepEqual(await openTunnel({ start, delaysMs: [1, 1, 1], log: (l) => said.push(l) }), { url: "https://ok.trycloudflare.com" });
  assert.equal(n, 3);
  assert.match(said[0], /no quick tunnel yet \(status 429: \[10000\] Tunnelstore request failed\): trying again in 0.001 s/);
  n = 0;
  await assert.rejects(openTunnel({ start: async () => { n++; throw new Error("boom"); }, delaysMs: [1, 1] }), /boom/);
  assert.equal(n, 3, "the first try and one per wait");
});
