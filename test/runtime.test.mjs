import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installTools, nodeAnswers, platformName, runManagedNode } from "../host/runtime.mjs";

const BIN = new URL("../bin/hearth.mjs", import.meta.url).pathname;
const run = (args, { cwd, home }) => new Promise((ok) => execFile(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, HOME: home } }, (error, stdout, stderr) => ok({ code: error?.code ?? 0, out: stdout + stderr })));

const temp = () => mkdtempSync(join(tmpdir(), "hearth-runtime-"));

/** A release tarball as the releases are laid out: <tool>-<version>-<platform>/bin/<bins>. */
function tarball(tool, version, platform, bins) {
  const dir = temp();
  const top = `${tool}-${version}-${platform}`;
  mkdirSync(join(dir, top, "bin"), { recursive: true });
  for (const b of [...bins, "extra-tool"]) writeFileSync(join(dir, top, "bin", b), `#!/bin/sh\necho ${b}\n`);
  execFileSync("tar", ["-czf", join(dir, "t.tar.gz"), "-C", dir, top]);
  return readFileSync(join(dir, "t.tar.gz"));
}

function server(files) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url === "https://lattice.build/releases.json") return new Response(JSON.stringify({ tool: "https://dl.example/{version}/tool-{version}-{platform}.tar.gz" }));
    return files[url] ? new Response(files[url]) : new Response("no", { status: 404 });
  };
  return { asked, fetchImpl };
}

test("a release whose SHA-256 is the pinned one installs its binaries, once", async () => {
  const body = tarball("tool", "1.2.3", "linux-amd64", ["tool"]);
  const pinned = { tool: { version: "1.2.3", bins: ["tool"], sha256: { "linux-amd64": createHash("sha256").update(body).digest("hex") } } };
  const home = temp();
  const { asked, fetchImpl } = server({ "https://dl.example/1.2.3/tool-1.2.3-linux-amd64.tar.gz": body });
  const paths = await installTools({ home, platform: "linux-amd64", fetchImpl, pinned, log: () => {} });
  assert.equal(paths.tool, join(home, ".hearth/bin/tool-1.2.3/tool"));
  assert.ok(statSync(paths.tool).mode & 0o111, "executable");
  assert.ok(!existsSync(join(home, ".hearth/bin/tool-1.2.3/extra-tool")), "only the binaries Hearth runs");
  await installTools({ home, platform: "linux-amd64", fetchImpl, pinned, log: () => {} });
  assert.equal(asked.length, 2, "the second call downloads nothing");
});

test("a release with another SHA-256 is refused and leaves nothing installed", async () => {
  const body = tarball("tool", "1.2.3", "linux-amd64", ["tool"]);
  const pinned = { tool: { version: "1.2.3", bins: ["tool"], sha256: { "linux-amd64": "0".repeat(64) } } };
  const home = temp();
  const { fetchImpl } = server({ "https://dl.example/1.2.3/tool-1.2.3-linux-amd64.tar.gz": body });
  await assert.rejects(installTools({ home, platform: "linux-amd64", fetchImpl, pinned, log: () => {} }), /not the pinned 0{64}: not installed/);
  assert.ok(!existsSync(join(home, ".hearth/bin/tool-1.2.3")));
});

test("a platform with no prebuilt node says to run one and give --root", async () => {
  assert.equal(platformName("win32", "x64"), undefined);
  assert.equal(platformName("darwin", "arm64"), "macos-arm64");
  assert.equal(platformName("linux", "x64"), "linux-amd64");
  await assert.rejects(installTools({ home: temp(), platform: null }), /no prebuilt node .*give --root/);
});

test("on a machine that sold nothing, a hearth command says so, and downloads and starts nothing", async () => {
  const home = temp();
  for (const verb of ["status", "stop", "sweep"]) {
    const { code, out } = await run([verb], { cwd: temp(), home });
    assert.equal(code, 2, out);
    assert.match(out, /nothing is sold from this machine yet: run hearth sell/);
  }
  assert.ok(!existsSync(join(home, ".hearth")), "nothing installed");
});

test("a node of your own that is not running is named, not replaced by Hearth's", async () => {
  const home = temp(), own = temp();
  writeFileSync(join(own, "lattice.json"), "{}\n");
  const { code, out } = await run(["sell", "--price", "100/day"], { cwd: own, home });
  assert.equal(code, 2, out);
  assert.match(out, /the node at \S+ is not running: start it, or give --root/);
  assert.ok(out.includes(own.split("/").pop()), "names that node's folder");
  assert.ok(!existsSync(join(home, ".hearth")));
});

test("a cookie left by a crash is no running node", async () => {
  const root = temp();
  mkdirSync(join(root, "chains/Nexus"), { recursive: true });
  writeFileSync(join(root, "chains/Nexus/.cookie"), "c");
  writeFileSync(join(root, "lattice.json"), JSON.stringify({ rpc: 1 }));
  assert.equal(await nodeAnswers(root), false);
});

test("a node that cannot start says so with the end of its log, and nothing keeps running", async () => {
  const home = temp(), dir = temp();
  const lattice = join(dir, "lattice");
  writeFileSync(lattice, `#!/bin/sh
case "$1" in
  init) mkdir -p "$3"; echo '{"rpc": 1}' > "$3/lattice.json" ;;
  up) echo "listen 0.0.0.0:4001: address already in use"; exit 1 ;;
esac
`);
  chmodSync(lattice, 0o755);
  await assert.rejects(runManagedNode({ home, lattice, log: () => {}, pollMs: 50 }), /did not start; the end of .*node\.log:\nlisten 0\.0\.0\.0:4001: address already in use/);
});

/** A stand-in node: `init` writes lattice.json (rpc `port`), `up` writes the cookie and answers as a node does until SIGTERM, its pid in <root>/up.pid. */
function fakeLattice(port) {
  const dir = temp();
  const file = join(dir, "lattice");
  writeFileSync(file, `#!${process.execPath}
const fs = require("node:fs"), http = require("node:http"), path = require("node:path");
const [verb, , root] = process.argv.slice(2);
if (verb === "init") { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, "lattice.json"), JSON.stringify({ rpc: ${port} })); process.exit(0); }
fs.mkdirSync(path.join(root, "chains/Nexus"), { recursive: true });
fs.writeFileSync(path.join(root, "up.pid"), String(process.pid));
http.createServer((q, r) => { r.statusCode = 401; r.end(JSON.stringify({ error: { message: "operator RPC requires the node's cookie" } })); })
  .listen(${port}, "127.0.0.1", () => fs.writeFileSync(path.join(root, "chains/Nexus/.cookie"), "c"));
process.on("SIGTERM", () => { fs.rmSync(path.join(root, "chains/Nexus/.cookie"), { force: true }); process.exit(0); });
`);
  chmodSync(file, 0o755);
  return file;
}
const freePort = () => new Promise(async (ok) => { const s = (await import("node:net")).createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });

test("only a node's own answer counts: another server on the port is no node", async () => {
  const http = await import("node:http");
  const root = temp();
  mkdirSync(join(root, "chains/Nexus"), { recursive: true });
  writeFileSync(join(root, "chains/Nexus/.cookie"), "c");
  const other = http.createServer((q, r) => { r.statusCode = 404; r.end("not here"); }).listen(0, "127.0.0.1");
  await new Promise((r) => other.once("listening", r));
  writeFileSync(join(root, "lattice.json"), JSON.stringify({ rpc: other.address().port }));
  try { assert.equal(await nodeAnswers(root), false); } finally { other.closeAllConnections(); other.close(); }
});

test("the node hearth sell keeps is started again when it dies", async () => {
  const { keepManagedNode } = await import("../host/runtime.mjs");
  const home = temp();
  const lattice = fakeLattice(await freePort());
  const kept = await keepManagedNode({ home, lattice, log: () => {}, everyMs: 200 });
  const { root } = kept;
  const first = Number(readFileSync(join(root, "up.pid"), "utf8"));
  process.kill(first, "SIGKILL");
  let again;
  for (let i = 0; i < 100 && !again; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const pid = Number(readFileSync(join(root, "up.pid"), "utf8"));
    if (pid !== first && await nodeAnswers(root)) again = pid;
  }
  assert.ok(again, "a new node answers");
  kept.stop();
});

test("a hearth process ended by SIGTERM stops the node it started", async () => {
  const { spawn } = await import("node:child_process");
  const home = temp();
  const lattice = fakeLattice(await freePort());
  const runtime = new URL("../host/runtime.mjs", import.meta.url).href;
  const p = spawn(process.execPath, ["--input-type=module", "-e", `const r = await import(${JSON.stringify(runtime)}); await r.runManagedNode({ home: ${JSON.stringify(home)}, lattice: ${JSON.stringify(lattice)}, log: () => console.log("up") }); setInterval(() => {}, 1000);`]);
  await new Promise((r) => p.stdout.once("data", r));
  const root = join(home, ".hearth/node");
  for (let i = 0; i < 50 && !(await nodeAnswers(root)); i++) await new Promise((r) => setTimeout(r, 100));
  const node = Number(readFileSync(join(root, "up.pid"), "utf8"));
  p.kill("SIGTERM");
  await new Promise((r) => p.once("exit", r));
  let gone = false;
  for (let i = 0; i < 50 && !gone; i++) { await new Promise((r) => setTimeout(r, 100)); try { process.kill(node, 0); } catch { gone = true; } }
  assert.ok(gone, "the node is gone");
});

test("while the node it runs restarts (exit 75), the keeper starts no second node", async () => {
  const { keepManagedNode } = await import("../host/runtime.mjs");
  const home = temp();
  const port = await freePort();
  const dir = temp();
  const lattice = join(dir, "lattice");
  // The first `up` exits 75 soon after it answers; the next takes 2 s to boot.
  writeFileSync(lattice, `#!${process.execPath}
const fs = require("node:fs"), http = require("node:http"), path = require("node:path");
const [verb, , root] = process.argv.slice(2);
if (verb === "init") { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, "lattice.json"), JSON.stringify({ rpc: ${port} })); process.exit(0); }
fs.mkdirSync(path.join(root, "chains/Nexus"), { recursive: true });
fs.appendFileSync(path.join(root, "starts"), process.pid + "\\n");
const first = fs.readFileSync(path.join(root, "starts"), "utf8").trim().split("\\n").length === 1;
const cookie = path.join(root, "chains/Nexus/.cookie");
setTimeout(() => {
  const s = http.createServer((q, r) => { r.statusCode = 401; r.end("operator RPC requires the node's cookie"); }).listen(${port}, "127.0.0.1", () => fs.writeFileSync(cookie, "c"));
  if (first) setTimeout(() => { fs.rmSync(cookie, { force: true }); s.close(); process.exit(75); }, 500);
}, first ? 0 : 2000);
process.on("SIGTERM", () => { fs.rmSync(cookie, { force: true }); process.exit(0); });
`);
  chmodSync(lattice, 0o755);
  const kept = await keepManagedNode({ home, lattice, log: () => {}, everyMs: 100 });
  await new Promise((r) => setTimeout(r, 4000));
  const starts = readFileSync(join(kept.root, "starts"), "utf8").trim().split("\n").length;
  const up = await nodeAnswers(kept.root);
  kept.stop();
  assert.equal(starts, 2);
  assert.ok(up);
});
