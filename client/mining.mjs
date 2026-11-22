// What a chain's own blocks say about who mines it: each block credits its
// reward to `rewardRecipient` and proves 2^256 / (target + 1) hashes of work
// on average. Read from the buyer's own node, which checked every block's
// work, target and recipient; a host's `mines` line is only its claim.

/** The expected hashes behind a block at `target` (a BigInt, or the node's `0x…` hex). */
export const workOf = (target) => (1n << 256n) / (BigInt(target) + 1n);

/**
 * Work per recipient over the window `from` < timestamp <= `to` (ms), and as
 * hashes per second: `{ seconds, total, totalRate, work: Map, rate: Map }`.
 * `blocks` are `{ target, rewardRecipient, timestamp }`; a block with no
 * recipient (its reward burned) counts in the total only. Without `from` and
 * `to` the window runs from the oldest block's timestamp to the newest's, so
 * the oldest block's work, done before the window opened, is left out.
 */
export function creditedHashrate(blocks, { from, to } = {}) {
  const times = blocks.map((b) => Number(b.timestamp));
  from ??= Math.min(...times);
  to ??= Math.max(...times);
  const work = new Map();
  let total = 0n;
  for (const b of blocks) {
    const t = Number(b.timestamp);
    if (t <= from || t > to) continue;
    const w = workOf(b.target);
    total += w;
    if (b.rewardRecipient) work.set(b.rewardRecipient, (work.get(b.rewardRecipient) ?? 0n) + w);
  }
  const ms = BigInt(Math.max(0, Math.round(to - from)));
  const perSecond = (w) => (ms > 0n ? (w * 1000n) / ms : 0n);
  return { seconds: Number(ms) / 1000, total, totalRate: perSecond(total), work, rate: new Map([...work].map(([a, w]) => [a, perSecond(w)])) };
}

const UNITS = ["", "k", "M", "G", "T", "P", "E"];

/** Hashes per second for people: `1.25 TH/s`. */
export function formatRate(rate) {
  let unit = 0, scaled = BigInt(rate) * 100n;
  while (scaled >= 100_000n && unit < UNITS.length - 1) { scaled /= 1000n; unit++; }
  const whole = scaled / 100n, cents = scaled % 100n;
  return `${whole}${cents ? `.${String(cents).padStart(2, "0").replace(/0$/, "")}` : ""} ${UNITS[unit]}H/s`;
}
