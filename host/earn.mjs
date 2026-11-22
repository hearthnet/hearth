// `hearth earn`: earns market coin for the seller's address with this
// machine's processor, through a fee sponsor's payouts (lattice-sponsor
// `--payout-at`): `POST /work` naming `payTo`, each share back through
// `POST /shares`, and the sponsor pays the address once its earnings reach
// the payout (`GET /earnings`). Nothing here signs anything.
import { Worker } from "node:worker_threads";

export const DEFAULT_SPONSOR = "https://lattice-testnet-apps-iad.fly.dev:8650/sponsor";

// One worker: payout work, ground with the SDK, each share handed back. A
// 429 waits its Retry-After, else a backoff that doubles to 30 s.
const WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
(async () => {
  const sdk = await import(workerData.sdk);
  const { sponsor, chain, payTo } = workerData;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let backoff = 500;
  const post = async (path, body) => {
    for (;;) {
      const r = await fetch(sponsor + "/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const text = await r.text();
      if (r.status === 429) {
        const s = Number(r.headers.get("Retry-After"));
        await sleep(Number.isFinite(s) && s >= 0 && r.headers.get("Retry-After") !== null ? s * 1000 : backoff);
        backoff = Math.min(30000, backoff * 2);
        continue;
      }
      backoff = 500;
      if (!r.ok) throw new Error(path + ": " + r.status + " " + text.slice(0, 160));
      return JSON.parse(text);
    }
  };
  for (;;) {
    try {
      const w = await post("work", { chain, payTo });
      const ms = Number(w.expiresInMilliseconds ?? 60000);
      const range = { prefixHex: w.prefixHex, shareTarget: BigInt("0x" + w.shareTarget), startNonce: BigInt(w.startNonce), count: BigInt(w.count), expiresAt: Date.now() + ms };
      for await (const nonce of sdk.grind(range, AbortSignal.timeout(ms))) {
        const r = await post("shares", { assignment: w.assignment, nonce: String(nonce) });
        parentPort.postMessage({ credit: r.credit });
      }
    } catch (e) {
      if (e.name !== "TimeoutError" && e.name !== "AbortError") { parentPort.postMessage({ error: e.message.slice(0, 200) }); await sleep(5000); }
    }
  }
})();`;

/**
 * Works for `sponsor` with `workers` threads until `balance()` (the
 * address's coin on `chain`, or undefined while it cannot be read) reaches
 * `until`, saying what the sponsor's book holds as it changes.
 */
export async function earn({ sponsor, chain, payTo, workers = 1, until, balance, log = console.log, every = 15_000, fetchImpl = (...a) => fetch(...a) }) {
  const threads = Array.from({ length: workers }, () => new Worker(WORKER, { eval: true,
    workerData: { sdk: new URL("../vendor/lattice-sdk.js", import.meta.url).href, sponsor: sponsor.replace(/\/$/, ""), chain, payTo } }));
  let lastError, said;
  for (const t of threads) t.on("message", (m) => { if (m.error && m.error !== lastError) log(`sponsor: ${(lastError = m.error)}`); });
  try {
    for (;;) {
      const have = await balance().catch(() => undefined);
      if (have !== undefined && have >= until) return have;
      let book = "";
      try {
        const e = await (await fetchImpl(`${sponsor.replace(/\/$/, "")}/earnings?chain=${encodeURIComponent(chain)}&address=${payTo}`, { signal: AbortSignal.timeout(every) })).json();
        book = `; earned ${e.earned} of the ${e.payoutAt} a payout needs${e.paying ? ", paying now" : BigInt(e.earned) >= BigInt(e.payoutAt) ? " (the sponsor pays once it has the coin)" : ""}`;
      } catch {}
      const line = `${have === undefined ? "balance unknown until the node has synced" : `${have} of ${until} on ${chain}`}${book}`;
      if (line !== said) log((said = line));
      await new Promise((r) => setTimeout(r, every));
    }
  } finally {
    await Promise.all(threads.map((t) => t.terminate()));
  }
}
