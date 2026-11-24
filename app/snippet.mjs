// What the "Use it" panel offers to copy: one page that writes to a launched
// chain and reads the write back, through the browser SDK at `sdkURL`. Reads
// are walked back to a pinned block (the chain's genesis, or a recent block
// on a longer chain: app/anchor.mjs) and, with several hosts' nodes, read
// only from a block two of them hold.

/**
 * The key the snippet writes: under the "own keys" rules it must end with the
 * writer's address; under the others any new key will do.
 */
const snippetKey = (ownKeys) => (ownKeys ? "`hello/${db.address}`" : "`hello/${Date.now()}`");

/** JSON that can't end the script it sits in: `<`, `>` and `&` as escapes. */
const inScript = (value) => JSON.stringify(value).replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** The snippet's pin: `anchor` is `{ genesis }` or `{ checkpoint, height }` (app/anchor.mjs). */
const pin = (anchor) => anchor.checkpoint !== undefined
  ? `// Every read is walked back to block ${anchor.height}, which your hosts' nodes
    // held when this was copied. Refresh it when you redeploy, about every
    // 2,000 blocks: further past it, reads fail "tooFar".
    checkpoint: ${inScript(anchor.checkpoint)},`
  : `// Every read is walked back to this block, the chain's genesis.
    genesis: ${inScript(anchor.genesis)},`;

/**
 * A complete page for `chain`, its reads pinned to `anchor`, read from
 * `nodes` (the first takes the writes). Fees are paid by `sponsors` when
 * given; with none, the writing key pays them in the chain's coin.
 */
export function snippet({ sdkURL, chain, anchor, nodes, sponsors = [], ownKeys }) {
  return `<!doctype html>
<script type="module">
  import { connect } from ${inScript(sdkURL)};

  const db = await connect({
    chain: ${inScript(chain)},
    ${pin(anchor)}
    ${nodes.length > 1 ? `// A block is read only once two of these nodes hold it, so a read fails
    // "disagree" while one of two is down. minAgree: 1 reads from whichever
    // answers, but then trusts that one node to name the chain's tip.
    // minAgree: 1,` : "// Reads trust this one node; add other hosts' nodes to check it."}
    node: ${inScript(nodes)},
    ${sponsors.length ? `sponsors: ${inScript(sponsors)},` : `// Writes pay their fee in this chain's coin, from the writing key: give
    // key: (a key holding some, like your premine), or add sponsors: [...].`}
  });
  const key = ${snippetKey(ownKeys)};
  await db.set(key, "Hello from my page");
  document.body.textContent = await db.get(key);
</script>
`;
}
