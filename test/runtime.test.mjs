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
