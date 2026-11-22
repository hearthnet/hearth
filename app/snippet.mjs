// What the "Use it" panel offers to copy: one page that writes to a launched
// chain and reads the write back, through the browser SDK at `sdkURL`.

/**
 * The key the snippet writes: under the "own keys" rules it must end with the
 * writer's address; under the others any new key will do.
 */
const snippetKey = (ownKeys) => (ownKeys ? "`hello/${db.address}`" : "`hello/${Date.now()}`");

/** JSON that can't end the script it sits in: `<`, `>` and `&` as escapes. */
const inScript = (value) => JSON.stringify(value).replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** A complete page for `chain`, read from `node`, its fees paid by `sponsors`. */
export function snippet({ sdkURL, chain, node, sponsors, ownKeys }) {
  return `<!doctype html>
<script type="module">
  import { connect } from ${inScript(sdkURL)};

  const db = await connect({
    chain: ${inScript(chain)},
    node: ${inScript(node)},
    sponsors: ${inScript(sponsors)},
  });
  const key = ${snippetKey(ownKeys)};
  await db.set(key, "Hello from my page");
  document.body.textContent = await db.get(key);
</script>
`;
}
