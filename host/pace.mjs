// The seller's miner: mines every chain the node hosts, all the time, with
// this machine's processor. A template rooted at Nexus carries every hosted
// chain, and one hash makes a block on each whose target it clears (a hit
// that clears only a child is `childOnly`, and the child block counts), so
// every chain gets all of the machine's hashes: its difficulty (ASERT)
// settles where the seller's full rate makes its blocks on time.
//
// Each batch asks the node for a fresh template paying every level to
// `to`, searches up to the template's search target (the easiest carried
// chain's), and submits each hit through POST /mining/work. It logs the
// rate it measures: the hash rate a seller offers.
import { createHash } from "node:crypto";

/**
 * Block.makeProofOfWorkPreimagePrefix: each consensus field before the
 * nonce, 0x00-terminated. Targets are written as 64 hex digits, as nodes
 * hash them (the vendored SDK's preimage writes them minimal, which nodes
 * do not take).
 */
export function prefixOf(b) {
  const cid = (l) => l?.rawCID ?? "", hex = (t) => BigInt(t).toString(16).padStart(64, "0");
  const fields = [String(b.version), cid(b.parent), cid(b.transactions), hex(b.target), hex(b.nextTarget), cid(b.spec),
    cid(b.parentState), cid(b.prevState), cid(b.postState), cid(b.children), String(b.height), String(b.timestamp)];
  const recipient = b.rewardRecipient === undefined ? Buffer.of(0) : Buffer.concat([Buffer.of(1), Buffer.from(b.rewardRecipient), Buffer.of(0)]);
  return Buffer.concat([...fields.flatMap((f) => [Buffer.from(f), Buffer.of(0)]), recipient]);
}

/**
 * The lowest nonce in [start, start + count) with
 * floor < SHA256(prefix || be64(nonce)) <= target, as `{ nonce, hash, hashes }`, or
 * `{ nonce: null, hashes }`. Yields to the event loop between chunks.
 */
export async function search(prefix, target, start, count, chunk = 1n << 16n, floor = -1n) {
  const mid = createHash("sha256").update(prefix), n = Buffer.alloc(8);
  for (let i = 0n; i < count; i++) {
    if (i > 0n && i % chunk === 0n) await new Promise((r) => setImmediate(r));
    n.writeBigUInt64BE(start + i);
    const hash = mid.copy().update(n).digest("hex");
    const h = BigInt(`0x${hash}`);
    if (h <= target && h > floor) return { nonce: start + i, hash, hashes: i + 1n };
  }
  return { nonce: null, hashes: count };
}

// The worker contract's reference vector (canonical Nexus genesis, nonce 12345).
const GENESIS = { version: 1, transactions: { rawCID: "bafyreif7evarukmzptcevexehltxzyzucps333zscsv6fo3zsnq2xiuhtq" }, target: `0x${"f".repeat(64)}`,
  nextTarget: `0x${"f".repeat(64)}`, spec: { rawCID: "bafyreihdy4bovdbbcdlvgyk2mu3ee22t2hyrvsk6fuwtj2amh4n6nm4kve" },
  parentState: { rawCID: "bafyreidqzf3xxxwybhou6t73kx2isyhvtjarwbafuglb52u5w4soetbf2a" }, prevState: { rawCID: "bafyreidqzf3xxxwybhou6t73kx2isyhvtjarwbafuglb52u5w4soetbf2a" },
  postState: { rawCID: "bafyreihmp4gaf4hy6roboinejakbbfx5nkwfcogvd7ielqjucmn4tx7pi4" }, children: { rawCID: "bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua" },
  height: 0, timestamp: 1791094799000 };
const VECTOR = "0179e03e9b0545582bb0aba1729d83b611b16e49abcefe44d6c1d35e85c4b3a3";

/** The chain paths from Nexus down to each of `paths`, parents first. */
const withAncestors = (paths) => [...new Set(paths.flatMap((p) => p.split("/").map((_, i, s) => s.slice(0, i + 1).join("/"))))];

/**
 * Mines every chain the node at `rpc` hosts, crediting `to`, in batches of
 * `batch` hashes. `fetchImpl` carries the node's secret. Returns
 * `{ stop, done, rate }`: `rate()` is the measured hashes per second.
 */
export function miner({ rpc, fetchImpl, to, log = console.log, batch = 1n << 20n, idle = 1000 }) {
  let stopped = false, wake, hashes = 0n, hashing = 0, since = Date.now(), measured = 0;
  const sleep = (ms) => new Promise((r) => { wake = r; setTimeout(r, ms); });
  const get = async (route) => {
    const response = await fetchImpl(new URL(route, rpc));
    if (!response.ok) throw Object.assign(new Error(`${route.split("?")[0]}: HTTP ${response.status}`), { status: response.status });
    return response.json();
  };
  const post = async (route, body) => {
    const response = await fetchImpl(new URL(route, rpc), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) throw new Error(`${route} ${response.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  let said;
  const say = (line) => { if (line !== said) log((said = line)); };

  /** The chains the node hosts, as its operator `GET /config` lists them. */
  const hostedChains = async () => ((await get("/config")).status?.chains ?? []).filter((c) => c.actual === "hosted").map((c) => c.path);

  async function round(start) {
    const t = await post("/mining/templates", { recipients: withAncestors(await hostedChains()).map((p) => ({ chainPath: p.split("/"), address: to })) });
    const carried = (t.chains ?? []).map((c) => ({ path: c.chainPath.join("/"), target: BigInt(c.target), height: c.height }));
    if (!carried.length) { say("miner: the node's template carries no chain yet"); return false; }
    const prefix = t.prefixHex ? Buffer.from(t.prefixHex, "hex") : prefixOf(t.block);
    for (let at = start; ;) {
      const began = performance.now();
      const hit = await search(prefix, BigInt(t.searchTarget), at, batch - (at - start));
      hashing += performance.now() - began;
      hashes += hit.hashes;
      if (hit.nonce === null) return true;
      const result = await post("/mining/work", { workID: t.workID, nonce: Number(hit.nonce) });
      const cleared = carried.filter((c) => BigInt(`0x${hit.hash}`) <= c.target);
      said = undefined;
      log(`mined ${cleared.map((c) => `${c.path}@${c.height}`).join(" ")}: ${result.disposition}`);
      // The template's blocks are spent: take a fresh one.
      return true;
    }
  }

  const done = (async () => {
    if ((await search(prefixOf(GENESIS), BigInt(`0x${VECTOR}`), 12345n, 1n)).hash !== VECTOR) throw new Error("miner: the proof-of-work preimage does not match the reference vector");
    let start = 0n;
    while (!stopped) {
      let ok = false;
      try { ok = await round(start); start += batch; } catch (e) { say(`miner: ${e.message}`); }
      const now = Date.now();
      // The machine's rate: hashes over the time spent hashing, not over the
      // minute (an easy chain is mostly template fetches, not search).
      if (now - since >= 60_000 && hashing > 0) { measured = Number(hashes) * 1000 / hashing; hashes = 0n; hashing = 0; since = now; log(`miner: ${Math.round(measured)} hashes per second`); }
      if (!stopped && !ok) await sleep(idle);
    }
  })();
  return { stop: () => { stopped = true; wake?.(); }, done, rate: () => measured };
}
