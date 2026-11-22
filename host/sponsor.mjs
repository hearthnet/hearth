// The seller's sponsor: lattice-sponsor beside the node, paying fees for
// clients who pay with proof-of-work shares and selling pins (kept until taken down) for
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
 * is how a buyer sees the sponsor is this host's. It pins at most
 * `storageBudget` bytes in all.
 */
export function sponsorArgs({ node, cookieFile, key, port, publicURL, market, storageRate, storageFile, storageBudget, payTo }) {
  return ["--node", node, "--cookie-file", cookieFile, "--key", key, "--port", String(port), "--host", publicURL ? "0.0.0.0" : "127.0.0.1",
    "--sell-storage", "--storage-rate", `${market}=${storageRate}`, "--storage-file", storageFile, "--storage-budget", String(storageBudget), "--pay-to", payTo];
}

/** Whether any lattice-sponsor answers `GET /terms` on loopback `port`. */
export const sponsorAnswers = (port, fetchImpl = (...a) => fetch(...a)) =>
  fetchImpl(`http://127.0.0.1:${port}/terms`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);

/**
 * The sponsor's storage as its `GET /terms` reports it on loopback `port`:
 * `{ budget, stored, held }` in bytes (`held`: uploads not yet pinned), or
 * undefined when no sponsor answers there or it reports none.
 */
export async function sponsorStorage(port, fetchImpl = (...a) => fetch(...a)) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/terms`, { signal: AbortSignal.timeout(2000) });
    const s = response.ok ? (await response.json()).storage : undefined;
    return s && { budget: Number(s.budget), stored: Number(s.stored), held: Number(s.held) };
  } catch { return undefined; }
}

/**
 * Takes `cid` down on the sponsor on loopback `port` (`POST /takedown`,
 * with the node's cookie, `cookie`, as its operator credential): it unpins
 * the CID's Volumes on the node and refuses the CID from then on.
 * `{ cid, unpinned }`; an error saying what to do otherwise.
 */
export async function unpin({ port, cid, cookie, fetchImpl = (...a) => fetch(...a) }) {
  let response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${port}/takedown`, { method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(cookie).toString("base64")}` }, body: JSON.stringify({ cid }) });
  } catch {
    throw new Error(`no lattice-sponsor answers on 127.0.0.1:${port}: unpin while the seller (and its sponsor) runs, or give --sponsor-port`);
  }
  const text = await response.text();
  if (response.ok) return JSON.parse(text);
  if (response.status === 502 && text.includes("notUnpinned")) {
    throw new Error(`the sponsor blocked ${cid}, but the node refused to unpin it: run hearth unpin ${cid} again`);
  }
  if (response.status === 401) throw new Error(`the sponsor on port ${port} refused the node's cookie: is it the sponsor of this node (--root)?`);
  if (response.status === 404 || response.status === 405) {
    throw new Error(`the lattice-sponsor on port ${port} has no POST /takedown (HTTP ${response.status}): update lattice-sponsor; it serves it with --sell-storage, as hearth sell runs it`);
  }
  throw new Error(`POST /takedown: HTTP ${response.status} ${text.slice(0, 300)}`);
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
