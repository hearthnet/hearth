// The node Hearth runs for a seller who runs none: pinned releases of the
// node and the sponsor, downloaded once into ~/.hearth/bin and checked
// against the SHA-256 below, and a node in ~/.hearth/node that runs while a
// hearth command does.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 * the pinned one. A release lands whole (one rename) or not at all.
 */
export async function installTools({ home, platform = platformName(), fetchImpl = (...a) => fetch(...a), log = console.log, pinned = PINNED }) {
  if (!platform) throw new Error(`there is no prebuilt node for ${process.platform} ${process.arch}: run one yourself and give --root (or --node with --token-file)`);
  const bin = join(hearthHome(home), "bin");
  const paths = {};
  let urls;
  for (const [tool, { version, bins, sha256 }] of Object.entries(pinned)) {
    const dir = join(bin, `${tool}-${version}`);
    const whole = () => bins.every((b) => existsSync(join(dir, b)));
    if (!whole()) {
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
      // Downloads an interrupted run left behind.
      for (const old of readdirSync(bin).filter((n) => n.startsWith(".download-"))) {
        if (Date.now() - statSync(join(bin, old)).mtimeMs > 3_600_000) rmSync(join(bin, old), { recursive: true, force: true });
      }
      const tmp = mkdtempSync(join(bin, ".download-"));
      try {
        writeFileSync(join(tmp, "release.tar.gz"), body);
        try { execFileSync("tar", ["-xzf", join(tmp, "release.tar.gz"), "-C", tmp], { stdio: "ignore" }); }
        catch (e) { throw new Error(`could not unpack ${tool} with tar (${e.code ?? `exit ${e.status}`}): install tar and gzip`); }
        const staged = join(tmp, "staged");
        mkdirSync(staged);
        for (const b of bins) {
          renameSync(join(tmp, `${tool}-${version}-${platform}`, "bin", b), join(staged, b));
          chmodSync(join(staged, b), 0o755);
        }
        // Another hearth command may have installed it meanwhile: theirs stands.
        try { renameSync(staged, dir); } catch (e) { if (!whole()) throw e; }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    for (const b of bins) paths[b] = join(dir, b);
  }
  return paths;
}

/** The root of the node Hearth runs, made the first time (`lattice init`). */
export function initManagedNode({ home, lattice }) {
  const root = managedRoot(home);
  mkdirSync(root, { recursive: true });
  if (!existsSync(join(root, "lattice.json"))) execFileSync(lattice, ["init", "--root", root], { stdio: "ignore" });
  return root;
}

/**
 * Whether a node runs at `root`: its cookie is there (a cookie outlives a
 * crash) and its operator port answers as a node does without the cookie.
 */
export async function nodeAnswers(root, fetchImpl = (...a) => fetch(...a)) {
  if (!existsSync(join(root, "chains/Nexus/.cookie"))) return false;
  let port = 8080;
  try { port = JSON.parse(readFileSync(join(root, "lattice.json"), "utf8")).rpc ?? port; } catch {}
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2_000) });
    return res.status === 401 && /requires the node's cookie/.test(await res.text());
  } catch { return false; }
}

const tail = (file) => { try { return readFileSync(file, "utf8").trimEnd().split("\n").slice(-5).join("\n"); } catch { return ""; } };

// The nodes this process runs: stopped when it exits, or dies of a signal
// nothing else here handles (Ctrl-C reaches them anyway, in its process group).
const owned = new Set();
let watching = false;
function watchExit() {
  if (watching) return;
  watching = true;
  process.on("exit", () => { for (const stop of owned) stop(); });
  for (const [signal, n] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]]) {
    process.on(signal, () => {
      for (const stop of owned) stop();
      if (process.listenerCount(signal) === 1) process.exit(128 + n);
    });
  }
}

/**
 * The node Hearth runs, at `managedRoot(home)`: the one already running there
 * (another hearth command's: `owned` false), else one this process starts and
 * runs as its child until `stop()` or this process ends (`lattice up` exits
 * 75 to be started again). Resolves once it answers.
 */
export async function runManagedNode({ home, lattice, log = console.log, timeoutMs = 180_000, pollMs = 500 }) {
  const root = initManagedNode({ home, lattice });
  if (await nodeAnswers(root)) return { root, stop: () => {}, owned: false, running: () => false };
  const logFile = join(root, "node.log");
  let child, exited, stopping = false;
  const start = () => {
    const out = openSync(logFile, "a");
    exited = undefined;
    child = spawn(lattice, ["up", "--root", root], { stdio: ["ignore", out, out] });
    closeSync(out);
    child.on("exit", (code) => {
      exited = code ?? 1;
      if (code === 75 && !stopping) start();
    });
  };
  const stop = () => { stopping = true; owned.delete(stop); child?.kill("SIGTERM"); };
  watchExit();
  owned.add(stop);
  start();
  log(`started the node in ${root} (its log: ${logFile}); it stops when this command does`);
  // Its process is up, or being started again after exit 75.
  const running = () => !stopping && exited === undefined;
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    if (await nodeAnswers(root)) return { root, stop, owned: true, running };
    if (exited !== undefined && exited !== 75) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  stop();
  throw new Error(`the node in ${root} did not start; the end of ${logFile}:\n${tail(logFile)}`);
}

/**
 * The node `hearth sell` sells from, kept up for as long as it sells: checked
 * every `everyMs`, and started again (by this process) whenever it stops
 * answering: it crashed, or the command that started it ended. A node this
 * process runs is left alone while its process is up (busy, or restarting).
 * `stop()` ends both, and so does this process ending.
 */
export async function keepManagedNode({ home, lattice, log = console.log, everyMs = 5_000 }) {
  let current = await runManagedNode({ home, lattice, log });
  const { root } = current;
  let busy = false, stopped = false;
  const timer = setInterval(async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      if (!current.running() && !(await nodeAnswers(root)) && !stopped) {
        log(`the node in ${root} stopped answering: starting it again`);
        current = await runManagedNode({ home, lattice, log });
        if (stopped) current.stop();
      }
    } catch (e) { log(e.message); } finally { busy = false; }
  }, everyMs);
  timer.unref();
  const stop = () => { stopped = true; owned.delete(stop); clearInterval(timer); current.stop(); };
  owned.add(stop);
  return { root, stop };
}
