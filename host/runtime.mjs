// The node Hearth runs for a seller who runs none: pinned releases of the
// node and the sponsor, downloaded once into ~/.hearth/bin and checked
// against the SHA-256 below, and a node kept up in ~/.hearth/node.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where each tool's release tarball is: a URL template with {version} and {platform}. */
export const RELEASES_URL = "https://lattice.build/releases.json";

/** The releases Hearth runs, and the binaries it takes from each. */
export const PINNED = {
  "lattice-node": {
    version: "5.0.0",
    bins: ["lattice", "lattice-node"],
    sha256: {
      "macos-arm64": "6305f8c6adfe15996a872e1a2a5aea36586bbfbe49b9847204fa802f0224e0db",
      "linux-amd64": "f9caaa488b01d54fa86e7d5a697949b8d1db230248b535b71bcc97b784296bf4",
    },
  },
  "lattice-sponsor": {
    version: "1.0.0",
    bins: ["lattice-sponsor"],
    sha256: {
      "macos-arm64": "e6e044eda166284f91cffcf856dcbe639b1700b6cc452eda8549fb93558b979b",
      "linux-amd64": "d726ab95b3ba55dbc9bf4f49cf11a2a0af31ee8ca6235273b718f75972fa9587",
    },
  },
};

export const hearthHome = (home) => join(home, ".hearth");
/** The root of the node Hearth runs. */
export const managedRoot = (home) => join(hearthHome(home), "node");

/** The release platform this machine runs, or undefined when there is none. */
export function platformName(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "linux" && arch === "x64") return "linux-amd64";
  return undefined;
}

/**
 * The pinned binaries' paths ({ lattice, "lattice-node", "lattice-sponsor" }),
 * each release downloaded the first time and refused unless its SHA-256 is
 * the pinned one. A release lands whole or not at all.
 */
export async function installTools({ home, platform = platformName(), fetchImpl = (...a) => fetch(...a), log = console.log, pinned = PINNED }) {
  if (!platform) throw new Error(`there is no prebuilt node for ${process.platform} ${process.arch}: run one yourself and give --root (or --node with --token-file)`);
  const bin = join(hearthHome(home), "bin");
  const paths = {};
  let urls;
  for (const [tool, { version, bins, sha256 }] of Object.entries(pinned)) {
    const dir = join(bin, `${tool}-${version}`);
    if (!bins.every((b) => existsSync(join(dir, b)))) {
      if (!urls) {
        const res = await fetchImpl(RELEASES_URL);
        if (!res.ok) throw new Error(`${RELEASES_URL}: HTTP ${res.status}`);
        urls = await res.json();
      }
      const url = String(urls[tool] ?? "").replaceAll("{version}", version).replaceAll("{platform}", platform);
      if (!url.startsWith("https://")) throw new Error(`${RELEASES_URL} gives no download for ${tool}`);
      log(`downloading ${tool} ${version} (${platform}), once, into ${bin}`);
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      const got = createHash("sha256").update(body).digest("hex");
      if (got !== sha256[platform]) throw new Error(`${url} has SHA-256 ${got}, not the pinned ${sha256[platform]}: not installed`);
      mkdirSync(bin, { recursive: true });
      const tmp = mkdtempSync(join(bin, ".download-"));
      try {
        writeFileSync(join(tmp, "release.tar.gz"), body);
        execFileSync("tar", ["-xzf", join(tmp, "release.tar.gz"), "-C", tmp]);
        const staged = join(tmp, "staged");
        mkdirSync(staged);
        for (const b of bins) {
          renameSync(join(tmp, `${tool}-${version}-${platform}`, "bin", b), join(staged, b));
          chmodSync(join(staged, b), 0o755);
        }
        rmSync(dir, { recursive: true, force: true });
        renameSync(staged, dir);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    for (const b of bins) paths[b] = join(dir, b);
  }
  return paths;
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

/** The root of the node Hearth runs, made the first time (`lattice init`). */
export function initManagedNode({ home, lattice }) {
  const root = managedRoot(home);
  mkdirSync(root, { recursive: true });
  if (!existsSync(join(root, "lattice.json"))) execFileSync(lattice, ["init", "--root", root], { stdio: "ignore" });
  return root;
}

/**
 * The node Hearth runs, at `managedRoot(home)` (initManagedNode), kept up by a detached loop that outlives this
 * command (`lattice up` exits 75 to be restarted, 0 when stopped). Resolves
 * with its root once it runs (its cookie is there).
 */
export async function startManagedNode({ home, lattice, log = console.log, timeoutMs = 180_000, pollMs = 500 }) {
  const root = initManagedNode({ home, lattice });
  const cookie = join(root, "chains/Nexus/.cookie");
  if (existsSync(cookie)) return root;
  const pidFile = join(root, "keeper.pid");
  const running = existsSync(pidFile) && alive(Number(readFileSync(pidFile, "utf8")));
  if (!running) {
    const out = openSync(join(root, "node.log"), "a");
    const keeper = spawn("/bin/sh", ["-c", 'while :; do "$0" up --root "$1"; c=$?; [ "$c" -eq 0 ] && exit 0; sleep 3; done', lattice, root],
      { detached: true, stdio: ["ignore", out, out] });
    keeper.unref();
    writeFileSync(pidFile, `${keeper.pid}\n`);
    log(`started the node in ${root} (its log: ${join(root, "node.log")}; it keeps running after this command)`);
  }
  const pid = Number(readFileSync(pidFile, "utf8"));
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    if (existsSync(cookie)) return root;
    if (!alive(pid)) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`the node in ${root} did not start: see ${join(root, "node.log")}`);
}
