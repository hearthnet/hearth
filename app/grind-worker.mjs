// Hashes one slice of the fee sponsor's payout work for the page, which asks
// the sponsor for work and hands back shares itself, one request at a time
// (app.mjs, `earn`). Each message is a new slice, or "stop"; the worker posts
// every nonce that meets the share target, then `done` when the slice is used
// up or expires. Nothing here signs anything or talks to the network.
import { grind } from "../vendor/lattice-sdk.js";

let current = null;
onmessage = async ({ data }) => {
  current?.abort();
  current = null;
  if (data === "stop") return;
  const job = (current = new AbortController());
  const { id, prefixHex, shareTarget, startNonce, count, expiresAt } = data;
  const range = { prefixHex, shareTarget: BigInt(`0x${shareTarget}`), startNonce: BigInt(startNonce), count: BigInt(count), expiresAt };
  try {
    for await (const nonce of grind(range, job.signal)) postMessage({ id, nonce: String(nonce) });
  } catch (e) {
    if (e.name !== "AbortError") postMessage({ id, error: e.message });
  }
  if (!job.signal.aborted) postMessage({ id, done: true });
};
