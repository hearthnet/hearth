// Child-chain genesis built in the browser exactly as lattice-node builds it.
//
//   const { buildChildGenesis } = await loadGenesis(new URL("./lattice_genesis.wasm", import.meta.url));
//   const { cid, volumes } = buildChildGenesis({ spec, chainPath, premineTo, genesisTransactions, parentStateCID, timestamp });
//
// `volumes` maps each Volume root CID to its archive, byte-identical to what a
// node serves at GET /volumes/<cid>. Throws Error with the builder's reason.

/** @param {URL | string | Response | BufferSource | WebAssembly.Module} source */
export async function loadGenesis(source) {
  let instance;
  if (source instanceof WebAssembly.Module) {
    instance = await WebAssembly.instantiate(source, {});
  } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    ({ instance } = await WebAssembly.instantiate(source, {}));
  } else {
    const response = source instanceof Response ? source : await fetch(source);
    if (!response.ok) throw new Error(`genesis wasm: HTTP ${response.status}`);
    ({ instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {}));
  }
  const wasm = instance.exports;

  function buildChildGenesis(input) {
    const json = JSON.stringify(input, (_, value) => (typeof value === "bigint" ? value.toString() : value));
    const bytes = new TextEncoder().encode(json);
    const inputPointer = wasm.genesis_alloc(bytes.length);
    new Uint8Array(wasm.memory.buffer, inputPointer, bytes.length).set(bytes);
    const framePointer = wasm.build_child_genesis_json(inputPointer, bytes.length);
    wasm.genesis_free(inputPointer, bytes.length);
    const length = new DataView(wasm.memory.buffer, framePointer, 4).getUint32(0);
    const frame = new Uint8Array(wasm.memory.buffer, framePointer, length).slice();
    wasm.genesis_free(framePointer, length);

    const view = new DataView(frame.buffer);
    const text = new TextDecoder("utf-8", { fatal: true });
    if (frame[4] !== 0) throw new Error(text.decode(frame.subarray(5)));
    let offset = 5;
    const string = () => {
      const size = view.getUint16(offset);
      offset += 2;
      return text.decode(frame.subarray(offset, (offset += size)));
    };
    const cid = string();
    const count = view.getUint16(offset);
    offset += 2;
    const volumes = {};
    for (let index = 0; index < count; index += 1) {
      const root = string();
      const size = view.getUint32(offset);
      offset += 4;
      volumes[root] = frame.slice(offset, (offset += size));
    }
    return { cid, volumes };
  }

  return { buildChildGenesis };
}
