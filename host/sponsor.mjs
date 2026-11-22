// The seller's sponsor: lattice-sponsor beside the node, paying fees for
// clients who pay with proof-of-work shares and selling permanent pins for
// work, from its own key's float on each chain the node hosts. The pacer
// pays that key the blocks it makes, which keeps the float topped up.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { onPath } from "./hearth.mjs";

const GET_IT = "see https://lattice.build/docs/ for where to get it, put it on PATH, or give --sponsor-bin <path>";

/** `--sponsor-bin` as a path to run: a path as given, else the name on PATH; an error saying where to get it when there is none. */
export function sponsorBinary(bin = "lattice-sponsor", PATH = process.env.PATH) {
  const found = bin.includes("/") ? (existsSync(bin) && statSync(bin).isFile() && (statSync(bin).mode & 0o111) ? bin : undefined) : onPath(bin, PATH);
  if (!found) throw new Error(`no lattice-sponsor at ${bin}${bin.includes("/") ? "" : " on PATH"}: Hearth runs one beside the node to sponsor writes and storage; ${GET_IT}`);
  return found;
}

/**
 * lattice-sponsor's arguments: the node's loopback API and cookie, its key,
 * where it listens (every interface only when the seller advertises a public
 * URL), and storage for work at `storageRate` bytes per market coin, paid in
 * coin to the seller (`payTo`, as storage offers say). Its `GET /terms`
 * names its own address (`address`), the one the offer's blocks pay, which
 * is how a buyer sees the sponsor is this host's.
 */
export function sponsorArgs({ node, cookieFile, key, port, publicURL, market, storageRate, storageFile, payTo }) {
  return ["--node", node, "--cookie-file", cookieFile, "--key", key, "--port", String(port), "--host", publicURL ? "0.0.0.0" : "127.0.0.1",
    "--sell-storage", "--storage-rate", `${market}=${storageRate}`, "--storage-file", storageFile, "--pay-to", payTo];
}

/**
 * Runs `bin` with `args` and starts it again whenever it exits, after a
 * backoff that doubles from 1 s to a minute (back to 1 s after a run of a
 * minute or more). `stop()` ends it for good.
 */
export function supervise({ bin, args, log = console.log, spawnImpl = spawn, first = 1000, most = 60_000 }) {
  let child, stopped = false, backoff = first, timer;
  const start = () => {
    const began = Date.now();
    child = spawnImpl(bin, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (e) => log(`sponsor: ${e.message}`));
    child.on("exit", (code, signal) => {
      if (stopped) return;
      backoff = Date.now() - began >= most ? first : backoff;
      log(`sponsor exited (${signal ?? code}); starting it again in ${backoff / 1000} s`);
      timer = setTimeout(start, backoff);
      backoff = Math.min(most, backoff * 2);
    });
  };
  start();
  return { stop: () => { stopped = true; clearTimeout(timer); child?.kill("SIGTERM"); } };
}
