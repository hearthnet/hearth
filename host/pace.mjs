// The seller's pacer: makes the blocks of the chains it hosts, one at a time
// as each comes due, with this machine's processor. A template rooted at
// Nexus carries the chains the node hosts (less those the request
// excludes), and one hash makes a block on each whose target it clears, so
// a chain with no other miner needs about one hash per block (a hit that
// clears only a child is `childOnly`, and the child block counts).
//
// A chain is due once its tip is `targetBlockTime` old, from anyone's block:
// the pacer starts no round for a chain before then, since blocks faster
// than that harden the chain (ASERT), and a chain other miners or other
// hosts keep moving needs nothing from it (another chain's round can still
// give it an early block when it is an easier ancestor of the due chain, or
// on a node without `exclude`: see below). When a chain is due it asks the
// node for a template paying every level to `to`, searches nonces up to
// that chain's target (the easiest due chain's, never past the template's search
// target), and submits the first hit through POST /mining/work.
//
// Each round names in `exclude` every chain the node hosts that is not due
// and has none due below it (lattice-node's `POST /mining/templates`
// `exclude`): the node leaves those out of the template, so the hit makes no
// block on them and they set no part of `searchTarget`. A due chain's
// ancestors are carried with it, and a hash that clears it also makes a
// block on any ancestor whose target is easier: the hash is shared, and that
// ancestor's difficulty corrects it. (The pacer skips a hash that would
// clear a harder ancestor.) A request the node refuses with
// `excludedAncestor` (a chain newly hosted under an excluded one) is sent
// once more with the hosted chains read again.
//
// A node from before `exclude` ignores it and carries every hosted chain
// (an excluded path shows in the response's `chains`). With one, the pacer
// skips hashes that would clear a chain not due whose target is harder than
// the one it searches to; one whose target is easier cannot be kept out that
// way, and takes an early block.
//
// A chain the node has not synced yet is never paced. After a miss (no hit
// in `maxHashes`), a chain waits its whole target block time.
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
 * What a round excludes: each of `hosted` (the chains the node hosts) below
 * Nexus that is neither due nor an ancestor of a due chain. Those are whole
 * subtrees, as the node requires: a chain kept keeps its ancestors.
 */
export function exclusions({ hosted, due }) {
  const keep = new Set(withAncestors(due));
  return [...new Set(hosted)].filter((p) => p.includes("/") && !keep.has(p)).sort();
}

/**
 * Paces `chains()` (read again each round: the market and the chains the
 * seller hosts) on the node at `rpc`, crediting `to`. `fetchImpl` carries
 * the node's secret. Returns `{ stop, done }`.
 */
export function pacer({ rpc, fetchImpl, to, chains, log = console.log, maxHashes = 1n << 22n, idle = 1000 }) {
  let stopped = false, wake;
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
  const blockTimes = new Map();  // path → targetBlockTime (ms): a chain's spec never changes
  const made = new Map();  // path → when this pacer last made its block, in case the node's tip lags the submit
  const q = (path) => `chainPath=${encodeURIComponent(path)}`;
  let said;
  const say = (line) => { if (line !== said) log((said = line)); };

  /** The chains the node hosts, as its operator `GET /config` lists them. */
  const hostedChains = async () => ((await get("/config")).status?.chains ?? []).filter((c) => c.actual === "hosted").map((c) => c.path);

  async function template(due) {
    for (let tries = 0; ; tries++) {
      const exclude = exclusions({ hosted: await hostedChains(), due });
      try {
        const t = await post("/mining/templates", { recipients: withAncestors(chains()).map((p) => ({ chainPath: p.split("/"), address: to })),
          ...(exclude.length ? { exclude: exclude.map((p) => p.split("/")) } : {}) });
        return t;
      } catch (e) {
        // A chain newly hosted under an excluded one: read the hosted chains again, once.
        if (tries > 0 || !/excludedAncestor/.test(e.message)) throw e;
      }
    }
  }

  async function round(due) {
    const t = await template(due);
    const carried = (t.chains ?? []).map((c) => ({ path: c.chainPath.join("/"), target: BigInt(c.target), height: c.height }));
    const dueTargets = carried.filter((c) => due.includes(c.path)).map((c) => c.target);
    if (!dueTargets.length) { say(`pacer: the node's template carries none of ${due.join(" ")} yet`); return "absent"; }
    const easiest = dueTargets.reduce((a, b) => (b > a ? b : a));
    const target = easiest < BigInt(t.searchTarget) ? easiest : BigInt(t.searchTarget);
    // Not past a harder chain that is not due: a due chain's ancestor, or
    // (on a node from before `exclude`) a chain it was asked to leave out.
    const floor = carried.filter((c) => !due.includes(c.path) && c.target < target).reduce((f, c) => (c.target > f ? c.target : f), -1n);
    const prefix = t.prefixHex ? Buffer.from(t.prefixHex, "hex") : prefixOf(t.block);
    const hit = await search(prefix, target, 0n, maxHashes, 1n << 16n, floor);
    if (hit.nonce === null) { say(`pacer: no hit for ${due.join(" ")} in ${maxHashes} hashes; its target is past this pacer`); return "miss"; }
    const result = await post("/mining/work", { workID: t.workID, nonce: Number(hit.nonce) });
    const cleared = carried.filter((c) => BigInt(`0x${hit.hash}`) <= c.target);
    for (const c of cleared) made.set(c.path, Date.now());
    said = undefined;
    log(`paced ${cleared.map((c) => `${c.path}@${c.height}`).join(" ")} (${hit.hashes} hashes): ${result.disposition}`);
    return "hit";
  }

  const done = (async () => {
    if ((await search(prefixOf(GENESIS), BigInt(`0x${VECTOR}`), 12345n, 1n)).hash !== VECTOR) throw new Error("pacer: the proof-of-work preimage does not match the reference vector");
    while (!stopped) {
      let next = Infinity;
      try {
        const now = Date.now(), due = [];
        for (const path of chains()) {
          // A chain the node holds no block of yet (its genesis waits on a
          // hash) is due; if the template does not carry it, the node does
          // not host it yet.
          const status = await get(`/status?${q(path)}`).catch((e) => { if (e.status === 404) return {}; throw e; });
          if (status.height != null && status.bestHeaderHeight != null && BigInt(status.height) < BigInt(status.bestHeaderHeight)) { say(`pacer: ${path} is syncing (${status.height} / ${status.bestHeaderHeight}): not pacing it`); continue; }
          let tip;
          try {
            if (!blockTimes.has(path)) blockTimes.set(path, Number((await get(`/api/chain/spec?${q(path)}`)).targetBlockTime));
            [tip] = (await get(`/api/blocks?limit=1&${q(path)}`)).blocks ?? [];
          } catch (e) { if (e.status !== 404) throw e; }
          const at = tip ? Math.max(Number(tip.timestamp), made.get(path) ?? 0) + blockTimes.get(path) : (made.get(path) ?? 0) + (blockTimes.get(path) ?? 0);
          if (at <= now) due.push(path);
          else next = Math.min(next, at - now);
        }
        if (due.length) {
          const got = await round(due);
          // After a miss, the chain waits a whole target block time.
          next = got === "hit" ? 0 : got === "miss" ? Math.min(...due.map((p) => blockTimes.get(p) ?? 10_000)) : 10_000;
          if (got === "miss") for (const p of due) made.set(p, Date.now());
        }
      } catch (e) { say(`pacer: ${e.message}`); }
      if (!stopped) await sleep(Math.max(idle, Math.min(next, 60_000)));
    }
  })();
  return { stop: () => { stopped = true; wake?.(); }, done };
}
