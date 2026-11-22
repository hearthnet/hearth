// A check's answer, kept for `ttl` ms and shared by everyone who asks while
// it runs. A check that throws, or whose `signal` aborts (the view that asked
// went away), is not kept: the next ask runs it again.
export function once({ ttl = 300_000, now = () => Date.now() } = {}) {
  const kept = new Map();
  return (key, check, signal) => {
    const hit = kept.get(key);
    if (hit && now() - hit.at < ttl) return hit.result;
    const entry = { at: now() };
    const drop = () => { if (kept.get(key) === entry) kept.delete(key); };
    signal?.addEventListener("abort", drop, { once: true });
    // Once settled, the answer no longer depends on the view that asked.
    const settle = () => signal?.removeEventListener("abort", drop);
    entry.result = Promise.resolve().then(check).then((v) => { settle(); if (signal?.aborted) drop(); return v; }, (e) => { settle(); drop(); throw e; });
    kept.set(key, entry);
    return entry.result;
  };
}
