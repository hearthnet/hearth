/*! Lattice SDK, browser build | MIT License | Copyright (c) 2026 The Lattice Authors | Includes @noble/hashes and @noble/ed25519, MIT License, Copyright (c) Paul Miller */

// ../../node_modules/@noble/hashes/_u64.js
var U32_MASK64 = /* @__PURE__ */ (() => BigInt(2 ** 32 - 1))();
var _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE) {
  const h = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE ? l : h, isLE);
  view.setUint32(byteOffset + 4, isLE ? h : l, isLE);
}
var shrSH = (h, _l, s) => h >>> s;
var shrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrSH = (h, l, s) => h >>> s | l << 32 - s;
var rotrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
}
var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;

// ../../node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === void 0 || value.length === length))
    return value;
  if (length !== void 0)
    anumber(length, "length");
  const bytes = isBytes(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label) => {
  aobject(value, label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function checkOpts(defaults, opts, title = "opts") {
  aopts(defaults, "defaults");
  if (opts !== void 0)
    aopts(opts, title);
  const merged = Object.assign(/* @__PURE__ */ Object.create(null), defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
var oidNist = (suffix) => ({
  // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
  // Larger suffix values would need base-128 OID encoding and a different length byte.
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// ../../node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class {
  blockLen;
  outputLen;
  canXOF = false;
  padOffset;
  isLE;
  // For partial updates less than block size
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed)
      this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var SHA512_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  4089235720,
  3144134277,
  2227873595,
  1013904242,
  4271175723,
  2773480762,
  1595750129,
  1359893119,
  2917565137,
  2600822924,
  725511199,
  528734635,
  4215389547,
  1541459225,
  327033209
]);

// ../../node_modules/@noble/hashes/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA2_32B = class extends HashMD {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  // Numeric initializers matter: starting the fields as `undefined` changes
  // V8's field representation and makes sha256 3x slower (measured).
  A = 0;
  B = 0;
  C = 0;
  D = 0;
  E = 0;
  F = 0;
  G = 0;
  H = 0;
  constructor(outputLen, IV) {
    super(64, outputLen, 8, false);
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G: G2, H } = this;
    return [A, B, C, D, E, F, G2, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G2, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G2 | 0;
    this.H = H | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor()).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G: G2, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G2) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G2;
      G2 = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G2 = G2 + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G2, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.destroyed = true;
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var _SHA256 = class extends SHA2_32B {
  constructor() {
    super(32, SHA256_IV);
  }
};
var K512 = /* @__PURE__ */ (() => split([
  "0x428a2f98d728ae22",
  "0x7137449123ef65cd",
  "0xb5c0fbcfec4d3b2f",
  "0xe9b5dba58189dbbc",
  "0x3956c25bf348b538",
  "0x59f111f1b605d019",
  "0x923f82a4af194f9b",
  "0xab1c5ed5da6d8118",
  "0xd807aa98a3030242",
  "0x12835b0145706fbe",
  "0x243185be4ee4b28c",
  "0x550c7dc3d5ffb4e2",
  "0x72be5d74f27b896f",
  "0x80deb1fe3b1696b1",
  "0x9bdc06a725c71235",
  "0xc19bf174cf692694",
  "0xe49b69c19ef14ad2",
  "0xefbe4786384f25e3",
  "0x0fc19dc68b8cd5b5",
  "0x240ca1cc77ac9c65",
  "0x2de92c6f592b0275",
  "0x4a7484aa6ea6e483",
  "0x5cb0a9dcbd41fbd4",
  "0x76f988da831153b5",
  "0x983e5152ee66dfab",
  "0xa831c66d2db43210",
  "0xb00327c898fb213f",
  "0xbf597fc7beef0ee4",
  "0xc6e00bf33da88fc2",
  "0xd5a79147930aa725",
  "0x06ca6351e003826f",
  "0x142929670a0e6e70",
  "0x27b70a8546d22ffc",
  "0x2e1b21385c26c926",
  "0x4d2c6dfc5ac42aed",
  "0x53380d139d95b3df",
  "0x650a73548baf63de",
  "0x766a0abb3c77b2a8",
  "0x81c2c92e47edaee6",
  "0x92722c851482353b",
  "0xa2bfe8a14cf10364",
  "0xa81a664bbc423001",
  "0xc24b8b70d0f89791",
  "0xc76c51a30654be30",
  "0xd192e819d6ef5218",
  "0xd69906245565a910",
  "0xf40e35855771202a",
  "0x106aa07032bbd1b8",
  "0x19a4c116b8d2d0c8",
  "0x1e376c085141ab53",
  "0x2748774cdf8eeb99",
  "0x34b0bcb5e19b48a8",
  "0x391c0cb3c5c95a63",
  "0x4ed8aa4ae3418acb",
  "0x5b9cca4f7763e373",
  "0x682e6ff3d6b2b8a3",
  "0x748f82ee5defb2fc",
  "0x78a5636f43172f60",
  "0x84c87814a1f0ab72",
  "0x8cc702081a6439ec",
  "0x90befffa23631e28",
  "0xa4506cebde82bde9",
  "0xbef9a3f7b2c67915",
  "0xc67178f2e372532b",
  "0xca273eceea26619c",
  "0xd186b8c721c0c207",
  "0xeada7dd6cde0eb1e",
  "0xf57d4f7fee6ed178",
  "0x06f067aa72176fba",
  "0x0a637dc5a2c898a6",
  "0x113f9804bef90dae",
  "0x1b710b35131c471b",
  "0x28db77f523047d84",
  "0x32caab7b40c72493",
  "0x3c9ebe0a15c9bebc",
  "0x431d67c49c100d4c",
  "0x4cc5d4becb3e42b6",
  "0x597f299cfc657e2a",
  "0x5fcb6fab3ad6faec",
  "0x6c44198c4a475817"
].map((n) => BigInt(n))))();
var SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
var SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
var SHA2_64B = class extends HashMD {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  // h -- high 32 bits, l -- low 32 bits
  // Numeric initializers matter: starting the fields as `undefined` changes
  // V8's field representation and slows hashing down (measured on sha256).
  Ah = 0;
  Al = 0;
  Bh = 0;
  Bl = 0;
  Ch = 0;
  Cl = 0;
  Dh = 0;
  Dl = 0;
  Eh = 0;
  El = 0;
  Fh = 0;
  Fl = 0;
  Gh = 0;
  Gl = 0;
  Hh = 0;
  Hl = 0;
  constructor(outputLen, IV) {
    super(128, outputLen, 16, false);
    this.Ah = IV[0] | 0;
    this.Al = IV[1] | 0;
    this.Bh = IV[2] | 0;
    this.Bl = IV[3] | 0;
    this.Ch = IV[4] | 0;
    this.Cl = IV[5] | 0;
    this.Dh = IV[6] | 0;
    this.Dl = IV[7] | 0;
    this.Eh = IV[8] | 0;
    this.El = IV[9] | 0;
    this.Fh = IV[10] | 0;
    this.Fl = IV[11] | 0;
    this.Gh = IV[12] | 0;
    this.Gl = IV[13] | 0;
    this.Hh = IV[14] | 0;
    this.Hl = IV[15] | 0;
  }
  // prettier-ignore
  get() {
    const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
  }
  // prettier-ignore
  set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
    this.Ah = Ah | 0;
    this.Al = Al | 0;
    this.Bh = Bh | 0;
    this.Bl = Bl | 0;
    this.Ch = Ch | 0;
    this.Cl = Cl | 0;
    this.Dh = Dh | 0;
    this.Dl = Dl | 0;
    this.Eh = Eh | 0;
    this.El = El | 0;
    this.Fh = Fh | 0;
    this.Fl = Fl | 0;
    this.Gh = Gh | 0;
    this.Gl = Gl | 0;
    this.Hh = Hh | 0;
    this.Hl = Hl | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor()).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4) {
      SHA512_W_H[i] = view.getUint32(offset);
      SHA512_W_L[i] = view.getUint32(offset += 4);
    }
    for (let i = 16; i < 80; i++) {
      const W15h = SHA512_W_H[i - 15] | 0;
      const W15l = SHA512_W_L[i - 15] | 0;
      const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
      const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
      const W2h = SHA512_W_H[i - 2] | 0;
      const W2l = SHA512_W_L[i - 2] | 0;
      const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
      const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
      const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
      const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
      SHA512_W_H[i] = SUMh | 0;
      SHA512_W_L[i] = SUMl | 0;
    }
    let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    for (let i = 0; i < 80; i++) {
      const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
      const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
      const CHIh = Eh & Fh ^ ~Eh & Gh;
      const CHIl = El & Fl ^ ~El & Gl;
      const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
      const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
      const T1l = T1ll | 0;
      const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
      const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
      const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
      const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
      Hh = Gh | 0;
      Hl = Gl | 0;
      Gh = Fh | 0;
      Gl = Fl | 0;
      Fh = Eh | 0;
      Fl = El | 0;
      ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
      Dh = Ch | 0;
      Dl = Cl | 0;
      Ch = Bh | 0;
      Cl = Bl | 0;
      Bh = Ah | 0;
      Bl = Al | 0;
      const All = add3L(T1l, sigma0l, MAJl);
      Ah = add3H(All, T1h, sigma0h, MAJh);
      Al = All | 0;
    }
    ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
    ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
    ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
    ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
    ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
    ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
    ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
    ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
    this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
  }
  roundClean() {
    clean(SHA512_W_H, SHA512_W_L);
  }
  destroy() {
    this.destroyed = true;
    clean(this.buffer);
    this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
};
var _SHA512 = class extends SHA2_64B {
  constructor() {
    super(64, SHA512_IV);
  }
};
var sha256 = /* @__PURE__ */ createHasher(
  () => new _SHA256(),
  /* @__PURE__ */ oidNist(1)
);
var sha512 = /* @__PURE__ */ createHasher(
  () => new _SHA512(),
  /* @__PURE__ */ oidNist(3)
);

// ../core/dist/bytes.js
function hexToBytes(hex) {
  const clean2 = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^(?:[0-9a-f]{2})*$/.test(clean2)) {
    throw new Error("hex must be lowercase and contain complete bytes");
  }
  const output = new Uint8Array(clean2.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(clean2.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}
function bytesToHex(bytes) {
  let output = "";
  for (const byte of bytes)
    output += byte.toString(16).padStart(2, "0");
  return output;
}
function utf8(value) {
  return new TextEncoder().encode(value);
}
function concatBytes(...arrays) {
  const output = new Uint8Array(arrays.reduce((total, array3) => total + array3.length, 0));
  let offset = 0;
  for (const array3 of arrays) {
    output.set(array3, offset);
    offset += array3.length;
  }
  return output;
}
function equalBytes(left, right) {
  if (left.length !== right.length)
    return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

// ../core/dist/cid.js
var BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
var CID_VERSION = 1;
var DAG_CBOR_CODEC = 113;
var IDENTITY_HASH = 0;
var SHA2_256_HASH = 18;
function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = value << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[value >>> bits - 5 & 31];
      bits -= 5;
    }
  }
  if (bits > 0)
    output += BASE32[value << 5 - bits & 31];
  return output;
}
function base32Decode(value) {
  if (!/^[a-z2-7]+$/.test(value))
    throw new Error("CID base32 must be lowercase and unpadded");
  const output = [];
  let bits = 0;
  let accumulator = 0;
  for (const character of value) {
    const digit = BASE32.indexOf(character);
    accumulator = accumulator << 5 | digit;
    bits += 5;
    if (bits >= 8) {
      output.push(accumulator >>> bits - 8 & 255);
      bits -= 8;
    }
  }
  if (bits > 0 && (accumulator & (1 << bits) - 1) !== 0) {
    throw new Error("CID base32 has non-zero trailing bits");
  }
  return Uint8Array.from(output);
}
function encodeVarint(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("invalid CID varint");
  const output = [];
  let remaining = value;
  while (remaining >= 128) {
    output.push(remaining % 128 | 128);
    remaining = Math.floor(remaining / 128);
  }
  output.push(remaining);
  return Uint8Array.from(output);
}
function decodeVarint(bytes, start) {
  let value = 0;
  let multiplier = 1;
  let offset = start;
  while (true) {
    const byte = bytes[offset];
    if (byte === void 0 || offset - start >= 9)
      throw new Error("invalid CID varint");
    value += (byte & 127) * multiplier;
    if (!Number.isSafeInteger(value))
      throw new Error("CID varint is too large");
    offset += 1;
    if ((byte & 128) === 0)
      break;
    multiplier *= 128;
  }
  if (!equalBytes(bytes.slice(start, offset), encodeVarint(value))) {
    throw new Error("CID contains a non-canonical varint");
  }
  return { value, end: offset };
}
function parseCID(cid) {
  if (!cid.startsWith("b"))
    throw new Error("CID must use lowercase base32 multibase");
  const bytes = base32Decode(cid.slice(1));
  if (`b${base32Encode(bytes)}` !== cid)
    throw new Error("CID is not canonical");
  const version = decodeVarint(bytes, 0);
  if (version.value !== CID_VERSION)
    throw new Error("only canonical CIDv1 is supported");
  const codec = decodeVarint(bytes, version.end);
  const algorithm = decodeVarint(bytes, codec.end);
  const length = decodeVarint(bytes, algorithm.end);
  const digest = bytes.slice(length.end);
  if (digest.length === 0 || digest.length !== length.value) {
    throw new Error("CID multihash length does not match its digest");
  }
  return {
    version: 1,
    codec: codec.value,
    multihashCode: algorithm.value,
    digest,
    bytes
  };
}
function cidV1(codec, blockBytes) {
  const digest = sha256(blockBytes);
  return `b${base32Encode(concatBytes(encodeVarint(CID_VERSION), encodeVarint(codec), encodeVarint(SHA2_256_HASH), encodeVarint(digest.length), digest))}`;
}
function cidV1DagCbor(blockBytes) {
  return cidV1(DAG_CBOR_CODEC, blockBytes);
}
function dagCborCIDBytes(cid) {
  const parsed = parseCID(cid);
  if (parsed.codec !== DAG_CBOR_CODEC || parsed.multihashCode !== SHA2_256_HASH || parsed.digest.length !== 32) {
    throw new Error("CID must be CIDv1 dag-cbor with a sha2-256 multihash");
  }
  return parsed.bytes;
}
function verifyCID(cid, content) {
  try {
    const parsed = parseCID(cid);
    if (parsed.multihashCode === IDENTITY_HASH)
      return equalBytes(parsed.digest, content);
    if (parsed.multihashCode === SHA2_256_HASH && parsed.digest.length === 32) {
      return equalBytes(parsed.digest, sha256(content));
    }
    return false;
  } catch {
    return false;
  }
}
function assertCID(cid, content) {
  if (!verifyCID(cid, content))
    throw new Error(`content does not match CID ${cid}`);
}
function verifyDagCborCID(cid, blockBytes) {
  try {
    dagCborCIDBytes(cid);
    return verifyCID(cid, blockBytes);
  } catch {
    return false;
  }
}
function assertDagCborCID(cid, blockBytes) {
  if (!verifyDagCborCID(cid, blockBytes)) {
    throw new Error(`content does not match CID ${cid}`);
  }
}

// ../core/dist/dag-cbor.js
function unsigned(value, major) {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error("DAG-CBOR integer is outside the 64-bit range");
  }
  const prefix = major << 5;
  if (value < 24n)
    return Uint8Array.of(prefix | Number(value));
  if (value <= 0xffn)
    return Uint8Array.of(prefix | 24, Number(value));
  if (value <= 0xffffn) {
    return Uint8Array.of(prefix | 25, Number(value >> 8n), Number(value & 0xffn));
  }
  if (value <= 0xffffffffn) {
    return Uint8Array.of(prefix | 26, Number(value >> 24n & 0xffn), Number(value >> 16n & 0xffn), Number(value >> 8n & 0xffn), Number(value & 0xffn));
  }
  const output = new Uint8Array(9);
  output[0] = prefix | 27;
  let remaining = value;
  for (let index = 8; index >= 1; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}
function integer(value) {
  return value >= 0n ? unsigned(value, 0) : unsigned(-1n - value, 1);
}
function compareMapKeys(left, right) {
  const leftBytes = utf8(left);
  const rightBytes = utf8(right);
  if (leftBytes.length !== rightBytes.length)
    return leftBytes.length - rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    if (leftBytes[index] !== rightBytes[index])
      return leftBytes[index] - rightBytes[index];
  }
  return 0;
}
function encodeDagCbor(value) {
  if (value === null)
    return Uint8Array.of(246);
  if (typeof value === "boolean")
    return Uint8Array.of(value ? 245 : 244);
  if (typeof value === "bigint")
    return integer(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("DAG-CBOR numbers must be safe integers");
    return integer(BigInt(value));
  }
  if (typeof value === "string") {
    const bytes = utf8(value);
    return concatBytes(unsigned(BigInt(bytes.length), 3), bytes);
  }
  if (value instanceof Uint8Array) {
    return concatBytes(unsigned(BigInt(value.length), 2), value);
  }
  if (Array.isArray(value)) {
    return concatBytes(unsigned(BigInt(value.length), 4), ...value.map((entry) => encodeDagCbor(entry)));
  }
  const record3 = value;
  const keys = Object.keys(record3).sort(compareMapKeys);
  const parts = [unsigned(BigInt(keys.length), 5)];
  for (const key of keys) {
    parts.push(encodeDagCbor(key), encodeDagCbor(record3[key]));
  }
  return concatBytes(...parts);
}
var Decoder = class {
  #bytes;
  #offset = 0;
  constructor(bytes) {
    this.#bytes = bytes;
  }
  get finished() {
    return this.#offset === this.#bytes.length;
  }
  #take() {
    const byte = this.#bytes[this.#offset];
    if (byte === void 0)
      throw new Error("truncated DAG-CBOR value");
    this.#offset += 1;
    return byte;
  }
  #argument(additional) {
    if (additional < 24)
      return BigInt(additional);
    const length = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
    if (length === 0)
      throw new Error("indefinite or reserved DAG-CBOR length");
    let value = 0n;
    for (let index = 0; index < length; index += 1)
      value = value << 8n | BigInt(this.#take());
    const minimum = length === 1 ? 24n : 1n << BigInt(8 * (length / 2));
    if (value < minimum)
      throw new Error("non-canonical DAG-CBOR integer or length");
    return value;
  }
  #length(value) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("DAG-CBOR collection is too large");
    return Number(value);
  }
  decode() {
    const initial = this.#take();
    const major = initial >> 5;
    const additional = initial & 31;
    if (major === 7) {
      if (additional === 20)
        return false;
      if (additional === 21)
        return true;
      if (additional === 22)
        return null;
      throw new Error("DAG-CBOR floats and unsupported simple values are forbidden");
    }
    const argument = this.#argument(additional);
    if (major === 0)
      return argument;
    if (major === 1)
      return -1n - argument;
    if (major === 2 || major === 3) {
      const length = this.#length(argument);
      const end = this.#offset + length;
      if (end > this.#bytes.length)
        throw new Error("truncated DAG-CBOR bytes or string");
      const bytes = this.#bytes.slice(this.#offset, end);
      this.#offset = end;
      if (major === 2)
        return bytes;
      try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new Error("invalid UTF-8 in DAG-CBOR string");
      }
    }
    if (major === 4) {
      const output = [];
      for (let index = 0; index < this.#length(argument); index += 1)
        output.push(this.decode());
      return output;
    }
    if (major === 5) {
      const output = /* @__PURE__ */ Object.create(null);
      let previous;
      for (let index = 0; index < this.#length(argument); index += 1) {
        const key = this.decode();
        if (typeof key !== "string")
          throw new Error("DAG-CBOR map keys must be strings");
        if (previous !== void 0 && compareMapKeys(previous, key) >= 0) {
          throw new Error("DAG-CBOR map keys are duplicated or out of canonical order");
        }
        Object.defineProperty(output, key, {
          value: this.decode(),
          enumerable: true,
          writable: true,
          configurable: true
        });
        previous = key;
      }
      return output;
    }
    throw new Error(`unsupported DAG-CBOR major type ${major}`);
  }
};
function decodeDagCbor(bytes) {
  const decoder2 = new Decoder(bytes);
  const value = decoder2.decode();
  if (!decoder2.finished)
    throw new Error("trailing bytes after DAG-CBOR value");
  return value;
}

// ../core/dist/multikey.js
function encodeEd25519Multikey(publicKey) {
  if (publicKey.length !== 32)
    throw new Error("Ed25519 public key must be 32 bytes");
  return `ed01${bytesToHex(publicKey)}`;
}
function decodeEd25519Multikey(multikey) {
  const bytes = hexToBytes(multikey);
  if (bytes.length !== 34 || bytes[0] !== 237 || bytes[1] !== 1) {
    throw new Error("public key is not an Ed25519 Multikey");
  }
  return bytes.slice(2);
}

// ../core/dist/address.js
function addressFromMultikey(multikey) {
  return cidV1DagCbor(encodeDagCbor({ key: multikey }));
}
function addressFromPublicKey(publicKey) {
  return addressFromMultikey(encodeEd25519Multikey(publicKey));
}

// ../core/dist/canonical-values.js
function record(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) {
    throw new TypeError(`${name} must be a DAG-CBOR map`);
  }
  return value;
}
function string(value, name) {
  if (typeof value !== "string")
    throw new TypeError(`${name} must be a string`);
  return value;
}
function integer2(value, name) {
  if (typeof value !== "bigint")
    throw new TypeError(`${name} must be an integer`);
  return value;
}
function array(value, name) {
  if (!Array.isArray(value))
    throw new TypeError(`${name} must be a DAG-CBOR array`);
  return value;
}
function unsigned2(value, name, maximum = 0xffffffffffffffffn) {
  const decoded = integer2(value, name);
  if (decoded < 0n || decoded > maximum)
    throw new TypeError(`${name} is out of range`);
  return decoded;
}
function reference(value, name) {
  return string(record(value, name).rawCID, `${name}.rawCID`);
}
function decodeCanonicalBlock(bytes) {
  const block = record(decodeDagCbor(bytes), "Block");
  const version = unsigned2(block.version, "Block.version", 0xffffn);
  const timestamp = integer2(block.timestamp, "Block.timestamp");
  if (timestamp < -0x8000000000000000n || timestamp > 0x7fffffffffffffffn) {
    throw new TypeError("Block.timestamp is out of range");
  }
  const parentCID = block.parent === void 0 ? void 0 : reference(block.parent, "Block.parent");
  const rewardRecipient = block.rewardRecipient === void 0 ? void 0 : string(block.rewardRecipient, "Block.rewardRecipient");
  return {
    version: Number(version),
    ...parentCID === void 0 ? {} : { parentCID },
    transactionsCID: reference(block.transactions, "Block.transactions"),
    target: string(block.target, "Block.target"),
    nextTarget: string(block.nextTarget, "Block.nextTarget"),
    specCID: reference(block.spec, "Block.spec"),
    parentStateCID: reference(block.parentState, "Block.parentState"),
    previousStateCID: reference(block.prevState, "Block.prevState"),
    postStateCID: reference(block.postState, "Block.postState"),
    childrenCID: reference(block.children, "Block.children"),
    height: unsigned2(block.height, "Block.height"),
    timestamp,
    ...rewardRecipient === void 0 ? {} : { rewardRecipient },
    nonce: unsigned2(block.nonce, "Block.nonce")
  };
}
function decodeCanonicalSignedTransaction(bytes) {
  const transaction = record(decodeDagCbor(bytes), "Transaction");
  let previousKey;
  const signatures = array(transaction.signatures, "Transaction.signatures").map((value, index) => {
    const signature = record(value, `Transaction.signatures[${index}]`);
    const publicKey = string(signature.key, `Transaction.signatures[${index}].key`);
    if (previousKey !== void 0 && previousKey >= publicKey) {
      throw new TypeError("Transaction signatures are duplicated or out of order");
    }
    previousKey = publicKey;
    return {
      publicKey,
      signature: string(signature.value, `Transaction.signatures[${index}].value`)
    };
  });
  return {
    bodyCID: reference(transaction.body, "Transaction.body"),
    signatures
  };
}
function decodeCanonicalLatticeState(bytes) {
  const state = record(decodeDagCbor(bytes), "LatticeState");
  return {
    accountStateCID: reference(state.accountState, "LatticeState.accountState"),
    generalStateCID: reference(state.generalState, "LatticeState.generalState"),
    depositStateCID: reference(state.depositState, "LatticeState.depositState"),
    receiptStateCID: reference(state.receiptState, "LatticeState.receiptState")
  };
}
function assertBlockContinuity(parentCID, parent, child) {
  if (child.parentCID !== parentCID)
    throw new Error("child does not commit to the parent block");
  if (child.height !== parent.height + 1n)
    throw new Error("child block height is not contiguous");
  if (child.previousStateCID !== parent.postStateCID) {
    throw new Error("child does not continue the parent's post-state");
  }
}
function targetInteger(target) {
  if (!/^0x[0-9a-f]{1,64}$/.test(target))
    throw new TypeError("Block target is not canonical hex");
  return BigInt(target);
}
function canonicalBlockProofOfWorkPreimage(block) {
  const separator = Uint8Array.of(0);
  const fields = [
    String(block.version),
    block.parentCID ?? "",
    block.transactionsCID,
    // UInt256 2.0.0's toHexString(), used by consensus: all 64 lower-case
    // hex digits, zero-padded, without the DAG-CBOR field's `0x` prefix.
    targetInteger(block.target).toString(16).padStart(64, "0"),
    targetInteger(block.nextTarget).toString(16).padStart(64, "0"),
    block.specCID,
    block.parentStateCID,
    block.previousStateCID,
    block.postStateCID,
    block.childrenCID,
    String(block.height),
    String(block.timestamp)
  ];
  const nonce = new Uint8Array(8);
  new DataView(nonce.buffer).setBigUint64(0, block.nonce);
  const recipient = block.rewardRecipient === void 0 ? separator : concatBytes(Uint8Array.of(1), utf8(block.rewardRecipient), separator);
  return concatBytes(...fields.flatMap((field) => [utf8(field), separator]), recipient, nonce);
}
function canonicalBlockProofOfWorkHash(block) {
  return sha256(canonicalBlockProofOfWorkPreimage(block));
}
function unsignedBigEndian(bytes) {
  let value = 0n;
  for (const byte of bytes)
    value = value << 8n | BigInt(byte);
  return value;
}
function verifyNexusBlockProofOfWork(block) {
  const target = targetInteger(block.target);
  return target > 0n && unsignedBigEndian(canonicalBlockProofOfWorkHash(block)) <= target;
}
function workForTarget(target) {
  const value = targetInteger(target);
  if (value === 0n)
    return 0n;
  const maximum = (1n << 256n) - 1n;
  if (value === maximum)
    return 1n;
  return (maximum - value) / (value + 1n) + 1n;
}

// ../../node_modules/@noble/ed25519/index.js
var freeze = Object.freeze;
var P = 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn;
var N = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn;
var _d = 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n;
var Gx = 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an;
var Gy = 0x6666666666666666666666666666666666666666666666666666666666666658n;
var _a = P - 1n;
var ed25519_CURVE = freeze({
  p: P,
  n: N,
  h: 8n,
  a: _a,
  d: _d,
  Gx,
  Gy
});
var LEN = 32;
var isBytes2 = (a) => {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && a.BYTES_PER_ELEMENT === 1;
};
var abytes2 = (value, length, title = "") => {
  if (isBytes2(value) && (length === void 0 || value.length === length))
    return value;
  const bytes = isBytes2(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = (title ? `"${title}" ` : "") + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
};
var snapshotBytes = (value, title = "", length) => Uint8Array.from(abytes2(value, length, title));
var padh = (n, pad) => n.toString(16).padStart(pad, "0");
var bytesToHex2 = (bytes) => {
  let hex = "";
  for (const byte of abytes2(bytes))
    hex += padh(byte, 2);
  return hex;
};
var hexToBytes2 = (hex) => {
  const e = "hex invalid";
  if (typeof hex !== "string")
    throw new TypeError(e);
  if (hex.length % 2 || !/^[\da-f]*$/i.test(hex))
    throw new RangeError(e);
  const array3 = new Uint8Array(hex.length / 2);
  for (let ai = 0, hi = 0; ai < array3.length; ai++, hi += 2) {
    const n1 = hex.charCodeAt(hi);
    const n2 = hex.charCodeAt(hi + 1);
    array3[ai] = ((n1 & 15) + (n1 >> 6) * 9) * 16 + (n2 & 15) + (n2 >> 6) * 9;
  }
  return array3;
};
var concatBytes2 = (...arrays) => {
  let sum = 0;
  for (const a of arrays)
    sum += abytes2(a).length;
  const res = new Uint8Array(sum);
  let pad = 0;
  for (const a of arrays) {
    res.set(a, pad);
    pad += a.length;
  }
  return res;
};
var randomBytes = (len = LEN) => {
  const c = globalThis?.crypto;
  if (typeof c?.getRandomValues !== "function")
    throw new Error("crypto.getRandomValues must be defined, consider polyfill");
  return c.getRandomValues(new Uint8Array(len));
};
var arange = (n, min, max, msg = "bad number: out of range") => {
  if (typeof n !== "bigint")
    throw new TypeError(msg);
  if (min <= n && n < max)
    return n;
  throw new RangeError(msg);
};
var mod = (a, b = P) => (a %= b) >= 0n ? a : b + a;
var P_MASK = (1n << 255n) - 1n;
var modP = (num) => {
  if (num < 0n)
    throw new RangeError("negative coordinate");
  let r = (num >> 255n) * 19n + (num & P_MASK);
  r = (r >> 255n) * 19n + (r & P_MASK);
  return r % P;
};
var modN = (a) => mod(a, N);
var invert = (number, modulo) => {
  if (number === 0n)
    throw new Error("invert: expected non-zero number");
  if (modulo <= 1n)
    throw new Error("invert: expected modulus > 1, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = 0n, u = 1n;
  while (a !== 0n) {
    const q = b / a;
    const r = b - a * q;
    const m = x - u * q;
    b = a, a = r, x = u, u = m;
  }
  const gcd = b;
  if (gcd !== 1n)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
};
var _hash = (name) => {
  const fn = hashes[name];
  if (typeof fn !== "function")
    throw new Error("hashes." + name + " not set");
  return fn;
};
var callHash = (name, ...m) => abytes2(_hash(name)(concatBytes2(...m)), 64, "digest");
var callHashAsync = async (name, ...m) => abytes2(await _hash(name)(concatBytes2(...m)), 64, "digest");
var apoint = (p) => {
  if (p instanceof Point)
    return p;
  throw new TypeError("Point expected");
};
var B256 = 2n ** 256n;
var Point = class _Point {
  static BASE;
  static ZERO;
  X;
  Y;
  Z;
  T;
  // Constructor only bounds-checks and freezes XYZT coordinates; it does not prove the point is
  // on-curve or that T matches X*Y/Z.
  constructor(X, Y, Z, T) {
    const max = B256;
    this.X = arange(X, 0n, max);
    this.Y = arange(Y, 0n, max);
    this.Z = arange(Z, 1n, max);
    this.T = arange(T, 0n, max);
    freeze(this);
  }
  static CURVE() {
    return ed25519_CURVE;
  }
  static fromAffine(p) {
    return new _Point(p.x, p.y, 1n, modP(p.x * p.y));
  }
  /** RFC8032 5.1.3: Uint8Array to Point. */
  static fromBytes(bytes, zip215 = false) {
    const normed = snapshotBytes(bytes, "point", LEN);
    const lastByte = normed[31];
    normed[31] = lastByte & ~128;
    const y = bytesToNumberLE(normed);
    if (!zip215)
      arange(y, 0n, P);
    const y2 = modP(y * y);
    const u = mod(y2 - 1n);
    const v = modP(_d * y2 + 1n);
    let { isValid, value: x } = uvRatio(u, v);
    if (!isValid)
      throw new Error("bad point: y not sqrt");
    const isLastByteOdd = !!(lastByte & 128);
    if (!zip215 && x === 0n && isLastByteOdd)
      throw new Error("bad point: x==0, isLastByteOdd");
    if (isLastByteOdd !== !!(x & 1n))
      x = mod(-x);
    return new _Point(x, y, 1n, modP(x * y));
  }
  static fromHex(hex, zip215) {
    return _Point.fromBytes(hexToBytes2(hex), zip215);
  }
  get x() {
    return this.toAffine().x;
  }
  get y() {
    return this.toAffine().y;
  }
  /** Checks if the point is valid and on-curve. */
  assertValidity() {
    const a = _a;
    const d = _d;
    const p = this;
    if (p.is0())
      throw new Error("bad point: ZERO");
    const { X, Y, Z, T } = p;
    const X2 = modP(X * X);
    const Y2 = modP(Y * Y);
    const Z2 = modP(Z * Z);
    const Z4 = modP(Z2 * Z2);
    const aX2 = modP(X2 * a);
    const left = modP(Z2 * (aX2 + Y2));
    const right = mod(Z4 + modP(d * modP(X2 * Y2)));
    if (left !== right)
      throw new Error("bad point: equation left != right (1)");
    const XY = modP(X * Y);
    const ZT = modP(Z * T);
    if (XY !== ZT)
      throw new Error("bad point: equation left != right (2)");
    return this;
  }
  /** Equality check: compare points P&Q. */
  equals(other) {
    const { X: X1, Y: Y1, Z: Z1 } = this;
    const { X: X2, Y: Y2, Z: Z2 } = apoint(other);
    return modP(X1 * Z2) === modP(X2 * Z1) && modP(Y1 * Z2) === modP(Y2 * Z1);
  }
  is0() {
    return this.equals(I);
  }
  /** Flip point over y coordinate. */
  negate() {
    return new _Point(mod(-this.X), this.Y, this.Z, mod(-this.T));
  }
  /** Point doubling. Complete formula. Cost: `4M + 4S + 1*a + 6add + 1*2`. */
  double() {
    const { X: X1, Y: Y1, Z: Z1 } = this;
    const a = _a;
    const A = modP(X1 * X1);
    const B = modP(Y1 * Y1);
    const C = modP(2n * Z1 * Z1);
    const D = modP(a * A);
    const x1y1 = mod(X1 + Y1);
    const E = mod(modP(x1y1 * x1y1) - A - B);
    const G2 = mod(D + B);
    const F = mod(G2 - C);
    const H = mod(D - B);
    const X3 = modP(E * F);
    const Y3 = modP(G2 * H);
    const T3 = modP(E * H);
    const Z3 = modP(F * G2);
    return new _Point(X3, Y3, Z3, T3);
  }
  /** Point addition. Complete formula. Cost: `9M + 1*a + 1*d + 7add`. */
  add(other) {
    const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
    const { X: X2, Y: Y2, Z: Z2, T: T2 } = apoint(other);
    const a = _a;
    const d = _d;
    const A = modP(X1 * X2);
    const B = modP(Y1 * Y2);
    const C = modP(modP(T1 * d) * T2);
    const D = modP(Z1 * Z2);
    const E = mod(modP(mod(X1 + Y1) * mod(X2 + Y2)) - A - B);
    const F = mod(D - C);
    const G2 = mod(D + C);
    const H = mod(B - modP(a * A));
    const X3 = modP(E * F);
    const Y3 = modP(G2 * H);
    const T3 = modP(E * H);
    const Z3 = modP(F * G2);
    return new _Point(X3, Y3, Z3, T3);
  }
  subtract(other) {
    return this.add(apoint(other).negate());
  }
  /**
   * Point-by-scalar multiplication. Safe mode requires `1 <= n < CURVE.n`.
   * Unsafe mode additionally permits `n = 0` and returns the identity point for that case.
   * Uses {@link wNAF} for base point.
   * Uses fake point to mitigate side-channel leakage.
   * @param n - scalar by which point is multiplied
   * @param safe - safe mode guards against timing attacks; unsafe mode is faster
   */
  multiply(n, safe = true) {
    if (!safe && n === 0n)
      return I;
    arange(n, 1n, N);
    if (!safe && this.is0())
      return I;
    if (n === 1n)
      return this;
    if (this.equals(G))
      return wNAF(n).p;
    let p = I;
    let f = G;
    let d = this;
    for (let i = 0; safe ? i < 256 : n > 0n; i++) {
      if (n & 1n)
        p = p.add(d);
      else if (safe)
        f = f.add(d);
      d = d.double();
      n >>= 1n;
    }
    return p;
  }
  multiplyUnsafe(scalar) {
    return this.multiply(scalar, false);
  }
  /** Convert point to 2d xy affine point. (X, Y, Z) ∋ (x=X/Z, y=Y/Z) */
  toAffine() {
    const { X, Y, Z } = this;
    if (this.equals(I))
      return { x: 0n, y: 1n };
    const iz = invert(Z, P);
    if (modP(Z * iz) !== 1n)
      throw new Error("invalid inverse");
    return { x: modP(X * iz), y: modP(Y * iz) };
  }
  toBytes() {
    const { x, y } = this.toAffine();
    const b = numTo32bLE(y);
    b[31] |= x & 1n ? 128 : 0;
    return b;
  }
  toHex() {
    return bytesToHex2(this.toBytes());
  }
  clearCofactor() {
    return this.multiply(8n, false);
  }
  isSmallOrder() {
    return this.clearCofactor().is0();
  }
  isTorsionFree() {
    return this.multiply(N / 2n, false).double().add(this).is0();
  }
};
var G = new Point(Gx, Gy, 1n, mod(Gx * Gy));
var I = new Point(0n, 1n, 1n, 0n);
Point.BASE = G;
Point.ZERO = I;
var numTo32bLE = (num) => hexToBytes2(padh(arange(num, 0n, B256), 64)).reverse();
var bytesToNumberLE = (b) => BigInt("0x" + bytesToHex2(Uint8Array.from(abytes2(b)).reverse()));
var pow2 = (x, power) => {
  let r = x;
  while (power-- > 0) {
    r = modP(r * r);
  }
  return r;
};
var pow_2_252_3 = (x) => {
  const x2 = modP(x * x);
  const b2 = modP(x2 * x);
  const b4 = modP(pow2(b2, 2) * b2);
  const b5 = modP(pow2(b4, 1) * x);
  const b10 = modP(pow2(b5, 5) * b5);
  const b20 = modP(pow2(b10, 10) * b10);
  const b40 = modP(pow2(b20, 20) * b20);
  const b80 = modP(pow2(b40, 40) * b40);
  const b160 = modP(pow2(b80, 80) * b80);
  const b240 = modP(pow2(b160, 80) * b80);
  const b250 = modP(pow2(b240, 10) * b10);
  return modP(pow2(b250, 2) * x);
};
var RM1 = 0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n;
var uvRatio = (u, v) => {
  const v3 = modP(v * modP(v * v));
  const v7 = modP(modP(v3 * v3) * v);
  const pow = pow_2_252_3(modP(u * v7));
  let x = modP(u * modP(v3 * pow));
  const vx2 = modP(v * modP(x * x));
  const root1 = x;
  const root2 = modP(x * RM1);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === mod(-u);
  const noRoot = vx2 === mod(-u * RM1);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if ((mod(x) & 1n) === 1n)
    x = mod(-x);
  return { isValid: useRoot1 || useRoot2, value: x };
};
var modL_LE = (hash) => modN(bytesToNumberLE(hash));
var hashedToExtK = (hashed) => {
  const copy = snapshotBytes(hashed);
  const head = copy.slice(0, 32);
  head[0] &= 248;
  head[31] &= 127;
  head[31] |= 64;
  const prefix = copy.slice(32);
  const scalar = modL_LE(head);
  const point = G.multiply(scalar);
  const pointBytes = point.toBytes();
  return { head, prefix, scalar, point, pointBytes };
};
var getExtendedPublicKeyAsync = (secretKey) => callHashAsync("sha512Async", abytes2(secretKey, LEN, "secretKey")).then(hashedToExtK);
var getExtendedPublicKey = (secretKey) => hashedToExtK(callHash("sha512", abytes2(secretKey, LEN, "secretKey")));
var getPublicKey = (secretKey) => getExtendedPublicKey(secretKey).pointBytes;
var hashFinishSync = (res) => res[1](callHash("sha512", res[0]));
var _sign = (e, rBytes, msg) => {
  const { pointBytes: A, scalar: s } = e;
  const r = modL_LE(rBytes);
  const R = G.multiply(r).toBytes();
  const hashable = concatBytes2(R, A, msg);
  const finish = (hashed) => {
    const S = modN(r + modL_LE(hashed) * s);
    return abytes2(concatBytes2(R, numTo32bLE(S)), 64);
  };
  return [hashable, finish];
};
var sign = (message, secretKey) => {
  const m = snapshotBytes(message, "message");
  const e = getExtendedPublicKey(secretKey);
  return hashFinishSync(_sign(e, callHash("sha512", e.prefix, m), m));
};
var getZip215 = (options) => {
  if (options === null || typeof options !== "object")
    throw new TypeError("expected valid options object");
  return options.zip215 ?? true;
};
var _verify = (sig, msg, publicKey, options) => {
  sig = abytes2(sig, 64, "signature");
  msg = abytes2(msg, void 0, "message");
  publicKey = abytes2(publicKey, LEN, "publicKey");
  const zip215 = getZip215(options);
  const r = sig.subarray(0, LEN);
  const s = bytesToNumberLE(sig.subarray(LEN, 64));
  let A, R, SB;
  let hashable = Uint8Array.of();
  let finished = false;
  try {
    A = Point.fromBytes(publicKey, zip215);
    R = Point.fromBytes(r, zip215);
    SB = G.multiply(s, false);
    hashable = concatBytes2(r, publicKey, msg);
    finished = true;
  } catch (error) {
  }
  const finish = (hashed) => {
    if (!finished)
      return false;
    if (!zip215 && A.isSmallOrder())
      return false;
    const k = modL_LE(hashed);
    const RkA = R.add(A.multiply(k, false));
    return RkA.subtract(SB).clearCofactor().is0();
  };
  return [hashable, finish];
};
var verify = (signature, message, publicKey, opts = {}) => hashFinishSync(_verify(signature, message, publicKey, opts));
var hashes = {
  sha512Async: async (message) => {
    const s = globalThis?.crypto?.subtle;
    if (!s)
      throw new Error("crypto.subtle must be defined, consider polyfill");
    return new Uint8Array(await s.digest("SHA-512", concatBytes2(message)));
  },
  sha512: void 0
};
var randomSecretKey = (seed) => {
  return abytes2(seed === void 0 ? randomBytes() : seed, LEN, "seed");
};
var utils = /* @__PURE__ */ freeze({
  getExtendedPublicKeyAsync,
  getExtendedPublicKey,
  randomSecretKey
});
var precompute = () => {
  const points = [];
  let p = G;
  let b;
  for (let w = 0; w < 33; w++) {
    b = p;
    points.push(b);
    for (let i = 1; i < 128; i++) {
      b = b.add(p);
      points.push(b);
    }
    p = b.double();
  }
  return points;
};
var Gpows = void 0;
var ctneg = (cnd, p) => {
  const n = p.negate();
  return cnd ? n : p;
};
var wNAF = (n) => {
  const comp = Gpows || (Gpows = precompute());
  let p = I;
  let f = G;
  for (let w = 0; w < 33; w++) {
    let wbits = Number(n & 255n);
    n >>= 8n;
    if (wbits > 128) {
      wbits -= 256;
      n += 1n;
    }
    const off = w * 128;
    const offP = off + Math.abs(wbits) - 1;
    const isOddW = w % 2 !== 0;
    const isNeg = wbits < 0;
    if (wbits === 0) {
      f = f.add(ctneg(isOddW, comp[off]));
    } else {
      p = p.add(ctneg(isNeg, comp[offP]));
    }
  }
  if (n !== 0n)
    throw new Error("invalid wnaf");
  return { p, f };
};

// ../core/dist/signing.js
if (!hashes.sha512)
  hashes.sha512 = sha512;
var SIGNATURE_DOMAIN = "lattice-tx-v1:";
function publicKeyFromPrivate(privateKey) {
  if (privateKey.length !== 32)
    throw new Error("Ed25519 private key must be 32 bytes");
  return getPublicKey(privateKey);
}
function generatePrivateKey() {
  return utils.randomSecretKey();
}
function signPreimage(preimage, privateKey) {
  return bytesToHex(sign(utf8(SIGNATURE_DOMAIN + preimage), privateKey));
}
function verifyPreimage(preimage, signature, publicKey) {
  try {
    return verify(hexToBytes(signature), utf8(SIGNATURE_DOMAIN + preimage), publicKey);
  } catch {
    return false;
  }
}

// ../core/dist/transaction.js
var INT64_MIN = -(1n << 63n);
var INT64_MAX = (1n << 63n) - 1n;
var UINT64_MAX = (1n << 64n) - 1n;
var UINT128_MAX = (1n << 128n) - 1n;
function assertRange(name, value, minimum, maximum) {
  if (value < minimum || value > maximum)
    throw new Error(`${name} is out of range`);
}
function assertBody(body) {
  assertRange("transaction nonce", body.nonce, 0n, UINT64_MAX);
  if (body.chainPath.length === 0 || body.chainPath.some((part) => part.length === 0)) {
    throw new Error("chainPath must contain non-empty components");
  }
  for (const action of body.accountActions) {
    assertRange("account delta", action.delta, INT64_MIN, INT64_MAX);
  }
  for (const action of [
    ...body.depositActions,
    ...body.receiptActions,
    ...body.withdrawalActions
  ]) {
    assertRange("cross-chain nonce", action.nonce, 0n, UINT128_MAX);
    assertRange("encodable cross-chain nonce", action.nonce, 0n, UINT64_MAX);
    assertRange("amount demanded", action.amountDemanded, 0n, UINT64_MAX);
  }
  for (const action of body.depositActions) {
    assertRange("amount deposited", action.amountDeposited, 0n, UINT64_MAX);
  }
  for (const action of body.withdrawalActions) {
    assertRange("amount withdrawn", action.amountWithdrawn, 0n, UINT64_MAX);
  }
}
function actionValue(action) {
  const output = { key: action.key };
  if (action.oldValue !== void 0)
    output.oldValue = action.oldValue;
  if (action.newValue !== void 0)
    output.newValue = action.newValue;
  return output;
}
function bodyValue(body) {
  assertBody(body);
  return {
    accountActions: body.accountActions.map((action) => ({
      owner: action.owner,
      delta: action.delta
    })),
    actions: body.actions.map(actionValue),
    depositActions: body.depositActions.map((action) => ({
      nonce: action.nonce,
      demander: action.demander,
      amountDemanded: action.amountDemanded,
      amountDeposited: action.amountDeposited
    })),
    receiptActions: body.receiptActions.map((action) => ({
      withdrawer: action.withdrawer,
      nonce: action.nonce,
      demander: action.demander,
      amountDemanded: action.amountDemanded,
      directory: action.directory
    })),
    withdrawalActions: body.withdrawalActions.map((action) => ({
      withdrawer: action.withdrawer,
      nonce: action.nonce,
      demander: action.demander,
      amountDemanded: action.amountDemanded,
      amountWithdrawn: action.amountWithdrawn
    })),
    signers: [...body.signers],
    nonce: body.nonce,
    chainPath: [...body.chainPath]
  };
}
function encodeTransactionBody(body) {
  const bytes = encodeDagCbor(bodyValue(body));
  return { bytes, cid: cidV1DagCbor(bytes) };
}
function transactionSigningPreimage(bodyCID, chainPath, nonce) {
  const lines = ["domain:13:lattice-tx-v1", `chainPath.count:${chainPath.length}`];
  for (const component of chainPath) {
    lines.push(`chainPath.component:${utf8(component).length}:${component}`);
  }
  lines.push(`nonce:${nonce}`, `bodyCID:${utf8(bodyCID).length}:${bodyCID}`);
  return lines.join("\n");
}
function encodeSignedTransaction(signatures, bodyCID) {
  const canonical = (value, pattern, what) => {
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    if (!pattern.test(hex))
      throw new Error(`${what} is not canonical hex`);
    return hex.toLowerCase();
  };
  const entries = /* @__PURE__ */ new Map();
  for (const [key, value] of Object.entries(signatures)) {
    const normalizedKey = canonical(key, /^[eE][dD]01[0-9a-fA-F]{64}$/, "signature key");
    if (entries.has(normalizedKey))
      throw new Error("duplicate signature key");
    entries.set(normalizedKey, canonical(value, /^[0-9a-fA-F]{128}$/, "signature"));
  }
  const sorted = [...entries.keys()].sort();
  const bytes = encodeDagCbor({
    body: { rawCID: bodyCID },
    signatures: sorted.map((key) => ({ key, value: entries.get(key) }))
  });
  return { bytes, cid: cidV1DagCbor(bytes) };
}
function signedTransactionSize(body) {
  const encoded = encodeTransactionBody(body);
  const signatures = Object.fromEntries(body.signers.map((_, index) => [
    "ed01" + index.toString(16).padStart(64, "0"),
    "0".repeat(128)
  ]));
  return encoded.bytes.length + encodeSignedTransaction(signatures, encoded.cid).bytes.length;
}
function stateGrowthCeiling(body) {
  const length = (value) => utf8(value).length;
  let growth = 0;
  for (const action of body.actions) {
    if (action.oldValue === void 0)
      growth += length(action.key) + length(action.newValue ?? "");
    else if (action.newValue === void 0)
      growth -= length(action.key) + length(action.oldValue);
    else
      growth += length(action.newValue) - length(action.oldValue);
  }
  for (const deposit of body.depositActions)
    growth += 32 + length(deposit.demander);
  for (const receipt of body.receiptActions) {
    growth += length(receipt.withdrawer) + length(receipt.demander) + length(receipt.directory) + 24;
  }
  for (const withdrawal of body.withdrawalActions) {
    growth += length(withdrawal.withdrawer) + length(withdrawal.demander) + 32;
  }
  const net = /* @__PURE__ */ new Map();
  const add2 = (owner, delta) => net.set(owner, (net.get(owner) ?? 0n) + delta);
  for (const action of body.accountActions)
    add2(action.owner, action.delta);
  for (const receipt of body.receiptActions) {
    add2(receipt.withdrawer, -receipt.amountDemanded);
    add2(receipt.demander, receipt.amountDemanded);
  }
  for (const [owner, delta] of net)
    if (delta > 0n)
      growth += length(owner) + 8;
  const signer = body.signers[0];
  if (signer !== void 0)
    growth += length("_nonce_" + signer) + 8;
  return growth;
}
function signedTransactionCID(signatures, body) {
  return encodeSignedTransaction(signatures, encodeTransactionBody(body).cid).cid;
}
function toWireTransactionBody(body) {
  assertBody(body);
  return {
    accountActions: body.accountActions.map(({ owner, delta }) => ({
      owner,
      delta: delta.toString()
    })),
    actions: body.actions.map((action) => ({ ...action })),
    depositActions: body.depositActions.map((action) => ({
      ...action,
      nonce: action.nonce.toString(),
      amountDemanded: action.amountDemanded.toString(),
      amountDeposited: action.amountDeposited.toString()
    })),
    receiptActions: body.receiptActions.map((action) => ({
      ...action,
      nonce: action.nonce.toString(),
      amountDemanded: action.amountDemanded.toString()
    })),
    withdrawalActions: body.withdrawalActions.map((action) => ({
      ...action,
      nonce: action.nonce.toString(),
      amountDemanded: action.amountDemanded.toString(),
      amountWithdrawn: action.amountWithdrawn.toString()
    })),
    signers: [...body.signers],
    nonce: body.nonce.toString(),
    chainPath: [...body.chainPath]
  };
}
function transactionPayload(signatures, body) {
  return { transaction: { signatures: { ...signatures }, body: toWireTransactionBody(body) } };
}
function signTransactionBody(body, privateKey) {
  const publicKey = encodeEd25519Multikey(publicKeyFromPrivate(privateKey));
  const { cid } = encodeTransactionBody(body);
  return {
    bodyCID: cid,
    publicKey,
    signature: signPreimage(transactionSigningPreimage(cid, body.chainPath, body.nonce), privateKey)
  };
}
function buildTransfer(args) {
  const { from, to, amount, fee, nonce, chainPath } = args;
  if (amount <= 0n)
    throw new Error("amount must be positive");
  if (fee < 0n)
    throw new Error("fee must not be negative");
  if (amount + fee > INT64_MAX)
    throw new Error("amount plus fee is too large");
  if (from === to)
    throw new Error("sender and recipient must differ");
  return {
    accountActions: [
      { owner: from, delta: -(amount + fee) },
      { owner: to, delta: amount }
    ],
    actions: [],
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [from],
    nonce,
    chainPath: [...chainPath]
  };
}
function accountFromPrivateKey(privateKey) {
  const publicKey = encodeEd25519Multikey(publicKeyFromPrivate(privateKey));
  return { privateKey: privateKey.slice(), publicKey, address: addressFromMultikey(publicKey) };
}

// ../core/dist/node-auth.js
function nodeCookieAuthorization(cookie) {
  const value = cookie.trim();
  if (value.length === 0 || /\s/.test(value)) {
    throw new Error("node cookie must be a non-empty token without whitespace");
  }
  if (!value.includes(":"))
    return `Bearer ${value}`;
  return `Basic ${btoa(value)}`;
}

// ../core/dist/child-proof.js
var decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decodeChildBlockProof(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 0;
  const u16 = () => {
    if (position + 2 > bytes.length)
      throw new Error();
    const value = view.getUint16(position, true);
    position += 2;
    return value;
  };
  const u32 = () => {
    if (position + 4 > bytes.length)
      throw new Error();
    const value = view.getUint32(position, true);
    position += 4;
    return value;
  };
  const take = (length) => {
    if (position + length > bytes.length)
      throw new Error();
    const slice = bytes.subarray(position, position + length);
    position += length;
    return slice;
  };
  const text = (length) => decoder.decode(take(length));
  try {
    const rootCID = text(u16());
    const directoryPath = [];
    for (let count = u16(); count > 0; count -= 1)
      directoryPath.push(text(u16()));
    const entries = [];
    let previous;
    for (let count = u16(); count > 0; count -= 1) {
      const cid = text(u16());
      const data = take(u32()).slice();
      if (previous !== void 0 && previous >= cid)
        return void 0;
      previous = cid;
      entries.push({ cid, data });
    }
    if (position !== bytes.length)
      return void 0;
    return { rootCID, directoryPath, entries };
  } catch {
    return void 0;
  }
}
function isStandardCID(value) {
  try {
    const parsed = parseCID(value);
    return parsed.codec === 113 && parsed.multihashCode === 18 && parsed.digest.length === 32;
  } catch {
    return false;
  }
}
function isValidChildDirectory(value) {
  return value.length > 0 && value.length <= 65535 && /^[\x21-\x2e\x30-\x7e]+$/.test(value);
}
function isLink(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array) && Object.keys(value).length === 1 && typeof value.rawCID === "string" && isStandardCID(value.rawCID);
}
var blockFields = /* @__PURE__ */ new Set([
  "version",
  "parent",
  "transactions",
  "target",
  "nextTarget",
  "spec",
  "parentState",
  "prevState",
  "postState",
  "children",
  "height",
  "timestamp",
  "rewardRecipient",
  "nonce"
]);
var blockLinks = [
  "parent",
  "transactions",
  "spec",
  "parentState",
  "prevState",
  "postState",
  "children"
];
function decodeLatticeBlock(bytes) {
  try {
    const value = decodeDagCbor(bytes);
    if (Object.keys(value).some((key) => !blockFields.has(key)))
      return void 0;
    if (blockLinks.some((key) => value[key] !== void 0 && !isLink(value[key])))
      return void 0;
    if (!isPrefixedHex(value.target) || !isPrefixedHex(value.nextTarget))
      return void 0;
    return decodeCanonicalBlock(bytes);
  } catch {
    return void 0;
  }
}
function isPrefixedHex(value) {
  return typeof value === "string" && /^0x(0|[1-9a-f][0-9a-f]{0,63})$/.test(value);
}
function hasWellFormedRewardRecipient(block) {
  return block.rewardRecipient === void 0 || isStandardCID(block.rewardRecipient);
}
function bigEndian(bytes) {
  let value = 0n;
  for (const byte of bytes)
    value = value << 8n | BigInt(byte);
  return value;
}
function meets(block, hash) {
  const target = BigInt(block.target);
  return target > 0n && target >= hash;
}
function verifyChildBlockProof(proof, childBytes, chainPath) {
  const fail = (failure) => ({ ok: false, failure });
  const { rootCID, directoryPath, entries } = proof;
  if (chainPath[0] !== "Nexus" || directoryPath.length === 0 || directoryPath.length > 65535 || chainPath.length !== directoryPath.length + 1 || directoryPath.some((directory, index) => directory !== chainPath[index + 1]) || entries.length === 0) {
    return fail("malformedEvidence");
  }
  const child = decodeLatticeBlock(childBytes);
  if (child === void 0)
    return fail("malformedEvidence");
  const childCID = cidV1DagCbor(childBytes);
  const proofEntries = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (proofEntries.has(entry.cid))
      return fail("malformedEvidence");
    proofEntries.set(entry.cid, entry.data);
  }
  const rootData = proofEntries.get(rootCID);
  if (rootData === void 0 || cidV1DagCbor(rootData) !== rootCID)
    return fail("malformedEvidence");
  const root = decodeLatticeBlock(rootData);
  if (root === void 0 || !hasWellFormedRewardRecipient(root))
    return fail("protocolInvalid");
  const rootHash = bigEndian(canonicalBlockProofOfWorkHash(root));
  const consumed = /* @__PURE__ */ new Set([rootCID]);
  const resolve = (cid) => {
    const data = proofEntries.get(cid);
    if (data === void 0 || cidV1DagCbor(data) !== cid)
      return void 0;
    consumed.add(cid);
    return data;
  };
  const carriers = [{ block: root, cid: rootCID }];
  let current = root;
  for (const [index, directory] of directoryPath.entries()) {
    const childrenData = resolve(current.childrenCID);
    let children;
    try {
      if (childrenData === void 0)
        return fail("malformedEvidence");
      const decoded = decodeDagCbor(childrenData);
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded) || decoded instanceof Uint8Array) {
        return fail("malformedEvidence");
      }
      children = decoded;
    } catch {
      return fail("malformedEvidence");
    }
    const link = children[directory];
    if (link === void 0 || !Object.hasOwn(children, directory))
      return fail("malformedEvidence");
    const linkCID = link !== null && typeof link === "object" && !Array.isArray(link) && !(link instanceof Uint8Array) ? link.rawCID : void 0;
    const nextData = typeof linkCID === "string" ? resolve(linkCID) : void 0;
    const next = nextData === void 0 ? void 0 : decodeLatticeBlock(nextData);
    if (next === void 0)
      return fail("malformedEvidence");
    const wellFormed = Object.entries(children).every(([key, value]) => isValidChildDirectory(key) && isLink(value));
    if (!wellFormed)
      return fail("protocolInvalid");
    if (index === directoryPath.length - 1) {
      if (linkCID !== childCID)
        return fail("malformedEvidence");
      if (child.parentStateCID !== current.previousStateCID)
        return fail("protocolInvalid");
      if (consumed.size !== proofEntries.size)
        return fail("malformedEvidence");
      const deepest = carriers[carriers.length - 1];
      const credited = carriers.find((carrier) => meets(carrier.block, rootHash));
      const creditedAncestorWork = credited === void 0 ? 0n : workForTarget(credited.block.target);
      const own = workForTarget(child.target);
      return {
        ok: true,
        evidence: {
          grindID: rootCID,
          rootHash,
          creditedAncestorWork,
          childCID,
          terminalCarrierCID: deepest.cid,
          ...meets(child, rootHash) ? { work: creditedAncestorWork > own ? creditedAncestorWork : own } : {}
        }
      };
    }
    if (!hasWellFormedRewardRecipient(next) || next.parentStateCID !== current.previousStateCID) {
      return fail("protocolInvalid");
    }
    current = next;
    carriers.push({ block: next, cid: linkCID });
  }
  return fail("malformedEvidence");
}

// ../client/dist/lattice-client.js
var LatticeClient = class {
  node;
  volumes;
  constructor(node, volumes) {
    this.node = node;
    this.volumes = volumes;
  }
  async latestBlock(signal) {
    const latest = await this.node.latestBlock(signal);
    return this.block(latest.hash, signal);
  }
  async block(id, signal) {
    const view = await this.node.block(id, signal);
    const volume = await this.volumes.get(view.hash, signal);
    const canonical = decodeCanonicalBlock(volume.rootBytes());
    const expected = [
      ["height", canonical.height, view.height],
      ["timestamp", canonical.timestamp, view.timestamp],
      ["nonce", canonical.nonce, view.nonce],
      ["version", canonical.version, view.version],
      ["parent", canonical.parentCID, view.previousBlock],
      ["target", canonical.target, view.target],
      ["next target", canonical.nextTarget, view.nextTarget],
      ["transactions", canonical.transactionsCID, view.transactionsCID],
      ["post-state", canonical.postStateCID, view.postStateCID],
      ["reward recipient", canonical.rewardRecipient, view.rewardRecipient]
    ];
    for (const [name, content, projection] of expected) {
      if (content !== projection)
        throw new Error(`node ${name} does not match canonical Block content`);
    }
    if (this.node.chainPath.length === 1 && canonical.height > 0n && !verifyNexusBlockProofOfWork(canonical)) {
      throw new Error("canonical Nexus Block does not satisfy its proof-of-work target");
    }
    return { view, volume, canonical };
  }
  async postState(id, signal) {
    const block = await this.block(id, signal);
    const volume = await this.volumes.get(block.canonical.postStateCID, signal);
    return { volume, canonical: decodeCanonicalLatticeState(volume.rootBytes()) };
  }
  async transactions(id, signal) {
    const block = await this.block(id, signal);
    return this.volumes.get(block.canonical.transactionsCID, signal);
  }
  async transaction(cid, signal) {
    const [projection, transaction] = await Promise.all([
      this.node.transaction(cid, signal),
      this.volumes.get(cid, signal)
    ]);
    if (projection.txCID !== cid)
      throw new Error(`node returned transaction projection ${projection.txCID} for ${cid}`);
    const canonical = decodeCanonicalSignedTransaction(transaction.rootBytes());
    const body = transaction.bytes(canonical.bodyCID);
    if (body === void 0)
      throw new Error("transaction Volume does not contain its body");
    return {
      projection,
      transaction,
      canonical,
      body
    };
  }
};

// ../client/dist/wire.js
function record2(value, name = "value") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}
function string2(value, name) {
  if (typeof value !== "string")
    throw new TypeError(`${name} must be a string`);
  return value;
}
function optionalString(value, name) {
  return value === void 0 ? void 0 : string2(value, name);
}
function integer3(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe JSON integer`);
  }
  return value;
}
function optionalInteger(value, name) {
  return value === void 0 ? void 0 : integer3(value, name);
}
function decimal(value, name) {
  if (typeof value !== "string" || !/^(?:0|-?[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} must be a canonical decimal string`);
  }
  return BigInt(value);
}
function optionalDecimal(value, name) {
  return value === void 0 ? void 0 : decimal(value, name);
}
function array2(value, name, parse) {
  if (!Array.isArray(value))
    throw new TypeError(`${name} must be an array`);
  return value.map((entry, index) => parse(entry, `${name}[${index}]`));
}
function stringArray(value, name) {
  return array2(value, name, string2);
}
function optionalBoolean(value, name) {
  if (value === void 0)
    return void 0;
  if (typeof value !== "boolean")
    throw new TypeError(`${name} must be a boolean`);
  return value;
}

// ../client/dist/models.js
function parseNodeStatus(value) {
  const body = record2(value, "status");
  return {
    phase: string2(body.phase, "status.phase"),
    chainPath: stringArray(body.chainPath, "status.chainPath"),
    nexusGenesisCID: string2(body.nexusGenesisCID, "status.nexusGenesisCID"),
    ...body.tipCID === void 0 ? {} : { tipCID: string2(body.tipCID, "status.tipCID") },
    ...body.height === void 0 ? {} : { height: decimal(body.height, "status.height") },
    ...body.revision === void 0 ? {} : { revision: decimal(body.revision, "status.revision") },
    mempoolCount: integer3(body.mempoolCount, "status.mempoolCount"),
    mempoolBytes: integer3(body.mempoolBytes, "status.mempoolBytes"),
    ...body.templateDigest === void 0 ? {} : { templateDigest: string2(body.templateDigest, "status.templateDigest") },
    ...body.bestHeaderHeight === void 0 ? {} : { bestHeaderHeight: decimal(body.bestHeaderHeight, "status.bestHeaderHeight") }
  };
}
function parseLatestBlock(value) {
  const body = record2(value, "latest block");
  const previousBlock = optionalString(body.previousBlock, "latestBlock.previousBlock");
  const rewardRecipient = optionalString(body.rewardRecipient, "latestBlock.rewardRecipient");
  const rewardCredited = optionalDecimal(body.rewardCredited, "latestBlock.rewardCredited");
  return {
    height: decimal(body.height, "latestBlock.height"),
    hash: string2(body.hash, "latestBlock.hash"),
    transactionCount: integer3(body.transactionCount, "latestBlock.transactionCount"),
    timestamp: decimal(body.timestamp, "latestBlock.timestamp"),
    ...previousBlock === void 0 ? {} : { previousBlock },
    ...rewardRecipient === void 0 ? {} : { rewardRecipient },
    ...rewardCredited === void 0 ? {} : { rewardCredited }
  };
}
function parseBlock(value) {
  const body = record2(value, "block");
  const previousBlock = optionalString(body.previousBlock, "block.previousBlock");
  const rewardRecipient = optionalString(body.rewardRecipient, "block.rewardRecipient");
  const rewardCredited = optionalDecimal(body.rewardCredited, "block.rewardCredited");
  return {
    height: decimal(body.height, "block.height"),
    hash: string2(body.hash, "block.hash"),
    timestamp: decimal(body.timestamp, "block.timestamp"),
    ...previousBlock === void 0 ? {} : { previousBlock },
    transactionCount: integer3(body.transactionCount, "block.transactionCount"),
    childBlockCount: integer3(body.childBlockCount, "block.childBlockCount"),
    nonce: decimal(body.nonce, "block.nonce"),
    version: integer3(body.version, "block.version"),
    target: string2(body.target, "block.target"),
    nextTarget: string2(body.nextTarget, "block.nextTarget"),
    transactionsCID: string2(body.transactionsCID, "block.transactionsCID"),
    postStateCID: string2(body.postStateCID, "block.postStateCID"),
    chain: stringArray(body.chain, "block.chain"),
    ...rewardRecipient === void 0 ? {} : { rewardRecipient },
    ...rewardCredited === void 0 ? {} : { rewardCredited }
  };
}
function parseAccount(value) {
  const body = record2(value, "account");
  return {
    owner: string2(body.owner, "account.owner"),
    balance: decimal(body.balance, "account.balance"),
    nonce: decimal(body.nonce, "account.nonce")
  };
}
function parseTransactionProjection(value) {
  const body = record2(value, "transaction");
  const blockHeight = optionalDecimal(body.blockHeight, "transaction.blockHeight");
  const blockHash = optionalString(body.blockHash, "transaction.blockHash");
  const timestamp = optionalDecimal(body.timestamp, "transaction.timestamp");
  return {
    txCID: string2(body.txCID, "transaction.txCID"),
    ...blockHeight === void 0 ? {} : { blockHeight },
    ...blockHash === void 0 ? {} : { blockHash },
    ...timestamp === void 0 ? {} : { timestamp },
    nonce: decimal(body.nonce, "transaction.nonce"),
    signers: stringArray(body.signers, "transaction.signers"),
    chainPath: stringArray(body.chainPath, "transaction.chainPath"),
    accountActions: array2(body.accountActions, "transaction.accountActions", (entry, name) => {
      const action = record2(entry, name);
      return {
        owner: string2(action.owner, `${name}.owner`),
        delta: decimal(action.delta, `${name}.delta`)
      };
    }),
    depositActions: array2(body.depositActions, "transaction.depositActions", (entry, name) => {
      const action = record2(entry, name);
      return {
        nonce: decimal(action.nonce, `${name}.nonce`),
        demander: string2(action.demander, `${name}.demander`),
        amountDemanded: decimal(action.amountDemanded, `${name}.amountDemanded`),
        amountDeposited: decimal(action.amountDeposited, `${name}.amountDeposited`)
      };
    }),
    receiptActions: array2(body.receiptActions, "transaction.receiptActions", (entry, name) => {
      const action = record2(entry, name);
      return {
        withdrawer: string2(action.withdrawer, `${name}.withdrawer`),
        nonce: decimal(action.nonce, `${name}.nonce`),
        demander: string2(action.demander, `${name}.demander`),
        amountDemanded: decimal(action.amountDemanded, `${name}.amountDemanded`),
        directory: string2(action.directory, `${name}.directory`)
      };
    }),
    withdrawalActions: array2(body.withdrawalActions, "transaction.withdrawalActions", (entry, name) => {
      const action = record2(entry, name);
      return {
        withdrawer: string2(action.withdrawer, `${name}.withdrawer`),
        nonce: decimal(action.nonce, `${name}.nonce`),
        demander: string2(action.demander, `${name}.demander`),
        amountDemanded: decimal(action.amountDemanded, `${name}.amountDemanded`),
        amountWithdrawn: decimal(action.amountWithdrawn, `${name}.amountWithdrawn`)
      };
    })
  };
}
function parseChainInfo(value) {
  const body = record2(value, "chain info");
  const genesisHash = optionalString(body.genesisHash, "chainInfo.genesisHash");
  const height = optionalDecimal(body.height, "chainInfo.height");
  const tipCID = optionalString(body.tipCID, "chainInfo.tipCID");
  const minRelayFee = optionalDecimal(body.minRelayFee, "chainInfo.minRelayFee");
  const acceptsSubmit = optionalBoolean(body.acceptsSubmit, "chainInfo.acceptsSubmit");
  return {
    ...genesisHash === void 0 ? {} : { genesisHash },
    ...height === void 0 ? {} : { height },
    ...tipCID === void 0 ? {} : { tipCID },
    chain: stringArray(body.chain, "chainInfo.chain"),
    ...minRelayFee === void 0 ? {} : { minRelayFee },
    ...acceptsSubmit === void 0 ? {} : { acceptsSubmit }
  };
}
function parseBlocksPage(value) {
  const body = record2(value, "blocks page");
  const nextBefore = optionalDecimal(body.nextBefore, "blocks.nextBefore");
  return {
    blocks: array2(body.blocks, "blocks.blocks", (entry, name) => {
      const row = record2(entry, name);
      const previousBlock = optionalString(row.previousBlock, `${name}.previousBlock`);
      const rewardRecipient = optionalString(row.rewardRecipient, `${name}.rewardRecipient`);
      return {
        height: decimal(row.height, `${name}.height`),
        hash: string2(row.hash, `${name}.hash`),
        ...previousBlock === void 0 ? {} : { previousBlock },
        timestamp: decimal(row.timestamp, `${name}.timestamp`),
        transactionCount: integer3(row.transactionCount, `${name}.transactionCount`),
        ...rewardRecipient === void 0 ? {} : { rewardRecipient }
      };
    }),
    ...nextBefore === void 0 ? {} : { nextBefore }
  };
}
function parseBlockChildren(value) {
  const body = record2(value, "block children");
  return array2(body.children, "children", (entry, name) => {
    const child = record2(entry, name);
    const height = optionalDecimal(child.height, `${name}.height`);
    const transactionCount = optionalInteger(child.transactionCount, `${name}.transactionCount`);
    return {
      directory: string2(child.directory, `${name}.directory`),
      blockHash: string2(child.blockHash, `${name}.blockHash`),
      ...height === void 0 ? {} : { height },
      ...transactionCount === void 0 ? {} : { transactionCount }
    };
  });
}
function transactionWeight(size, growth, weight) {
  if (!weight)
    return Math.max(1, size);
  let result = Math.max(1, size + weight.transactionAllowance);
  if (weight.blockRoom <= 0)
    return result;
  if (growth > 0) {
    if (weight.growthRoom <= 0 || growth >= weight.growthRoom)
      result = Math.max(result, weight.blockRoom);
    else {
      const share = (BigInt(growth) * BigInt(weight.blockRoom) + BigInt(weight.growthRoom) - 1n) / BigInt(weight.growthRoom);
      result = Math.max(result, Number(share));
    }
  }
  if (weight.maxTransactions > 0)
    result = Math.max(result, Math.floor(weight.blockRoom / weight.maxTransactions));
  return result;
}
function parseFeeEstimates(value) {
  const body = record2(value, "fees");
  const weight = body.weight === void 0 ? void 0 : record2(body.weight, "fees.weight");
  return {
    ...weight && {
      weight: {
        blockRoom: integer3(weight.blockRoom, "fees.weight.blockRoom"),
        growthRoom: integer3(weight.growthRoom, "fees.weight.growthRoom"),
        maxTransactions: integer3(weight.maxTransactions, "fees.weight.maxTransactions"),
        transactionAllowance: integer3(weight.transactionAllowance, "fees.weight.transactionAllowance")
      }
    },
    minRelayFee: decimal(body.minRelayFee, "fees.minRelayFee"),
    blocks: array2(body.blocks, "fees.blocks", (entry, name) => {
      const block = record2(entry, name);
      const lowestFeeBytes = integer3(block.lowestFeeBytes, `${name}.lowestFeeBytes`);
      if (lowestFeeBytes <= 0)
        throw new TypeError(`${name}.lowestFeeBytes must be positive`);
      const lowestFeeWeight = optionalInteger(block.lowestFeeWeight, `${name}.lowestFeeWeight`) ?? lowestFeeBytes;
      if (lowestFeeWeight <= 0)
        throw new TypeError(`${name}.lowestFeeWeight must be positive`);
      const full = optionalBoolean(block.full, `${name}.full`);
      if (full === void 0)
        throw new TypeError(`${name}.full must be a boolean`);
      return {
        transactionCount: integer3(block.transactionCount, `${name}.transactionCount`),
        bytes: integer3(block.bytes, `${name}.bytes`),
        lowestFee: decimal(block.lowestFee, `${name}.lowestFee`),
        lowestFeeBytes,
        lowestFeeWeight,
        full
      };
    })
  };
}
function feeToOutbid(block, weight) {
  if (!Number.isSafeInteger(weight) || weight <= 0)
    throw new RangeError("weight must be a positive integer");
  return block.lowestFee * BigInt(weight) / BigInt(block.lowestFeeWeight) + 1n;
}
function parseChainSpec(value) {
  const body = record2(value, "chain spec");
  return {
    targetBlockTime: decimal(body.targetBlockTime, "chainSpec.targetBlockTime"),
    initialReward: decimal(body.initialReward, "chainSpec.initialReward"),
    halvingInterval: decimal(body.halvingInterval, "chainSpec.halvingInterval"),
    maxBlockSize: integer3(body.maxBlockSize, "chainSpec.maxBlockSize"),
    maxNumberOfTransactionsPerBlock: decimal(body.maxNumberOfTransactionsPerBlock, "chainSpec.maxNumberOfTransactionsPerBlock"),
    premine: decimal(body.premine, "chainSpec.premine"),
    halfLife: decimal(body.halfLife, "chainSpec.halfLife")
  };
}

// ../client/dist/http.js
var NodeError = class extends Error {
  status;
  refusal;
  constructor(status, refusal3) {
    super(refusal3 ?? `HTTP ${status}`);
    this.name = "NodeError";
    this.status = status;
    if (refusal3 !== void 0)
      this.refusal = refusal3;
  }
};
function refusal(text) {
  try {
    const body = record2(JSON.parse(text));
    const error = body.error;
    if (typeof error === "string")
      return error;
    if (error !== void 0) {
      const message = record2(error).message;
      if (typeof message === "string")
        return message;
    }
  } catch {
  }
  return void 0;
}
function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted)
      abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
async function boundedText(response, maximumBytes, signal) {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximumBytes) {
    throw new NodeError(response.status, "response too large");
  }
  if (response.body === null)
    return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done)
        break;
      size += value.byteLength;
      if (size > maximumBytes) {
        throw new NodeError(response.status, "response too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {
    });
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function getJSON(url, options = {}) {
  const { fetch = globalThis.fetch.bind(globalThis), timeoutMilliseconds = 8e3, maximumResponseBytes = 4 * 1024 * 1024, signal, authorization } = options;
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0 || !Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes <= 0)
    throw new RangeError("Invalid JSON request limits");
  const timeout = AbortSignal.timeout(timeoutMilliseconds);
  const combined = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
  combined.throwIfAborted();
  const response = await abortable(fetch(url, {
    headers: {
      Accept: "application/json",
      ...authorization === void 0 ? {} : { Authorization: authorization }
    },
    // A redirect would let any answering host steer the request to another
    // host or scheme; node routes never redirect.
    redirect: "error",
    signal: combined
  }), combined);
  const text = await boundedText(response, maximumResponseBytes, combined);
  if (!response.ok)
    throw new NodeError(response.status, refusal(text));
  try {
    return JSON.parse(text);
  } catch {
    throw new NodeError(response.status, "invalid JSON response");
  }
}

// ../client/dist/node-client.js
function isLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.[0-9]{1,3}){3}$/.test(host);
}
function normalizeNodeURL(input) {
  const url = new URL(input);
  if (url.username || url.password || input.includes("?") || input.includes("#")) {
    throw new Error("node URL must not contain credentials, a query, or a fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("node URL must use HTTPS, except for loopback HTTP");
  }
  return url.toString().replace(/\/$/, "");
}
var NodeClient = class {
  baseURL;
  chainPath;
  #fetch;
  #timeoutMilliseconds;
  #maximumResponseBytes;
  #authorization;
  constructor(baseURL, chainPath, options = {}) {
    if (chainPath.length === 0)
      throw new Error("chainPath must not be empty");
    this.baseURL = normalizeNodeURL(baseURL);
    this.chainPath = [...chainPath];
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 8e3;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 4 * 1024 * 1024;
    this.#authorization = options.authorization;
  }
  #url(path, parameters = {}) {
    const url = new URL(`${this.baseURL}${path}`);
    url.searchParams.set("chainPath", this.chainPath.join("/"));
    for (const [key, value] of Object.entries(parameters))
      url.searchParams.set(key, value);
    return url;
  }
  async #request(path, parser, signal, parameters = {}) {
    return parser(await getJSON(this.#url(path, parameters), {
      fetch: this.#fetch,
      timeoutMilliseconds: this.#timeoutMilliseconds,
      maximumResponseBytes: this.#maximumResponseBytes,
      signal,
      authorization: this.#authorization
    }));
  }
  health(signal) {
    return this.#request("/health", parseNodeStatus, signal);
  }
  block(id, signal) {
    return this.#request(`/api/block/${encodeURIComponent(id.toString())}`, parseBlock, signal);
  }
  latestBlock(signal) {
    return this.#request("/api/block/latest", parseLatestBlock, signal);
  }
  /**
   * A page of canonical block summaries, newest first. `before` is exclusive;
   * `limit` is 1...25 (the node's cap). The page is presentation: rows must
   * descend strictly below `before` and never exceed `limit`.
   */
  async blocks(options = {}, signal) {
    const { before, limit } = options;
    if (before !== void 0 && before < 0n)
      throw new RangeError("before must not be negative");
    if (limit !== void 0 && (!Number.isSafeInteger(limit) || limit < 1 || limit > 25)) {
      throw new RangeError("limit must be an integer from 1 to 25");
    }
    const page = await this.#request("/api/blocks", parseBlocksPage, signal, {
      ...before === void 0 ? {} : { before: before.toString() },
      ...limit === void 0 ? {} : { limit: limit.toString() }
    });
    if (page.blocks.length > (limit ?? 25))
      throw new TypeError("blocks page exceeds its limit");
    let ceiling = before;
    for (const row of page.blocks) {
      if (ceiling !== void 0 && row.height >= ceiling) {
        throw new TypeError("blocks page is not strictly descending below before");
      }
      ceiling = row.height;
    }
    if (page.nextBefore !== void 0 && (page.nextBefore < 1n || ceiling !== void 0 && page.nextBefore > ceiling)) {
      throw new TypeError("blocks.nextBefore does not continue the page");
    }
    return page;
  }
  /** Child commitments of a block at this client's chain level. */
  children(blockCID, signal) {
    return this.#request(`/api/block/${encodeURIComponent(blockCID)}/children`, parseBlockChildren, signal);
  }
  /**
   * One page of the child directories this chain's executed blocks have
   * committed (`GET /api/chain/children`), in order, after `after` (from the
   * first when absent). `next` is the `after` for the following page, absent
   * on the last. The node's list only grows: a directory committed on a
   * branch that lost stays listed. A child is reached through its hosts, not
   * through what the parent commits. A node predating paging answers its
   * whole list; names not after `after` are dropped from it. A page whose
   * `next` does not move past `after` is refused.
   */
  childDirectories(options = {}, signal) {
    const { after, limit } = options;
    if (limit !== void 0 && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new RangeError("limit must be a positive integer");
    }
    return this.#request("/api/chain/children", (value) => {
      const body = record2(value, "chain children");
      const chainPath = stringArray(body.chainPath, "chainChildren.chainPath");
      if (chainPath.join("/") !== this.chainPath.join("/")) {
        throw new TypeError("chain children answer names a different chainPath");
      }
      const listed = stringArray(body.directories, "chainChildren.directories");
      if (listed.some((name, index) => index > 0 && !(listed[index - 1] < name))) {
        throw new TypeError("chain children are not in order");
      }
      const directories = after === void 0 ? listed : listed.filter((name) => name > after);
      const next = optionalString(body.next, "chainChildren.next");
      if (next !== void 0 && next !== listed.at(-1)) {
        throw new TypeError("chainChildren.next must be the last name listed");
      }
      if (next !== void 0 && directories.length === 0) {
        throw new TypeError("chainChildren.next does not advance past after");
      }
      return { directories, ...next === void 0 ? {} : { next } };
    }, signal, {
      ...after === void 0 ? {} : { after },
      ...limit === void 0 ? {} : { limit: limit.toString() }
    });
  }
  /** The node's Nexus genesis (`GET /api/chain/genesis`): which network it is on. */
  nexusGenesis(signal) {
    return this.#request("/api/chain/genesis", (value) => string2(record2(value, "chain genesis").genesisHash, "chainGenesis.genesisHash"), signal);
  }
  account(owner, signal) {
    return this.#request(`/api/state/account/${encodeURIComponent(owner)}`, parseAccount, signal);
  }
  transaction(cid, signal) {
    return this.#request(`/api/transaction/${encodeURIComponent(cid)}`, parseTransactionProjection, signal);
  }
  transactionContent(cid, signal) {
    return this.#request(`/transactions/${encodeURIComponent(cid)}`, (value) => {
      const response = record2(value, "transaction response");
      const transaction = record2(response.transaction, "transaction response.transaction");
      const body = record2(transaction.body, "transaction response.transaction.body");
      return {
        cid: string2(response.cid, "transaction response.cid"),
        bodyCID: string2(body.rawCID, "transaction response.transaction.body.rawCID")
      };
    }, signal);
  }
  chainInfo(signal) {
    return this.#request("/api/chain/info", parseChainInfo, signal);
  }
  /** The chain's consensus parameters (`GET /api/chain/spec`). */
  chainSpec(signal) {
    return this.#request("/api/chain/spec", parseChainSpec, signal);
  }
  /**
   * The blocks this node's pool would fill next (`GET /api/fees`), for fee
   * pricing. Nodes older than the route answer 404 (`NodeError`).
   */
  fees(signal) {
    return this.#request("/api/fees", parseFeeEstimates, signal);
  }
  mempool(signal) {
    return this.#request("/api/mempool", (value) => {
      const body = record2(value, "mempool");
      return {
        count: integer3(body.count, "mempool.count"),
        transactions: stringArray(body.transactions, "mempool.transactions")
      };
    }, signal);
  }
};

// ../client/dist/endpoints.js
var OPERATOR_DECLARED = "operator-declared, not independently verified";
function parseDeclaredEndpoints(value) {
  const body = record2(value, "endpoints");
  const committedBlock = body.committedBlock === null ? void 0 : optionalString(body.committedBlock, "endpoints.committedBlock");
  return {
    chainPath: stringArray(body.chainPath, "endpoints.chainPath"),
    ...committedBlock === void 0 ? {} : { committedBlock },
    endpoints: stringArray(body.endpoints, "endpoints.endpoints"),
    // A node predating the field omits it; that reads as empty.
    submitEndpoints: body.submitEndpoints === void 0 ? [] : stringArray(body.submitEndpoints, "endpoints.submitEndpoints")
  };
}
function ipv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^[0-9]{1,3}$/.test(part)))
    return void 0;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : void 0;
}
function publicIPv4(octets) {
  const [a = 0, b = 0, c = 0] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || // multicast, reserved, broadcast
  a === 100 && b >= 64 && b <= 127 || // CGNAT
  a === 169 && b === 254 || // link local
  a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 192 && b === 0 && (c === 0 || c === 2) || // IETF, documentation
  a === 192 && b === 88 && c === 99 || // 6to4 relay
  a === 198 && (b === 18 || b === 19) || // benchmarking
  a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113);
}
function ipv6Groups(host) {
  const halves = host.split("::");
  if (halves.length > 2)
    return void 0;
  const parse = (half) => {
    if (half === void 0 || half === "")
      return [];
    const groups = half.split(":");
    return groups.every((group) => /^[0-9a-f]{1,4}$/.test(group)) ? groups.map((group) => parseInt(group, 16)) : void 0;
  };
  const head = parse(halves[0]);
  const tail = parse(halves[1]);
  if (head === void 0 || tail === void 0)
    return void 0;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1)
    return void 0;
  return [...head, ...Array(fill).fill(0), ...tail];
}
function embedded(high, low) {
  return [high >> 8, high & 255, low >> 8, low & 255];
}
function publicIPv6(host) {
  const g = ipv6Groups(host);
  if (g === void 0)
    return false;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 65535) {
    return publicIPv4(embedded(g6, g7));
  }
  if (g0 === 100 && g1 === 65435 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return publicIPv4(embedded(g6, g7));
  }
  if (g0 === 8194)
    return publicIPv4(embedded(g1, g2));
  if ((g0 & 57344) !== 8192)
    return false;
  if (g0 === 8193 && (g1 < 512 || g1 === 3512))
    return false;
  return true;
}
function isPublicAddress(address) {
  const host = address.toLowerCase();
  const octets = ipv4(host);
  return octets !== void 0 ? publicIPv4(octets) : publicIPv6(host);
}
function declaredEndpointURL(input) {
  let normalized;
  let url;
  try {
    normalized = normalizeNodeURL(input);
    url = new URL(normalized);
  } catch {
    return void 0;
  }
  if (url.protocol !== "https:")
    return void 0;
  const host = url.hostname.toLowerCase();
  if (host.startsWith("["))
    return publicIPv6(host.slice(1, -1)) ? normalized : void 0;
  const octets = ipv4(host);
  if (octets !== void 0)
    return publicIPv4(octets) ? normalized : void 0;
  const name = host.replace(/\.$/, "");
  if (!name.includes("."))
    return void 0;
  if (/\.(?:localhost|local|internal|home\.arpa)$/.test(name))
    return void 0;
  return normalized;
}
function childPath(parent, directory) {
  if (directory.length === 0 || directory.includes("/")) {
    throw new TypeError("child directory must be one non-empty path component");
  }
  return [...parent, directory];
}
function samePath(left, right) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}
var DIRECTORY_PAGE = 200;
var LONGEST_NAME_PAGE_BYTES = 2 * 65535 + 4096;
var Budget = class {
  remaining;
  constructor(requests) {
    this.remaining = requests;
  }
  spend() {
    if (this.remaining <= 0)
      throw new RangeError("endpoint discovery request budget exhausted");
    this.remaining -= 1;
  }
};
var EndpointResolver = class {
  root;
  #fetch;
  #lookup;
  #timeoutMilliseconds;
  #maximumResponseBytes;
  #maximumCandidates;
  #maximumSources;
  #maximumRequests;
  constructor(root, options = {}) {
    this.root = root;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    if (options.lookup !== void 0)
      this.#lookup = options.lookup;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 4e3;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 64 * 1024;
    this.#maximumCandidates = options.maximumCandidates ?? 8;
    this.#maximumSources = options.maximumSources ?? 4;
    this.#maximumRequests = options.maximumRequests ?? 64;
  }
  #client(baseURL, chainPath, budget, maximumResponseBytes = this.#maximumResponseBytes) {
    return new NodeClient(baseURL, chainPath, {
      fetch: (input, init) => {
        budget.spend();
        return this.#fetch(input, init);
      },
      timeoutMilliseconds: this.#timeoutMilliseconds,
      maximumResponseBytes
    });
  }
  /** One node's raw, unverified declaration for `chainPath`. */
  async declared(sourceURL, chainPath, signal) {
    return this.#declared(sourceURL, chainPath, new Budget(1), signal);
  }
  async #declared(sourceURL, chainPath, budget, signal) {
    const url = new URL(`${normalizeNodeURL(sourceURL)}/api/chain/endpoints`);
    url.searchParams.set("chainPath", chainPath.join("/"));
    budget.spend();
    const declared = parseDeclaredEndpoints(await getJSON(url, {
      fetch: this.#fetch,
      timeoutMilliseconds: this.#timeoutMilliseconds,
      maximumResponseBytes: this.#maximumResponseBytes,
      signal
    }));
    if (!samePath(declared.chainPath, chainPath)) {
      throw new TypeError("endpoints answer names a different chainPath");
    }
    return declared;
  }
  /** Whether a declared host's name resolves only to public addresses. */
  async #resolvesPublic(url, signal) {
    if (this.#lookup === void 0)
      return true;
    const host = new URL(url).hostname;
    if (host.startsWith("[") || ipv4(host) !== void 0)
      return true;
    try {
      const timeout = AbortSignal.timeout(this.#timeoutMilliseconds);
      const bounded = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
      bounded.throwIfAborted();
      const addresses = await Promise.race([
        this.#lookup(host, bounded),
        new Promise((_, reject) => {
          bounded.addEventListener("abort", () => reject(bounded.reason), { once: true });
        })
      ]);
      return addresses.length > 0 && addresses.every(isPublicAddress);
    } catch {
      return false;
    }
  }
  /** Whether `baseURL` serves `chainPath`, with a tip, on the network `nexusGenesis` names. */
  async #serves(baseURL, chainPath, nexusGenesis, budget, signal) {
    try {
      if (!await this.#resolvesPublic(baseURL, signal))
        return false;
      const client = this.#client(baseURL, chainPath, budget);
      const [info, genesis] = await Promise.all([
        client.chainInfo(signal),
        client.nexusGenesis(signal)
      ]);
      return samePath(info.chain, chainPath) && info.height !== void 0 && genesis === nexusGenesis;
    } catch {
      return false;
    }
  }
  /** Accepted endpoints of `parentSources`' child `chainPath`, in declared order. */
  async #level(parentSources, chainPath, nexusGenesis, budget, signal) {
    const fromRoot = samePath(chainPath.slice(0, -1), this.root.chainPath);
    const answers = await Promise.all(parentSources.slice(0, this.#maximumSources).map(async (source) => {
      try {
        return await this.#declared(source, chainPath, budget, signal);
      } catch (error) {
        if (fromRoot)
          this.#rootFailure(source, error);
        return void 0;
      }
    }));
    const candidates = /* @__PURE__ */ new Map();
    for (const answer of answers) {
      if (answer === void 0)
        continue;
      const submit = new Set(answer.submitEndpoints.map(declaredEndpointURL));
      for (const declared of answer.endpoints) {
        const url = declaredEndpointURL(declared);
        if (url === void 0)
          continue;
        const seen = candidates.get(url);
        if (seen !== void 0) {
          seen.declaresSubmit ||= submit.has(url);
          continue;
        }
        if (candidates.size >= this.#maximumCandidates)
          continue;
        candidates.set(url, { url, declaresSubmit: submit.has(url) });
      }
    }
    const accepted = await Promise.all([...candidates.values()].map(async ({ url, declaresSubmit }) => await this.#serves(url, chainPath, nexusGenesis, budget, signal) ? { url, chainPath: [...chainPath], declaresSubmit, trust: OPERATOR_DECLARED } : void 0));
    return accepted.filter((entry) => entry !== void 0);
  }
  /** The root's Nexus genesis, which names the network every accepted host must be on. */
  #network(budget, signal) {
    return this.#client(this.root.baseURL, this.root.chainPath, budget).nexusGenesis(signal);
  }
  /**
   * A declared host failing is that host's affair, and is passed over. The
   * root failing on its own level (an error status other than 404, or no
   * answer in time) is the caller's, and is thrown. Anything else from it (a
   * 404, an answer too large or malformed) is passed over: that is this
   * chain's answer, not the node, at fault. The root unreachable shows in
   * reading its genesis, which every walk does first.
   */
  #rootFailure(source, error) {
    if (source !== this.root.baseURL)
      return;
    const status = error instanceof NodeError && error.status >= 400 && error.status !== 404;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    if (status || timedOut)
      throw error;
  }
  /**
   * Accepted declared endpoints for `chainPath`, which must extend the root's
   * chain path. Each level's accepted hosts are asked about the next level.
   */
  async resolve(chainPath, signal) {
    const rootPath = this.root.chainPath;
    if (chainPath.length <= rootPath.length || !samePath(chainPath.slice(0, rootPath.length), rootPath)) {
      throw new RangeError("chainPath must name a descendant of the root's chain");
    }
    if (chainPath.some((part) => part.length === 0 || part.includes("/"))) {
      throw new RangeError("chainPath components must be non-empty and contain no '/'");
    }
    const budget = new Budget(this.#maximumRequests);
    const network = await this.#network(budget, signal);
    let sources = [this.root.baseURL];
    let resolved = [];
    for (let depth = rootPath.length + 1; depth <= chainPath.length; depth += 1) {
      resolved = await this.#level(sources, chainPath.slice(0, depth), network, budget, signal);
      signal?.throwIfAborted();
      if (resolved.length === 0)
        return [];
      sources = resolved.map((entry) => entry.url);
    }
    return resolved;
  }
  /**
   * Every chain below the root whose hosts answer, breadth first: a chain's
   * children are the directory names its accepted hosts list
   * (`/api/chain/children`, every page), and each is resolved like
   * {@link resolve}. Yields each accepted endpoint as it is found and runs
   * until the tree ends or the caller stops (break, or abort `signal`).
   * Every request is timed; the walk itself has no budget.
   */
  async *walk(signal) {
    signal?.throwIfAborted();
    const budget = new Budget(Infinity);
    const network = await this.#network(budget, signal);
    signal?.throwIfAborted();
    let frontier = [
      { path: this.root.chainPath, sources: [this.root.baseURL] }
    ];
    while (frontier.length > 0) {
      const next = [];
      for (const { path, sources } of frontier) {
        for await (const directory of this.#childDirectories(sources, path, budget, signal)) {
          const level = childPath(path, directory);
          const resolved = await this.#level(sources, level, network, budget, signal);
          signal?.throwIfAborted();
          yield* resolved;
          if (resolved.length > 0)
            next.push({ path: level, sources: resolved.map((e) => e.url) });
        }
      }
      frontier = next;
    }
  }
  /**
   * Every child directory the first answering source lists, page by page. A
   * page over the response cap is asked again with half the names, down to
   * one; one name alone may take {@link LONGEST_NAME_PAGE_BYTES}. A source
   * that fails mid-list hands over to the next, from the last name read.
   */
  async *#childDirectories(sources, chainPath, budget, signal) {
    let after;
    for (const source of sources.slice(0, this.#maximumSources)) {
      const client = this.#client(source, chainPath, budget);
      const single = this.#client(source, chainPath, budget, Math.max(this.#maximumResponseBytes, LONGEST_NAME_PAGE_BYTES));
      let limit = DIRECTORY_PAGE;
      let page;
      for (; ; ) {
        try {
          const options = { limit, ...after === void 0 ? {} : { after } };
          page = await (limit === 1 ? single : client).childDirectories(options, signal);
          limit = DIRECTORY_PAGE;
        } catch (error) {
          signal?.throwIfAborted();
          if (limit > 1 && error instanceof NodeError && error.refusal === "response too large") {
            limit = Math.max(1, Math.floor(limit / 2));
            continue;
          }
          if (samePath(chainPath, this.root.chainPath))
            this.#rootFailure(source, error);
          break;
        }
        for (const directory of page.directories) {
          after = directory;
          if (directory.length > 0 && !directory.includes("/"))
            yield directory;
        }
        if (page.next === void 0)
          return;
      }
    }
  }
};

// ../client/dist/chain-nodes.js
var ChainOfflineError = class extends Error {
  chainPath;
  constructor(chainPath) {
    super(`No node serves ${chainPath.join("/")}`);
    this.name = "ChainOfflineError";
    this.chainPath = [...chainPath];
  }
};
var ChainNodes = class {
  startURLs;
  #fetch;
  #ttl;
  #timeout;
  #resolver;
  #now;
  #random;
  #lists = /* @__PURE__ */ new Map();
  /** Per chain, the next turn of its reads and of its walks down. */
  #turns = /* @__PURE__ */ new Map();
  constructor(start, options = {}) {
    const urls = (typeof start === "string" ? [start] : start).map(normalizeNodeURL);
    if (urls.length === 0)
      throw new RangeError("ChainNodes needs at least one start node");
    this.startURLs = [...new Set(urls)];
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#ttl = options.ttlMilliseconds ?? 3e4;
    this.#timeout = options.timeoutMilliseconds ?? 15e3;
    this.#resolver = options.resolver ?? {};
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }
  /** The next turn of `kind` for `key`'s chain, beginning at a random one. */
  #turn(key, kind) {
    let turns = this.#turns.get(key);
    if (turns === void 0) {
      const first = Math.floor(this.#random() * 2 ** 32);
      turns = { read: first, walk: first };
      this.#turns.set(key, turns);
    }
    return turns[kind]++;
  }
  /** The nodes serving `chainPath`: start nodes first, then found hosts, in declared order. */
  list(chainPath) {
    return this.#entry(chainPath).list;
  }
  #entry(chainPath) {
    const key = JSON.stringify(chainPath);
    const kept = this.#lists.get(key);
    if (kept !== void 0 && this.#now() < kept.until)
      return kept;
    let own;
    const entry = {
      own: new Promise((resolve) => own = resolve),
      list: Promise.resolve([]),
      // Kept from when the list is made, not asked for.
      until: Infinity
    };
    entry.list = this.#list([...chainPath], own);
    this.#lists.set(key, entry);
    entry.list.then((nodes) => {
      entry.whole = nodes;
      entry.until = this.#now() + this.#ttl;
    }, () => {
      own([]);
      if (this.#lists.get(key) === entry)
        this.#lists.delete(key);
    });
    return entry;
  }
  /**
   * `read` on the nodes serving `chainPath`, beginning at the next node in
   * turn and going round the list until one answers; else the last failure.
   * While the walk is out, the start nodes that serve the chain are the list,
   * and the found hosts are waited for only once they have all failed.
   */
  async read(chainPath, read) {
    const entry = this.#entry(chainPath);
    const turn = this.#turn(JSON.stringify(chainPath), "read");
    let nodes = entry.whole ?? await entry.own;
    if (nodes.length === 0)
      nodes = await entry.list;
    if (nodes.length === 0)
      throw new ChainOfflineError(chainPath);
    const tried = /* @__PURE__ */ new Set();
    let failure;
    for (; ; ) {
      for (let step = 0; step < nodes.length; step += 1) {
        const node = nodes[(turn + step) % nodes.length];
        if (tried.has(node.url))
          continue;
        tried.add(node.url);
        try {
          return await read(node);
        } catch (error) {
          failure = error;
        }
      }
      if (nodes === entry.whole)
        throw failure;
      nodes = await entry.list.catch(() => nodes);
      if (nodes.every(({ url }) => tried.has(url)))
        throw failure;
    }
  }
  /** Whether `startURL` answers for `chainPath`: false on 404, throws on any other failure. */
  async #serves(startURL, chainPath) {
    const client = new NodeClient(startURL, chainPath, {
      fetch: this.#fetch,
      timeoutMilliseconds: this.#timeout
    });
    try {
      const info = await client.chainInfo();
      return info.chain.join("/") === chainPath.join("/");
    } catch (error) {
      if (error instanceof NodeError && error.status === 404)
        return false;
      throw error;
    }
  }
  /** The whole list; `own` hears the start nodes that serve the chain as soon as they are known. */
  async #list(chainPath, own) {
    const checks = await Promise.allSettled(this.startURLs.map((url) => this.#serves(url, chainPath)));
    const failure = checks.find((check) => check.status === "rejected");
    if (checks.every((check) => check.status === "rejected"))
      throw failure.reason;
    const serving = this.startURLs.filter((_, index) => {
      const check = checks[index];
      return check.status === "fulfilled" && check.value;
    }).map((url) => ({ url, found: false }));
    own(serving);
    const ownURLs = new Set(serving.map(({ url }) => url));
    const nodes = await this.#declared(chainPath, this.startURLs.filter((_, index) => checks[index].status === "fulfilled")).then((found) => [...serving, ...found.filter(({ url }) => !ownURLs.has(url))], (error) => {
      if (serving.length > 0)
        return serving;
      throw error;
    });
    if (nodes.length === 0 && failure !== void 0)
      throw failure.reason;
    return nodes;
  }
  /**
   * The declared hosts of `chainPath`, walked down from the nearest ancestor a
   * start node serves: the next of `starts` (those that just answered) in
   * turn, then the others when one fails. Empty only when no start node
   * failed: one answered that the chain has no hosts, or every one that it
   * serves no ancestor. Otherwise a failure is thrown.
   */
  async #declared(chainPath, starts) {
    const turn = this.#turn(JSON.stringify(chainPath), "walk");
    let failure;
    for (let step = 0; step < starts.length; step += 1) {
      const start = starts[(turn + step) % starts.length];
      try {
        let at = chainPath.slice(0, -1);
        while (at.length > 0 && !await this.#serves(start, at))
          at = at.slice(0, -1);
        if (at.length === 0)
          continue;
        const resolver = new EndpointResolver(new NodeClient(start, at, { fetch: this.#fetch }), {
          ...this.#resolver,
          fetch: this.#fetch
        });
        const hosts = await resolver.resolve(chainPath);
        if (hosts.length > 0 || failure === void 0) {
          return hosts.map(({ url }) => ({ url, found: true }));
        }
      } catch (error) {
        failure ??= { reason: error };
      }
    }
    if (failure !== void 0)
      throw failure.reason;
    return [];
  }
};

// ../relay/dist/http.js
function isLoopback2(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.[0-9]{1,3}){3}$/.test(host);
}
function writeURL(input, what) {
  const url = new URL(input);
  if (url.username || url.password || url.hash) {
    throw new Error(`${what} URL must not contain credentials or a fragment`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback2(url.hostname))) {
    throw new Error(`${what} URL must use HTTPS, except for loopback HTTP`);
  }
  return url.toString();
}
function errorMessage(value) {
  if (value === null || typeof value !== "object")
    return void 0;
  const error = value.error;
  if (typeof error === "string")
    return error;
  if (error !== null && typeof error === "object") {
    const message = error.message;
    if (typeof message === "string")
      return message;
  }
  return void 0;
}
async function boundedText2(response, maximumBytes) {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximumBytes)
    return void 0;
  if (response.body === null)
    return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done)
      break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      return void 0;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

// ../relay/dist/sponsor.js
var SponsorError = class extends Error {
  status;
  /** The sponsor's refusal, such as `insufficientCredit` or `expired`. */
  refusal;
  /** How long the answer's `Retry-After` asks to wait, in milliseconds. */
  retryAfterMilliseconds;
  constructor(status, refusal3, retryAfterMilliseconds) {
    super(refusal3 ?? `sponsor request failed with HTTP ${status}`);
    this.name = "SponsorError";
    this.status = status;
    if (refusal3 !== void 0)
      this.refusal = refusal3;
    if (retryAfterMilliseconds !== void 0)
      this.retryAfterMilliseconds = retryAfterMilliseconds;
  }
};
function retryAfter(header) {
  if (header === null)
    return void 0;
  if (/^[0-9]+$/.test(header.trim()))
    return Number(header.trim()) * 1e3;
  const date = Date.parse(header);
  return Number.isNaN(date) ? void 0 : Math.max(0, date - Date.now());
}
function decimal2(value, name) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} must be a canonical decimal string`);
  }
  return BigInt(value);
}
function hexTarget(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{1,64}$/.test(value)) {
    throw new TypeError("shareTarget must be lower-case hex");
  }
  return BigInt("0x" + value);
}
function parseStatus(value) {
  const needed = value.needed;
  if (needed === null || typeof needed !== "object" || typeof value.root !== "string") {
    throw new TypeError("not a store status");
  }
  if (typeof value.stored !== "boolean")
    throw new TypeError("stored must be a boolean");
  return {
    root: value.root,
    bytes: decimal2(value.bytes, "bytes"),
    needed: Object.fromEntries(Object.entries(needed).map(([chain, coins]) => [chain, decimal2(coins, "needed")])),
    credit: decimal2(value.credit, "credit"),
    stored: value.stored
  };
}
var SponsorClient = class {
  endpoint;
  #fetch;
  #timeoutMilliseconds;
  #maximumResponseBytes;
  constructor(endpoint, options = {}) {
    this.endpoint = writeURL(endpoint, "sponsor").replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 3e4;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 1024 * 1024;
  }
  async #call(path, body, signal) {
    const timeout = AbortSignal.timeout(this.#timeoutMilliseconds);
    const response = await this.#fetch(`${this.endpoint}/${path}`, {
      method: body === void 0 ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        ...body === void 0 ? {} : { "Content-Type": "application/json" }
      },
      ...body === void 0 ? {} : { body: JSON.stringify(body) },
      redirect: "error",
      signal: signal === void 0 ? timeout : AbortSignal.any([signal, timeout])
    });
    const text = await boundedText2(response, this.#maximumResponseBytes);
    if (text === void 0)
      throw new SponsorError(response.status, "response too large");
    const wait = response.ok ? void 0 : retryAfter(response.headers.get("retry-after"));
    let decoded;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new SponsorError(response.status, response.ok ? "invalid JSON response" : void 0, wait);
    }
    if (!response.ok)
      throw new SponsorError(response.status, errorMessage(decoded), wait);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new SponsorError(response.status, "invalid sponsor response");
    }
    return decoded;
  }
  /**
   * A nonce range to grind. Without `store`, its shares buy `chain`'s fee
   * (and `pay`); with `store`, they pay for that upload instead.
   */
  async requestWork(request2 = {}, signal) {
    const sent = Date.now();
    const work = await this.#call("work", {
      ...request2.client === void 0 ? {} : { client: request2.client },
      ...request2.chain === void 0 ? {} : { chain: request2.chain },
      ...request2.pay === void 0 ? {} : { pay: request2.pay.toString() },
      ...request2.store === void 0 ? {} : { store: request2.store }
    }, signal);
    for (const name of ["client", "assignment", "prefixHex"]) {
      if (typeof work[name] !== "string")
        throw new TypeError(`${name} must be a string`);
    }
    hexToBytes(work.prefixHex);
    return {
      client: work.client,
      assignment: work.assignment,
      prefixHex: work.prefixHex,
      shareTarget: hexTarget(work.shareTarget),
      startNonce: decimal2(work.startNonce, "startNonce"),
      count: decimal2(work.count, "count"),
      fee: decimal2(work.fee, "fee"),
      pay: decimal2(work.pay, "pay"),
      sharesForFee: decimal2(work.sharesForFee, "sharesForFee"),
      // From the request, not the answer: the range never outlives the sponsor's word.
      expiresAt: sent + Number(decimal2(work.expiresInMilliseconds, "expiresInMilliseconds"))
    };
  }
  /** Post one share; answers the client's fee credit on the work's chain, in whole coins. */
  async submitShare(assignment, nonce, signal) {
    const answer = await this.#call("shares", { assignment, nonce: nonce.toString() }, signal);
    return { credit: decimal2(answer.credit, "credit") };
  }
  /**
   * The sponsor's co-signature on `draft` (one signer, the client's, and
   * balanced on its own), paid from `client`'s credit. The sponsored body is
   * the draft plus a credit of `pay` to the client and a debit of the fee and
   * `pay` from the sponsor, which becomes the second signer. It is rebuilt
   * here and must match the sponsor's exactly, so the client never signs a
   * body it did not expect. The client signs `body` and submits it with
   * `signatures` added.
   */
  async sponsorTransaction(client, draft, pay = 0n, signal) {
    const answer = await this.#call("sponsor", {
      client,
      transaction: { signatures: {}, body: toWireTransactionBody(draft) },
      ...pay === 0n ? {} : { pay: pay.toString() }
    }, signal);
    const fee = decimal2(answer.fee, "fee");
    if (decimal2(answer.pay, "pay") !== pay)
      throw new SponsorError(200, "sponsor changed pay");
    const transaction = answer.transaction;
    const sponsor = transaction?.body?.signers?.[1];
    const signer = draft.signers[0];
    if (typeof sponsor !== "string" || signer === void 0 || draft.signers.length !== 1 || sponsor === signer) {
      throw new SponsorError(200, "not a sponsored transaction");
    }
    const body = {
      ...draft,
      accountActions: [
        ...draft.accountActions,
        ...pay > 0n ? [{ owner: signer, delta: pay }] : [],
        { owner: sponsor, delta: -(fee + pay) }
      ],
      signers: [signer, sponsor]
    };
    const expected = JSON.parse(JSON.stringify(toWireTransactionBody(body)));
    if (!sameJSON(expected, transaction.body)) {
      throw new SponsorError(200, "the sponsored body is not the draft plus the fee");
    }
    const entries = Object.entries(transaction.signatures ?? {});
    const [key, value] = entries[0] ?? [];
    if (entries.length !== 1 || key === void 0 || typeof value !== "string" || addressFromMultikey(key) !== sponsor) {
      throw new SponsorError(200, "not the sponsor's signature");
    }
    return { body, signatures: { [key]: value }, fee, pay };
  }
  /** Hold an upload of `volumes` (root included) under `root`, to be paid for in work. */
  async store(root, volumes, signal) {
    return parseStatus(await this.#call("store", { root, volumes }, signal));
  }
  async storeStatus(root, signal) {
    return parseStatus(await this.#call(`store/${encodeURIComponent(root)}`, void 0, signal));
  }
};
function sameJSON(left, right) {
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return left === right;
  }
  if (Array.isArray(left) !== Array.isArray(right))
    return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => sameJSON(left[key], right[key]));
}
function nonceBytes(nonce) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, nonce);
  return bytes;
}
function shareHash(prefixHex, nonce) {
  return sha256.create().update(hexToBytes(prefixHex)).update(nonceBytes(nonce)).digest();
}
async function* grind(work, signal) {
  const midstate = sha256.create().update(hexToBytes(work.prefixHex));
  const target = new Uint8Array(32);
  for (let index = 31, rest = work.shareTarget; index >= 0; index -= 1, rest >>= 8n) {
    target[index] = Number(rest & 0xffn);
  }
  const nonceBuffer = new Uint8Array(8);
  const view = new DataView(nonceBuffer.buffer);
  signal?.throwIfAborted();
  const end = work.startNonce + work.count;
  for (let nonce = work.startNonce, step = 0; nonce < end; nonce += 1n, step += 1) {
    if (step % 16384 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
      if (Date.now() >= work.expiresAt)
        return;
    }
    view.setBigUint64(0, nonce);
    if (atMost(midstate.clone().update(nonceBuffer).digest(), target)) {
      yield nonce;
      signal?.throwIfAborted();
      if (Date.now() >= work.expiresAt)
        return;
    }
  }
}
function atMost(hash, target) {
  for (let index = 0; index < 32; index += 1) {
    if (hash[index] !== target[index])
      return hash[index] < target[index];
  }
  return true;
}

// ../relay/dist/index.js
var SUBMISSION_REFUSALS = [
  "belowMinRelayFee",
  "feeTooLow",
  // Nodes before the funded-only pool; newer ones say feeTooLow.
  "conflictingNonce",
  "nonceAhead",
  "unavailable",
  "insufficientFunds",
  "invalidState",
  "tooLarge",
  "full",
  "unresolved",
  "contextChanged",
  "unknownChain",
  "shuttingDown",
  "requestTooLarge"
];
function namedRefusal(refusal3) {
  return SUBMISSION_REFUSALS.find((name) => name === refusal3);
}
var SubmissionError = class extends Error {
  status;
  /** The node's refusal text, verbatim. */
  refusal;
  /** Set when `refusal` is one of {@link SUBMISSION_REFUSALS}. */
  reason;
  constructor(status, refusal3) {
    super(refusal3 ?? `submission failed with HTTP ${status}`);
    this.name = "SubmissionError";
    this.status = status;
    if (refusal3 !== void 0)
      this.refusal = refusal3;
    const reason = namedRefusal(refusal3);
    if (reason !== void 0)
      this.reason = reason;
  }
};
function canonicalCount(value, name) {
  if (value === void 0)
    return void 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}
var HTTPTransactionSubmitter = class {
  endpoint;
  #fetch;
  #timeoutMilliseconds;
  #maximumResponseBytes;
  #authorization;
  constructor(endpoint, options = {}) {
    this.endpoint = writeURL(endpoint, "submission");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 8e3;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 1024 * 1024;
    this.#authorization = options.authorization;
  }
  async submit(payload, signal) {
    const timeout = AbortSignal.timeout(this.#timeoutMilliseconds);
    const combined = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
    const response = await this.#fetch(this.endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...this.#authorization === void 0 ? {} : { Authorization: this.#authorization }
      },
      body: JSON.stringify(payload),
      // A redirect would re-send the payload (and any Authorization) where
      // the answering host points; node routes never redirect.
      redirect: "error",
      signal: combined
    });
    const text = await boundedText2(response, this.#maximumResponseBytes);
    if (text === void 0)
      throw new SubmissionError(response.status, "response too large");
    let decoded;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new SubmissionError(response.status, response.ok ? "invalid JSON response" : void 0);
    }
    if (!response.ok)
      throw new SubmissionError(response.status, errorMessage(decoded));
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new SubmissionError(response.status, "invalid submission response");
    }
    const body = decoded;
    if (typeof body.transactionCID !== "string") {
      throw new SubmissionError(response.status, "submission response omitted transactionCID");
    }
    const mempoolCount = canonicalCount(body.mempoolCount, "mempoolCount");
    const mempoolBytes = canonicalCount(body.mempoolBytes, "mempoolBytes");
    return {
      transactionCID: body.transactionCID,
      ...mempoolCount === void 0 ? {} : { mempoolCount },
      ...mempoolBytes === void 0 ? {} : { mempoolBytes }
    };
  }
};

// ../volumes/dist/batch.js
function allAborted(signals) {
  if (signals.some((signal) => signal === void 0))
    return void 0;
  if (signals.length === 1)
    return signals[0];
  const all = new AbortController();
  const check = () => {
    if (signals.every((signal) => signal.aborted))
      all.abort(signals[0].reason);
  };
  for (const signal of signals)
    signal.addEventListener("abort", check, { once: true });
  check();
  return all.signal;
}
var BatchingVolumeTransport = class {
  #transport;
  #maximumBatch;
  #window;
  #backoff;
  #now;
  #waiting = [];
  #timer;
  /** Until when reads go one at a time: Infinity once the route is refused. */
  #aloneUntil = 0;
  constructor(transport, options = {}) {
    this.#transport = transport;
    this.#maximumBatch = options.maximumBatch ?? 32;
    this.#window = options.windowMilliseconds ?? 4;
    this.#backoff = options.backoffMilliseconds ?? 3e4;
    this.#now = options.now ?? Date.now;
  }
  #alone(rootCID, signal) {
    return Promise.resolve().then(() => this.#transport.getVolume(rootCID, signal));
  }
  getVolume(rootCID, signal) {
    if (this.#now() < this.#aloneUntil)
      return this.#alone(rootCID, signal);
    if (signal?.aborted)
      return Promise.reject(signal.reason);
    const read = new Promise((resolve, reject) => {
      this.#waiting.push({ rootCID, signal, resolve, reject });
    });
    if (this.#waiting.length >= this.#maximumBatch)
      this.#flush();
    else
      this.#timer ??= setTimeout(() => this.#flush(), this.#window);
    if (signal === void 0)
      return read;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      read.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  #flush() {
    clearTimeout(this.#timer);
    this.#timer = void 0;
    const batch = this.#waiting.filter(({ signal }) => !signal?.aborted);
    this.#waiting = [];
    void this.#ask(batch).catch((error) => {
      for (const { reject } of batch)
        reject(error);
    });
  }
  async #ask(batch) {
    const byRoot = /* @__PURE__ */ new Map();
    for (const waiting of batch) {
      byRoot.set(waiting.rootCID, [...byRoot.get(waiting.rootCID) ?? [], waiting]);
    }
    let found = /* @__PURE__ */ new Map();
    if (byRoot.size > 1 && this.#now() >= this.#aloneUntil) {
      try {
        found = await this.#transport.getVolumes([...byRoot.keys()]);
      } catch (error) {
        if (!(error instanceof VolumeTransportError)) {
          for (const waiting of batch)
            waiting.reject(error);
          return;
        }
        const refused = error instanceof VolumeTransportError && [400, 403, 404, 405, 501].includes(error.status ?? 0);
        this.#aloneUntil = refused ? Infinity : this.#now() + this.#backoff;
      }
    }
    for (const [rootCID, waiting] of byRoot) {
      const volume = found.get(rootCID);
      const read = volume !== void 0 ? Promise.resolve(volume) : this.#alone(rootCID, allAborted(waiting.map(({ signal }) => signal)));
      read.then((answer) => waiting.forEach(({ resolve }) => resolve(answer)), (error) => waiting.forEach(({ reject }) => reject(error)));
    }
  }
};
var MANY_VOLUMES_MEDIA_TYPE = "application/vnd.lattice.volumes";
function decodeVolumeRecords(body) {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const decoder2 = new TextDecoder("utf-8", { fatal: true });
  const records = [];
  let offset = 0;
  const need = (length) => {
    if (offset + length > body.byteLength) {
      throw new VolumeTransportError("invalid many-Volumes answer: truncated record");
    }
  };
  while (offset < body.byteLength) {
    need(2);
    const rootLength = view.getUint16(offset);
    offset += 2;
    need(rootLength);
    const rootCID = decoder2.decode(body.subarray(offset, offset + rootLength));
    offset += rootLength;
    need(4);
    const archiveLength = view.getUint32(offset);
    offset += 4;
    need(archiveLength);
    records.push({ rootCID, archive: body.subarray(offset, offset + archiveLength) });
    offset += archiveLength;
  }
  return records;
}

// ../volumes/dist/cache.js
var volumeBytes = (entries) => entries.reduce((total, entry) => total + entry.bytes.byteLength, 0);
var MemoryVolumeCache = class {
  maximumBytes;
  #volumes = /* @__PURE__ */ new Map();
  #bytes = 0;
  constructor({ maximumBytes = 32 * 1024 * 1024 } = {}) {
    this.maximumBytes = maximumBytes;
  }
  async get(rootCID) {
    const kept = this.#volumes.get(rootCID);
    if (kept === void 0)
      return void 0;
    this.#volumes.delete(rootCID);
    this.#volumes.set(rootCID, kept);
    return kept.volume;
  }
  async put(volume) {
    const entries = volume.entries();
    const bytes = volumeBytes(entries);
    if (bytes > this.maximumBytes || this.#volumes.has(volume.rootCID))
      return;
    this.#volumes.set(volume.rootCID, { volume: { rootCID: volume.rootCID, entries }, bytes });
    this.#bytes += bytes;
    for (const [rootCID, kept] of this.#volumes) {
      if (this.#bytes <= this.maximumBytes)
        break;
      this.#volumes.delete(rootCID);
      this.#bytes -= kept.bytes;
    }
  }
  async delete(rootCID) {
    const kept = this.#volumes.get(rootCID);
    if (kept === void 0)
      return;
    this.#volumes.delete(rootCID);
    this.#bytes -= kept.bytes;
  }
};
var VOLUMES = "volumes";
var USED = "used";
var TOTAL = "total";
var isUsed = (value) => typeof value === "object" && value !== null && typeof value.rootCID === "string" && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && Number.isFinite(value.used);
var isVolume = (value, rootCID) => typeof value === "object" && value !== null && value.rootCID === rootCID && Array.isArray(value.entries) && value.entries.every((entry) => typeof entry?.cid === "string" && entry.bytes instanceof Uint8Array);
var IndexedDBVolumeCache = class {
  maximumBytes;
  #database;
  #now;
  #touchAfter;
  // The read transaction lookups share while it is active.
  #reading = null;
  // Hits not yet written as used: root CID → when.
  #touched = /* @__PURE__ */ new Map();
  #touching = null;
  constructor({ name = "lattice-volumes", maximumBytes = 64 * 1024 * 1024, indexedDB = globalThis.indexedDB, now = Date.now, touchAfterMilliseconds = 1e3 } = {}) {
    this.maximumBytes = maximumBytes;
    this.#now = now;
    this.#touchAfter = touchAfterMilliseconds;
    this.#database = open(indexedDB, name).catch(() => null);
  }
  async get(rootCID) {
    try {
      const database = await this.#database;
      if (database === null)
        return void 0;
      const kept = await request(this.#lookup(database, rootCID));
      if (kept === void 0)
        return void 0;
      if (!isVolume(kept, rootCID)) {
        void this.delete(rootCID);
        return void 0;
      }
      this.#touch(rootCID);
      return kept;
    } catch {
      return void 0;
    }
  }
  /** A lookup in the read transaction now active, or in a new one. */
  #lookup(database, rootCID) {
    if (this.#reading !== null) {
      try {
        return this.#reading.get(rootCID);
      } catch {
      }
    }
    const transaction = database.transaction(VOLUMES);
    const store = transaction.objectStore(VOLUMES);
    this.#reading = store;
    const finished = () => {
      if (this.#reading === store)
        this.#reading = null;
    };
    transaction.oncomplete = finished;
    transaction.onabort = finished;
    return store.get(rootCID);
  }
  /** Marks `rootCID` used now, written with the others in a moment. */
  #touch(rootCID) {
    this.#touched.set(rootCID, this.#now());
    this.#touching ??= setTimeout(() => void this.#writeTouches(), this.#touchAfter);
  }
  /** Writes the hits made since the last write, in one transaction. */
  async #writeTouches() {
    this.#touching = null;
    if (this.#touched.size === 0)
      return;
    try {
      const database = await this.#database;
      if (database === null)
        return;
      const transaction = database.transaction(USED, "readwrite");
      const done = completion(transaction);
      await this.#applyTouches(transaction.objectStore(USED));
      await done;
    } catch {
    }
  }
  /** Writes the pending hits as used, in `used`'s transaction: a few bytes each, never the Volume. */
  async #applyTouches(used) {
    const touched = [...this.#touched];
    this.#touched.clear();
    const records = await Promise.all(touched.map(([rootCID]) => request(used.get(rootCID))));
    records.forEach((record3, n) => {
      if (isUsed(record3))
        used.put({ ...record3, used: Math.max(record3.used, touched[n][1]) });
    });
  }
  async put(volume) {
    try {
      const database = await this.#database;
      if (database === null)
        return;
      const entries = volume.entries();
      const bytes = volumeBytes(entries);
      if (bytes > this.maximumBytes)
        return;
      const transaction = database.transaction([VOLUMES, USED, TOTAL], "readwrite");
      const volumes = transaction.objectStore(VOLUMES);
      const used = transaction.objectStore(USED);
      const totals = transaction.objectStore(TOTAL);
      const done = completion(transaction);
      await this.#applyTouches(used);
      if (await request(volumes.count(volume.rootCID)) > 0)
        return void await done;
      let total = await totalOf(totals, used);
      volumes.put({ rootCID: volume.rootCID, entries });
      used.put({ rootCID: volume.rootCID, bytes, used: this.#now() });
      total += bytes;
      await cursor(used.index("used").openCursor(), (oldest) => {
        if (total <= this.maximumBytes)
          return false;
        const record3 = oldest.value;
        if (isUsed(record3))
          total -= record3.bytes;
        volumes.delete(oldest.primaryKey);
        oldest.delete();
        return true;
      });
      totals.put(Math.max(0, total), TOTAL);
      await done;
    } catch {
    }
  }
  async delete(rootCID) {
    try {
      const database = await this.#database;
      if (database === null)
        return;
      const transaction = database.transaction([VOLUMES, USED, TOTAL], "readwrite");
      const used = transaction.objectStore(USED);
      const totals = transaction.objectStore(TOTAL);
      const done = completion(transaction);
      const total = await totalOf(totals, used);
      const record3 = await request(used.get(rootCID));
      transaction.objectStore(VOLUMES).delete(rootCID);
      used.delete(rootCID);
      totals.put(Math.max(0, total - (isUsed(record3) ? record3.bytes : 0)), TOTAL);
      await done;
    } catch {
    }
  }
};
async function open(factory, name) {
  if (factory === void 0)
    return null;
  const opening = factory.open(name, 1);
  opening.onupgradeneeded = () => {
    const database2 = opening.result;
    database2.createObjectStore(VOLUMES, { keyPath: "rootCID" });
    database2.createObjectStore(USED, { keyPath: "rootCID" }).createIndex("used", "used");
    database2.createObjectStore(TOTAL);
  };
  const database = await new Promise((resolve, reject) => {
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => resolve(null);
  });
  if (database !== null)
    database.onversionchange = () => database.close();
  return database;
}
async function totalOf(totals, used) {
  const stored = await request(totals.get(TOTAL));
  if (Number.isSafeInteger(stored) && stored >= 0)
    return stored;
  let total = 0;
  const volumes = used.transaction.objectStore(VOLUMES);
  await cursor(used.openCursor(), (record3) => {
    if (isUsed(record3.value))
      total += record3.value.bytes;
    else {
      volumes.delete(record3.primaryKey);
      record3.delete();
    }
  });
  return total;
}
function request(pending) {
  return new Promise((resolve, reject) => {
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error);
  });
}
function completion(transaction) {
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
  done.catch(() => {
  });
  return done;
}
function cursor(pending, visit) {
  return new Promise((resolve, reject) => {
    pending.onsuccess = () => {
      const at = pending.result;
      if (at === null || visit(at) === false)
        return resolve();
      at.continue();
    };
    pending.onerror = () => reject(pending.error);
  });
}

// ../volumes/dist/index.js
var VOLUME_ARCHIVE_MEDIA_TYPE = "application/vnd.lattice.volume";
var MAXIMUM_VOLUME_ARCHIVE_BYTES = 64 * 1024 * 1024;
var MAXIMUM_VOLUME_ARCHIVE_ENTRIES = 65535;
var MAXIMUM_VOLUME_CID_BYTES = 8192;
var DEFAULT_VOLUME_LIMITS = {
  maximumEntries: 4096,
  maximumBytes: 64 * 1024 * 1024
};
var VolumeError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "VolumeError";
    this.code = code;
  }
};
var VolumeTransportError = class extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.name = "VolumeTransportError";
    if (status !== void 0)
      this.status = status;
  }
};
var VerifiedVolume = class {
  rootCID;
  #entries;
  constructor(rootCID, entries) {
    this.rootCID = rootCID;
    this.#entries = entries;
  }
  get size() {
    return this.#entries.size;
  }
  has(cid) {
    return this.#entries.has(cid);
  }
  bytes(cid) {
    return this.#entries.get(cid)?.slice();
  }
  rootBytes() {
    return this.#entries.get(this.rootCID).slice();
  }
  decodeRoot() {
    return decodeDagCbor(this.rootBytes());
  }
  entries() {
    return [...this.#entries].map(([cid, bytes]) => ({ cid, bytes: bytes.slice() }));
  }
};
function verifyVolume(volume, expectedRoot = volume.rootCID, limits = DEFAULT_VOLUME_LIMITS) {
  if (volume.rootCID !== expectedRoot) {
    throw new VolumeError("wrong-root", `expected Volume ${expectedRoot}, got ${volume.rootCID}`);
  }
  if (volume.entries.length > limits.maximumEntries) {
    throw new VolumeError("too-many-entries", "Volume exceeds the entry limit");
  }
  const entries = /* @__PURE__ */ new Map();
  let totalBytes = 0;
  for (const entry of volume.entries) {
    if (entries.has(entry.cid)) {
      throw new VolumeError("duplicate-entry", `Volume repeats ${entry.cid}`);
    }
    totalBytes += entry.bytes.byteLength;
    if (totalBytes > limits.maximumBytes) {
      throw new VolumeError("too-large", "Volume exceeds the byte limit");
    }
    try {
      assertCID(entry.cid, entry.bytes);
    } catch (error) {
      throw new VolumeError("invalid-entry", error instanceof Error ? error.message : `invalid Volume entry ${entry.cid}`);
    }
    entries.set(entry.cid, entry.bytes.slice());
  }
  if (!entries.has(expectedRoot)) {
    throw new VolumeError("missing-root", `Volume does not contain its root ${expectedRoot}`);
  }
  return new VerifiedVolume(expectedRoot, entries);
}
var VolumeClient = class {
  #transport;
  #limits;
  #cache;
  #cacheWait;
  constructor(transport, limits = DEFAULT_VOLUME_LIMITS, options = {}) {
    this.#transport = transport;
    this.#limits = limits;
    this.#cache = options.cache;
    this.#cacheWait = options.cacheWaitMilliseconds ?? 1e3;
  }
  async get(rootCID, signal) {
    const kept = await this.#kept(rootCID, signal);
    if (kept !== void 0)
      return kept;
    signal?.throwIfAborted();
    const serialized = await this.#transport.getVolume(rootCID, signal);
    if (serialized === null)
      throw new VolumeError("not-found", `Volume ${rootCID} was not found`);
    const volume = verifyVolume(serialized, rootCID, this.#limits);
    const cache = this.#cache;
    if (cache !== void 0)
      void Promise.resolve().then(() => cache.put(volume)).catch(() => {
      });
    return volume;
  }
  /**
   * The cache's Volume for `rootCID`, verified here under this client's
   * limits as if it had just been fetched; a Volume that fails is dropped
   * from the cache. A cache that fails, or keeps the read waiting past
   * `cacheWaitMilliseconds` or its abort, is a miss.
   */
  async #kept(rootCID, signal) {
    const cache = this.#cache;
    if (cache === void 0)
      return void 0;
    let timer;
    let abort;
    const kept = await Promise.race([
      Promise.resolve().then(() => cache.get(rootCID)),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(void 0), this.#cacheWait);
        abort = () => resolve(void 0);
        signal?.addEventListener("abort", abort, { once: true });
      })
    ]).catch(() => void 0).finally(() => {
      clearTimeout(timer);
      if (abort !== void 0)
        signal?.removeEventListener("abort", abort);
    });
    if (kept === void 0)
      return void 0;
    try {
      return verifyVolume(kept, rootCID, this.#limits);
    } catch {
      void Promise.resolve().then(() => cache.delete?.(rootCID)).catch(() => {
      });
      return void 0;
    }
  }
};
var MemoryVolumeTransport = class {
  #volumes = /* @__PURE__ */ new Map();
  constructor(volumes = []) {
    for (const volume of volumes)
      this.put(volume);
  }
  put(volume) {
    this.#volumes.set(volume.rootCID, {
      rootCID: volume.rootCID,
      entries: volume.entries.map(({ cid, bytes }) => ({ cid, bytes: bytes.slice() }))
    });
  }
  async getVolume(rootCID, _signal) {
    const volume = this.#volumes.get(rootCID);
    if (volume === void 0)
      return null;
    return {
      rootCID: volume.rootCID,
      entries: volume.entries.map(({ cid, bytes }) => ({ cid, bytes: bytes.slice() }))
    };
  }
};
function archiveFailure(message) {
  throw new VolumeTransportError(`invalid Volume archive: ${message}`);
}
function checkedUInt16(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) {
    archiveFailure(`${name} exceeds UInt16`);
  }
  return value;
}
function checkedUInt32(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 4294967295) {
    archiveFailure(`${name} exceeds UInt32`);
  }
  return value;
}
function encodeVolumeArchive(volume) {
  const verified = verifyVolume(volume, volume.rootCID, {
    maximumEntries: MAXIMUM_VOLUME_ARCHIVE_ENTRIES,
    maximumBytes: MAXIMUM_VOLUME_ARCHIVE_BYTES
  });
  const encoder = new TextEncoder();
  const entries = [...verified.entries()].sort((left, right) => left.cid < right.cid ? -1 : left.cid > right.cid ? 1 : 0);
  checkedUInt16(entries.length, "entry count");
  const encoded = entries.map((entry) => {
    const cid = encoder.encode(entry.cid);
    if (cid.byteLength > MAXIMUM_VOLUME_CID_BYTES)
      archiveFailure("CID is too long");
    checkedUInt16(cid.byteLength, "CID length");
    checkedUInt32(entry.bytes.byteLength, "entry length");
    return { cid, bytes: entry.bytes };
  });
  const length = encoded.reduce((total, entry) => total + 2 + entry.cid.byteLength + 4 + entry.bytes.byteLength, 2);
  if (length > MAXIMUM_VOLUME_ARCHIVE_BYTES)
    archiveFailure("archive is too large");
  const archive = new Uint8Array(length);
  const view = new DataView(archive.buffer);
  view.setUint16(0, encoded.length);
  let offset = 2;
  for (const entry of encoded) {
    view.setUint16(offset, entry.cid.byteLength);
    offset += 2;
    archive.set(entry.cid, offset);
    offset += entry.cid.byteLength;
    view.setUint32(offset, entry.bytes.byteLength);
    offset += 4;
    archive.set(entry.bytes, offset);
    offset += entry.bytes.byteLength;
  }
  return archive;
}
function decodeVolumeArchive(rootCID, archive, limits = DEFAULT_VOLUME_LIMITS) {
  if (archive.byteLength === 0 || archive.byteLength > MAXIMUM_VOLUME_ARCHIVE_BYTES) {
    archiveFailure("archive is empty or too large");
  }
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let offset = 0;
  const requireBytes = (count2) => {
    if (count2 < 0 || offset + count2 > archive.byteLength)
      archiveFailure("truncated field");
  };
  const uint16 = () => {
    requireBytes(2);
    const value = view.getUint16(offset);
    offset += 2;
    return value;
  };
  const uint32 = () => {
    requireBytes(4);
    const value = view.getUint32(offset);
    offset += 4;
    return value;
  };
  const count = uint16();
  if (count === 0)
    archiveFailure("archive has no entries");
  if (count > limits.maximumEntries)
    archiveFailure("archive exceeds the entry limit");
  const decoder2 = new TextDecoder("utf-8", { fatal: true });
  const entries = [];
  let previous;
  let payloadBytes = 0;
  for (let index = 0; index < count; index += 1) {
    const cidLength = uint16();
    if (cidLength > MAXIMUM_VOLUME_CID_BYTES)
      archiveFailure("CID is too long");
    requireBytes(cidLength);
    let cid;
    try {
      cid = decoder2.decode(archive.subarray(offset, offset + cidLength));
    } catch {
      archiveFailure("CID is not UTF-8");
    }
    offset += cidLength;
    if (previous !== void 0 && previous >= cid) {
      archiveFailure("entries are duplicated or out of order");
    }
    const dataLength = uint32();
    requireBytes(dataLength);
    payloadBytes += dataLength;
    if (payloadBytes > limits.maximumBytes)
      archiveFailure("archive exceeds the byte limit");
    entries.push({ cid, bytes: archive.slice(offset, offset + dataLength) });
    offset += dataLength;
    previous = cid;
  }
  if (offset !== archive.byteLength)
    archiveFailure("archive has trailing bytes");
  verifyVolume({ rootCID, entries }, rootCID, limits);
  return { rootCID, entries };
}
function isLoopback3(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.[0-9]{1,3}){3}$/.test(host);
}
function contentBaseURL(input) {
  const url = new URL(input);
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("content URL must not contain credentials, query parameters, or a fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback3(url.hostname))) {
    throw new Error("content URL must use HTTPS, except for loopback HTTP");
  }
  if (!url.pathname.endsWith("/"))
    url.pathname += "/";
  return url;
}
async function boundedBytes(response, maximumBytes) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      throw new VolumeTransportError("Volume response is too large", response.status);
    }
  }
  if (response.body === null)
    return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done)
      break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new VolumeTransportError("Volume response is too large", response.status);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
var HTTPVolumeTransport = class {
  endpoint;
  #fetch;
  #timeoutMilliseconds;
  #limits;
  #authorization;
  #chainPath;
  constructor(endpoint, options = {}) {
    this.endpoint = contentBaseURL(endpoint).toString();
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 15e3;
    this.#limits = options.limits ?? DEFAULT_VOLUME_LIMITS;
    this.#authorization = options.authorization;
    if (options.chainPath !== void 0) {
      if (options.chainPath.length === 0 || options.chainPath.some((component) => component === "")) {
        throw new Error("content chainPath must contain nonempty components");
      }
      this.#chainPath = options.chainPath.join("/");
    }
  }
  async getVolume(rootCID, signal) {
    const url = new URL(encodeURIComponent(rootCID), this.endpoint);
    if (this.#chainPath !== void 0)
      url.searchParams.set("chainPath", this.#chainPath);
    const timeout = AbortSignal.timeout(this.#timeoutMilliseconds);
    const combined = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
    const response = await this.#fetch(url, {
      headers: {
        Accept: VOLUME_ARCHIVE_MEDIA_TYPE,
        ...this.#authorization === void 0 ? {} : { Authorization: this.#authorization }
      },
      redirect: "error",
      signal: combined
    });
    if (response.status === 404)
      return null;
    if (!response.ok)
      throw new VolumeTransportError(`content gateway returned HTTP ${response.status}`, response.status);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== VOLUME_ARCHIVE_MEDIA_TYPE) {
      throw new VolumeTransportError(`content gateway returned ${mediaType ?? "no content type"}`, response.status);
    }
    const archive = await boundedBytes(response, MAXIMUM_VOLUME_ARCHIVE_BYTES);
    return decodeVolumeArchive(rootCID, archive, this.#limits);
  }
  /**
   * The Volumes the gateway holds of `rootCIDs`, in one request. A record
   * for a root not asked for is ignored; one that fails to decode fails the
   * lot, as a single read would.
   */
  async getVolumes(rootCIDs, signal) {
    const url = new URL(this.endpoint.replace(/\/+$/, ""));
    url.searchParams.set("cids", rootCIDs.join(","));
    if (this.#chainPath !== void 0)
      url.searchParams.set("chainPath", this.#chainPath);
    const timeout = AbortSignal.timeout(this.#timeoutMilliseconds);
    const combined = signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
    const response = await this.#fetch(url, {
      headers: {
        Accept: MANY_VOLUMES_MEDIA_TYPE,
        ...this.#authorization === void 0 ? {} : { Authorization: this.#authorization }
      },
      redirect: "error",
      signal: combined
    });
    if (!response.ok)
      throw new VolumeTransportError(`content gateway returned HTTP ${response.status}`, response.status);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== MANY_VOLUMES_MEDIA_TYPE) {
      throw new VolumeTransportError(`content gateway returned ${mediaType ?? "no content type"}`, response.status);
    }
    const asked = new Set(rootCIDs);
    const found = /* @__PURE__ */ new Map();
    const body = await boundedBytes(response, MAXIMUM_VOLUME_ARCHIVE_BYTES);
    for (const { rootCID, archive } of decodeVolumeRecords(body)) {
      if (asked.has(rootCID))
        found.set(rootCID, decodeVolumeArchive(rootCID, archive, this.#limits));
    }
    return found;
  }
};
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array) ? value : void 0;
}
function referencedCID(value) {
  if (value === void 0)
    return void 0;
  const header = object(value);
  return typeof header?.rawCID === "string" ? header.rawCID : void 0;
}
function verifyUint64SparseProof(proof) {
  if (proof.value !== void 0 && (proof.value < 0n || proof.value > 0xffffffffffffffffn)) {
    return false;
  }
  let volume;
  try {
    volume = verifyVolume({ rootCID: proof.rootCID, entries: proof.entries });
  } catch {
    return false;
  }
  let cid = proof.rootCID;
  let remaining = proof.key;
  const visited = /* @__PURE__ */ new Set();
  while (true) {
    if (visited.has(cid))
      return false;
    visited.add(cid);
    const bytes = volume.bytes(cid);
    if (bytes === void 0)
      return false;
    let node;
    try {
      node = object(decodeDagCbor(bytes));
    } catch {
      return false;
    }
    if (node === void 0)
      return false;
    if (node.prefix !== void 0) {
      if (typeof node.prefix !== "string")
        return false;
      if (!remaining.startsWith(node.prefix))
        return proof.value === void 0;
      remaining = remaining.slice(node.prefix.length);
    }
    if (remaining.length === 0) {
      if (node.value === void 0)
        return proof.value === void 0;
      return typeof node.value === "bigint" && node.value === proof.value;
    }
    if (!Array.isArray(node.children))
      return false;
    let next;
    for (const childValue of node.children) {
      const child = object(childValue);
      if (child === void 0 || typeof child.key !== "string" || child.key.length !== 1) {
        return false;
      }
      const childCID = referencedCID(child.value);
      if (childCID === void 0)
        return false;
      if (child.key === remaining[0]) {
        if (next !== void 0)
          return false;
        next = childCID;
      }
    }
    if (next === void 0)
      return proof.value === void 0;
    if (!volume.has(next))
      return false;
    cid = next;
  }
}

// dist/share-search.js
function searchShares(prefixHex, targetHex2, start, count) {
  const K = new Int32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  const expand = (words2, offset, W) => {
    for (let i = 0; i < 16; i++)
      W[i] = words2[offset + i];
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15];
      const w2 = W[i - 2];
      const s0 = (w15 >>> 7 | w15 << 25) ^ (w15 >>> 18 | w15 << 14) ^ w15 >>> 3;
      const s1 = (w2 >>> 17 | w2 << 15) ^ (w2 >>> 19 | w2 << 13) ^ w2 >>> 10;
      W[i] = W[i - 16] + s0 + W[i - 7] + s1 | 0;
    }
  };
  const compress = (state2, W) => {
    let a = state2[0];
    let b = state2[1];
    let c = state2[2];
    let d = state2[3];
    let e = state2[4];
    let f = state2[5];
    let g = state2[6];
    let h = state2[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
      const t1 = h + S1 + (e & f ^ ~e & g) + K[i] + W[i] | 0;
      const S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
      const t2 = S0 + (a & b ^ a & c ^ b & c) | 0;
      h = g;
      g = f;
      f = e;
      e = d + t1 | 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 | 0;
    }
    state2[0] = state2[0] + a | 0;
    state2[1] = state2[1] + b | 0;
    state2[2] = state2[2] + c | 0;
    state2[3] = state2[3] + d | 0;
    state2[4] = state2[4] + e | 0;
    state2[5] = state2[5] + f | 0;
    state2[6] = state2[6] + g | 0;
    state2[7] = state2[7] + h | 0;
  };
  if (!/^(?:[0-9a-f]{2})*$/.test(prefixHex) || !/^[0-9a-f]{64}$/.test(targetHex2)) {
    throw new TypeError("prefix must be hex and the target 64 hex digits");
  }
  const prefixLength = prefixHex.length / 2;
  const blocks = Math.ceil((prefixLength + 8 + 9) / 64);
  const message = new Uint8Array(blocks * 64);
  for (let i = 0; i < prefixLength; i++) {
    message[i] = parseInt(prefixHex.slice(i * 2, i * 2 + 2), 16);
  }
  message[prefixLength + 8] = 128;
  const bits = (prefixLength + 8) * 8;
  message[message.length - 4] = bits >>> 24 & 255;
  message[message.length - 3] = bits >>> 16 & 255;
  message[message.length - 2] = bits >>> 8 & 255;
  message[message.length - 1] = bits & 255;
  const words = new Int32Array(blocks * 16);
  const readWords = (from, to) => {
    for (let i = from; i < to; i++) {
      words[i] = message[i * 4] << 24 | message[i * 4 + 1] << 16 | message[i * 4 + 2] << 8 | message[i * 4 + 3];
    }
  };
  readWords(0, words.length);
  const first = Math.floor(prefixLength / 64);
  const last = Math.floor((prefixLength + 7) / 64);
  const schedules = Array.from({ length: blocks }, () => new Int32Array(64));
  for (let block = 0; block < blocks; block++)
    expand(words, block * 16, schedules[block]);
  const midstate = new Int32Array([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);
  for (let block = 0; block < first; block++)
    compress(midstate, schedules[block]);
  const target = new Uint32Array(8);
  for (let i = 0; i < 8; i++)
    target[i] = parseInt(targetHex2.slice(i * 8, i * 8 + 8), 16);
  const found = [];
  const state = new Int32Array(8);
  const fromWord = Math.floor(prefixLength / 4);
  const toWord = Math.floor((prefixLength + 7) / 4) + 1;
  let high = Number(start >> 32n);
  let low = Number(start & 0xffffffffn);
  for (let n = 0; n < count; n++) {
    message[prefixLength] = high >>> 24;
    message[prefixLength + 1] = high >>> 16 & 255;
    message[prefixLength + 2] = high >>> 8 & 255;
    message[prefixLength + 3] = high & 255;
    message[prefixLength + 4] = low >>> 24;
    message[prefixLength + 5] = low >>> 16 & 255;
    message[prefixLength + 6] = low >>> 8 & 255;
    message[prefixLength + 7] = low & 255;
    readWords(fromWord, toWord);
    state.set(midstate);
    for (let block = first; block < blocks; block++) {
      if (block <= last)
        expand(words, block * 16, schedules[block]);
      compress(state, schedules[block]);
    }
    for (let i = 0; i < 8; i++) {
      const word = state[i] >>> 0;
      if (word !== target[i]) {
        if (word < target[i])
          found.push(BigInt(high) << 32n | BigInt(low));
        break;
      }
      if (i === 7)
        found.push(BigInt(high) << 32n | BigInt(low));
    }
    low = low + 1 >>> 0;
    if (low === 0)
      high = high + 1 >>> 0;
  }
  return found;
}
var STEP = 1 << 16;
function shareWorker(search) {
  const scope = globalThis;
  const postMessage = (message) => scope.postMessage(message);
  scope.onmessage = ({ data }) => {
    const { prefixHex, targetHex: targetHex2, start, end } = data;
    for (let nonce = start; nonce < end; ) {
      const count = Number(end - nonce < 65536n ? end - nonce : 65536n);
      for (const share of search(prefixHex, targetHex2, nonce, count))
        postMessage({ share });
      postMessage({ hashes: count });
      nonce += BigInt(count);
    }
    postMessage({ done: true });
  };
}
function targetHex(work) {
  return work.shareTarget.toString(16).padStart(64, "0");
}
function defaultWorkers() {
  if (typeof Worker === "undefined" || typeof Blob === "undefined")
    return 0;
  return Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1);
}
async function* findShares(work, options = {}) {
  const workers = options.workers ?? defaultWorkers();
  const started = workers > 0 ? startWorkers(work, workers) : void 0;
  if (started === void 0) {
    yield* searchHere(work, options);
    return;
  }
  const { pool, events, url } = started;
  const queue = [];
  const yielded = /* @__PURE__ */ new Set();
  let finished = 0;
  let failure;
  let fallBack = false;
  let wake;
  events.onShare = (share) => {
    queue.push(share);
    wake?.();
  };
  events.onHashes = (hashes2) => options.onHashes?.(hashes2);
  events.onDone = () => {
    finished += 1;
    wake?.();
  };
  events.onError = (error, answered) => {
    if (answered)
      failure = error;
    else
      fallBack = true;
    wake?.();
  };
  const abort = () => wake?.();
  options.signal?.addEventListener("abort", abort);
  try {
    while (true) {
      options.signal?.throwIfAborted();
      if (failure !== void 0)
        throw failure;
      if (fallBack)
        break;
      const share = queue.shift();
      if (share !== void 0) {
        yielded.add(share);
        yield share;
        continue;
      }
      if (finished === pool.length || Date.now() >= work.expiresAt)
        return;
      let timer;
      await new Promise((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, Math.min(2147483647, Math.max(0, work.expiresAt - Date.now())));
      });
      clearTimeout(timer);
      wake = void 0;
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    for (const worker of pool)
      worker.terminate();
    URL.revokeObjectURL(url);
  }
  for await (const share of searchHere(work, options)) {
    if (!yielded.has(share))
      yield share;
  }
}
function startWorkers(work, count) {
  const events = {};
  const pool = [];
  let url;
  try {
    const source = `(${shareWorker.toString()})(${searchShares.toString()});`;
    url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  } catch {
    return void 0;
  }
  try {
    const slice = work.count / BigInt(count) + 1n;
    const end = work.startNonce + work.count;
    for (let index = 0n; index < BigInt(count); index++) {
      const start = work.startNonce + index * slice;
      if (start >= end)
        break;
      const worker = new Worker(url);
      let answered = false;
      worker.onmessage = ({ data }) => {
        answered = true;
        if (data.share !== void 0)
          events.onShare?.(data.share);
        else if (data.hashes !== void 0)
          events.onHashes?.(data.hashes);
        else if (data.done)
          events.onDone?.();
      };
      worker.onerror = (event) => {
        event.preventDefault();
        events.onError?.(new Error(`share search failed: ${event.message}`), answered);
      };
      worker.postMessage({
        prefixHex: work.prefixHex,
        targetHex: targetHex(work),
        start,
        end: start + slice < end ? start + slice : end
      });
      pool.push(worker);
    }
  } catch {
    for (const worker of pool)
      worker.terminate();
    URL.revokeObjectURL(url);
    return void 0;
  }
  return { pool, events, url };
}
async function* searchHere(work, options) {
  const target = targetHex(work);
  const end = work.startNonce + work.count;
  for (let nonce = work.startNonce; nonce < end; ) {
    options.signal?.throwIfAborted();
    if (Date.now() >= work.expiresAt)
      return;
    const count = Number(end - nonce < BigInt(STEP) ? end - nonce : BigInt(STEP));
    const shares = searchShares(work.prefixHex, target, nonce, count);
    options.onHashes?.(count);
    nonce += BigInt(count);
    for (const share of shares)
      yield share;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// dist/connect.js
var WriteError = class extends Error {
  code;
  constructor(code, detail, cause) {
    const plain = {
      insufficientBalance: "insufficient balance",
      rejected: "rejected by the chain's rules",
      sponsorUnavailable: "sponsor unavailable",
      refused: "refused by the node",
      notConfirmed: "not confirmed"
    }[code];
    super(detail === void 0 ? plain : `${plain}: ${detail}`, { cause });
    this.name = "WriteError";
    this.code = code;
  }
};
var ATTEMPTS = 5;
var WORK_ROUNDS = 8;
var CREDIT_RETRIES = 3;
var PIN_POLLS = 60;
var POLL_MILLISECONDS = 2e3;
var LONGEST_WAIT = 3e4;
function storedKey(name) {
  try {
    const kept = globalThis.localStorage?.getItem(name);
    if (kept && /^[0-9a-f]{64}$/.test(kept))
      return hexToBytes(kept);
  } catch {
  }
  const key = generatePrivateKey();
  try {
    globalThis.localStorage?.setItem(name, bytesToHex(key));
  } catch {
  }
  return key;
}
function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(signal.reason);
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
    };
    const aborted = () => {
      done();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
function unreachable(error) {
  if (error?.name === "TimeoutError")
    return true;
  return error instanceof TypeError && /fetch|network|load failed/i.test(error.message);
}
function retryDelay(error, attempt) {
  const status = error instanceof SponsorError || error instanceof SubmissionError ? error.status : void 0;
  if (!unreachable(error) && status !== 429 && status !== 503)
    return void 0;
  if (error instanceof SponsorError && error.refusal === "insufficientFloat")
    return void 0;
  if (error instanceof SponsorError && error.retryAfterMilliseconds !== void 0) {
    const wait = error.retryAfterMilliseconds;
    return Number.isFinite(wait) && wait >= 0 && wait <= LONGEST_WAIT ? wait : void 0;
  }
  return Math.min(LONGEST_WAIT, 1e3 * 2 ** attempt);
}
async function patiently(request2, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request2();
    } catch (error) {
      signal?.throwIfAborted();
      const wait = retryDelay(error, attempt);
      if (wait === void 0 || attempt + 1 >= ATTEMPTS)
        throw error;
      await sleep(wait, signal);
    }
  }
}
var refusal2 = (error) => error instanceof SponsorError ? error.refusal : void 0;
var unknownClient = (error) => /unknown client token/.test(refusal2(error) ?? "");
function fileVolumes(type, bytes) {
  const volume = (value) => {
    const block = encodeDagCbor(value);
    const cid = cidV1DagCbor(block);
    return { cid, entries: { [cid]: base64(block) } };
  };
  const chunks = [];
  for (let at = 0; at < bytes.length; at += 1 << 20) {
    chunks.push(volume({ bytes: bytes.subarray(at, at + (1 << 20)) }));
  }
  const root = volume({
    chunks: chunks.map((chunk) => chunk.cid),
    size: BigInt(bytes.length),
    type
  });
  return [root, ...chunks];
}
function base64(bytes) {
  let text = "";
  for (let at = 0; at < bytes.length; at += 32768) {
    text += String.fromCharCode(...bytes.subarray(at, at + 32768));
  }
  return btoa(text);
}
function trieNode(value, cid) {
  const node = value;
  const fail = () => {
    throw new Error(`${cid} is not a general-state trie node`);
  };
  if (node === null || typeof node !== "object" || !Array.isArray(node.children))
    return fail();
  if (node.prefix !== void 0 && typeof node.prefix !== "string")
    return fail();
  if (node.value !== void 0 && typeof node.value !== "string")
    return fail();
  const children = node.children.map((entry) => {
    const child = entry;
    if (typeof child?.key !== "string" || child.key === "" || typeof child.value?.rawCID !== "string") {
      return fail();
    }
    return { key: child.key, rawCID: child.value.rawCID };
  });
  return {
    prefix: node.prefix ?? "",
    ...node.value === void 0 ? {} : { value: node.value },
    children
  };
}
function trie(volumes, rootCID, signal) {
  const load = async (cid, within) => {
    const volume = within?.has(cid) ? within : await volumes.get(cid, signal);
    return { node: trieNode(decodeDagCbor(volume.bytes(cid)), cid), volume };
  };
  const child = (node, rest) => {
    let best;
    for (const entry of node.children) {
      if (rest.startsWith(entry.key) && entry.key.length > (best?.key.length ?? 0))
        best = entry;
    }
    return best?.rawCID;
  };
  async function get(key) {
    let { node, volume } = await load(rootCID);
    let rest = key;
    while (rest.length > 0) {
      const cid = child(node, rest);
      if (cid === void 0)
        return void 0;
      ({ node, volume } = await load(cid, volume));
      if (!rest.startsWith(node.prefix))
        return void 0;
      rest = rest.slice(node.prefix.length);
    }
    return node.value;
  }
  async function list(prefix, limit) {
    let { node, volume } = await load(rootCID);
    let path = "";
    let rest = prefix;
    while (rest.length > 0) {
      const cid = child(node, rest);
      if (cid === void 0)
        return [];
      ({ node, volume } = await load(cid, volume));
      if (rest.startsWith(node.prefix))
        rest = rest.slice(node.prefix.length);
      else if (node.prefix.startsWith(rest))
        rest = "";
      else
        return [];
      path += node.prefix;
    }
    const found = [];
    const walk = async (at, within, key) => {
      if (found.length >= limit)
        return;
      if (at.value !== void 0)
        found.push({ key, value: at.value });
      const sorted = [...at.children].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      for (const entry of sorted) {
        if (found.length >= limit)
          return;
        const next = await load(entry.rawCID, within);
        await walk(next.node, next.volume, key + next.node.prefix);
      }
    };
    await walk(node, volume, path);
    return found;
  }
  return { get, list };
}
async function connect(options) {
  const chainPath = options.chain.split("/");
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const fresh = (input, init) => fetch(input, { ...init, cache: "no-store" });
  const node = new NodeClient(options.node, chainPath, { fetch: fresh });
  const volumes = new VolumeClient(new HTTPVolumeTransport(`${node.baseURL}/volumes`, { fetch }));
  const lattice = new LatticeClient(node, volumes);
  const submitter = new HTTPTransactionSubmitter(`${node.baseURL}/transactions`, { fetch });
  const sponsors = (options.sponsors ?? []).map((url) => new SponsorClient(url, { fetch }));
  const privateKey = options.key === void 0 ? storedKey(options.storageKey ?? `lattice-sdk/key/${options.chain}`) : typeof options.key === "string" ? hexToBytes(options.key) : options.key;
  const account = accountFromPrivateKey(privateKey);
  const progress = options.onProgress ?? (() => {
  });
  const maxFee = options.maxFee ?? 10n;
  const confirmTimeout = options.confirmTimeoutMilliseconds ?? 15 * 6e4;
  const clients = /* @__PURE__ */ new Map();
  let writes = Promise.resolve();
  const oneAtATime = (signal, write) => {
    const turn = () => {
      signal?.throwIfAborted();
      return write();
    };
    const next = writes.then(turn, turn);
    writes = next.catch(() => {
    });
    return next;
  };
  const signalFor = (signal) => {
    const signals = [options.signal, signal].filter((s) => s !== void 0);
    return signals.length < 2 ? signals[0] : AbortSignal.any(signals);
  };
  await node.chainInfo(options.signal);
  async function state(signal) {
    const latest = await lattice.latestBlock(signal);
    const post = await volumes.get(latest.canonical.postStateCID, signal);
    return trie(volumes, decodeCanonicalLatticeState(post.rootBytes()).generalStateCID, signal);
  }
  async function nextNonce(signal) {
    try {
      return await node.account(account.address, signal);
    } catch (error) {
      if (error instanceof NodeError && error.status === 404)
        return { nonce: 0n, balance: 0n };
      throw error;
    }
  }
  async function earn(sponsor, request2, paid, signal) {
    let hashes2 = 0;
    let shares = 0;
    let forgotten = false;
    for (let round = 0; round < WORK_ROUNDS; round++) {
      const client = clients.get(sponsor);
      let work;
      try {
        work = await patiently(() => sponsor.requestWork({ ...request2, ...client === void 0 ? {} : { client } }, signal), signal);
      } catch (error) {
        if (!unknownClient(error) || client === void 0 || forgotten)
          throw error;
        clients.delete(sponsor);
        forgotten = true;
        continue;
      }
      clients.set(sponsor, work.client);
      const report = () => progress({
        stage: "work",
        sponsor: sponsor.endpoint,
        hashes: hashes2,
        shares,
        sharesNeeded: Number(work.sharesForFee)
      });
      report();
      search: for await (const nonce of findShares(work, {
        ...options.workers === void 0 ? {} : { workers: options.workers },
        ...signal === void 0 ? {} : { signal },
        onHashes: (count) => {
          hashes2 += count;
          report();
        }
      })) {
        let credit;
        try {
          ({ credit } = await patiently(() => sponsor.submitShare(work.assignment, nonce, signal), signal));
        } catch (error) {
          if (refusal2(error) === "unknownAssignment" || refusal2(error) === "expired")
            break search;
          if (refusal2(error) === "duplicateShare")
            continue;
          throw error;
        }
        shares += 1;
        report();
        if (await paid(credit, work))
          return work.client;
      }
    }
    throw new WriteError("sponsorUnavailable", `no credit after ${WORK_ROUNDS} rounds of work`);
  }
  async function viaSponsors(attempt) {
    let last;
    for (const sponsor of sponsors) {
      try {
        return await attempt(sponsor);
      } catch (error) {
        const unavailable = error instanceof SponsorError || unreachable(error) || error instanceof WriteError && error.code === "sponsorUnavailable";
        if (!unavailable)
          throw error;
        last = error;
      }
    }
    throw new WriteError("sponsorUnavailable", last instanceof Error ? last.message : "no sponsor given", last);
  }
  async function sponsored(sponsor, draft, signal) {
    const feePaid = (credit, work) => credit >= work.fee;
    let client = await earn(sponsor, { chain: options.chain }, feePaid, signal);
    for (let retry = 0; ; retry++) {
      try {
        return await patiently(() => sponsor.sponsorTransaction(client, draft, 0n, signal), signal);
      } catch (error) {
        const restarted = unknownClient(error);
        if (refusal2(error) !== "insufficientCredit" && !restarted || retry >= CREDIT_RETRIES) {
          throw error;
        }
        if (restarted)
          clients.delete(sponsor);
        client = await earn(sponsor, { chain: options.chain }, feePaid, signal);
      }
    }
  }
  async function submit(payload, byOwnBalance, signal) {
    try {
      return (await patiently(() => submitter.submit(payload, signal), signal)).transactionCID;
    } catch (error) {
      if (!(error instanceof SubmissionError))
        throw error;
      const reason = error.refusal ?? `HTTP ${error.status}`;
      if (error.reason === "invalidState")
        throw new WriteError("rejected", reason, error);
      if (error.reason === "insufficientFunds") {
        throw new WriteError(byOwnBalance ? "insufficientBalance" : "sponsorUnavailable", reason, error);
      }
      if (error.status === 404 && error.reason === void 0) {
        throw new WriteError("refused", "the node takes no transactions (public submit is off)", error);
      }
      throw new WriteError("refused", reason, error);
    }
  }
  async function confirm(transactionCID, payload, byOwnBalance, signal) {
    progress({ stage: "confirm", transactionCID });
    const deadline = Date.now() + confirmTimeout;
    while (Date.now() < deadline) {
      await sleep(Math.min(POLL_MILLISECONDS, Math.max(0, deadline - Date.now())), signal);
      try {
        if ((await node.transaction(transactionCID, signal)).blockHeight !== void 0)
          return;
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof NodeError && error.status === 404))
          continue;
        await submit(payload, byOwnBalance, signal);
      }
    }
    throw new WriteError("notConfirmed", `${transactionCID} was not in a block after ${confirmTimeout} ms`);
  }
  async function set(key, value, signal) {
    const [old, { nonce, balance }] = await Promise.all([
      state(signal).then((reads) => reads.get(key)),
      nextNonce(signal)
    ]);
    const action = {
      key,
      ...old === void 0 ? {} : { oldValue: old },
      newValue: value
    };
    const draft = {
      accountActions: [],
      actions: [action],
      depositActions: [],
      receiptActions: [],
      withdrawalActions: [],
      signers: [account.address],
      nonce,
      chainPath
    };
    const signed = (body, signatures) => {
      const { publicKey, signature } = signTransactionBody(body, privateKey);
      return transactionPayload({ ...signatures, [publicKey]: signature }, body);
    };
    const byOwnBalance = sponsors.length === 0;
    let sent;
    if (byOwnBalance) {
      const fee = (await node.chainInfo(signal)).minRelayFee ?? 1n;
      if (fee > maxFee) {
        throw new WriteError("refused", `the node's fee floor ${fee} is above maxFee ${maxFee}`);
      }
      if (balance < fee) {
        throw new WriteError("insufficientBalance", `${account.address} holds ${balance} and the fee is ${fee}; give sponsors to pay in work`);
      }
      const payload = signed({ ...draft, accountActions: [{ owner: account.address, delta: -fee }] }, {});
      progress({ stage: "submit" });
      sent = { payload, transactionCID: await submit(payload, true, signal) };
    } else {
      sent = await viaSponsors(async (sponsor) => {
        const { body, signatures } = await sponsored(sponsor, draft, signal);
        const payload = signed(body, signatures);
        progress({ stage: "submit" });
        return { payload, transactionCID: await submit(payload, false, signal) };
      });
    }
    await confirm(sent.transactionCID, sent.payload, byOwnBalance, signal);
    return { transactionCID: sent.transactionCID };
  }
  async function put(data, type, signal) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
    const volumes2 = fileVolumes(type ?? ((data instanceof Uint8Array ? "" : data.type) || "application/octet-stream"), bytes);
    const root = volumes2[0].cid;
    return viaSponsors(async (sponsor) => {
      progress({ stage: "store", sponsor: sponsor.endpoint, root });
      const held = await patiently(() => sponsor.store(root, volumes2, signal), signal);
      if (held.stored)
        return root;
      const priced = Object.keys(held.needed);
      const chain = priced.includes(options.chain) ? options.chain : priced[0];
      if (chain === void 0)
        throw new WriteError("sponsorUnavailable", "it sells no storage");
      if (held.credit < held.bytes) {
        await earn(sponsor, { chain, store: root }, async () => (await sponsor.storeStatus(root, signal)).credit >= held.bytes, signal);
      }
      for (let poll = 0; poll < PIN_POLLS; poll++) {
        if ((await patiently(() => sponsor.storeStatus(root, signal), signal)).stored)
          return root;
        await sleep(POLL_MILLISECONDS, signal);
      }
      throw new WriteError("sponsorUnavailable", "paid, but the sponsor did not pin it");
    });
  }
  return {
    chain: options.chain,
    address: account.address,
    async get(key, { signal } = {}) {
      return (await state(signalFor(signal))).get(key);
    },
    async list(prefix = "", { limit = 100, signal } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError("limit must be a positive integer");
      }
      return (await state(signalFor(signal))).list(prefix, limit);
    },
    set(key, value, { signal } = {}) {
      const combined = signalFor(signal);
      return oneAtATime(combined, () => set(key, value, combined));
    },
    put(data, { type, signal } = {}) {
      const combined = signalFor(signal);
      return oneAtATime(combined, () => put(data, type, combined));
    }
  };
}
export {
  BatchingVolumeTransport,
  ChainNodes,
  ChainOfflineError,
  DEFAULT_VOLUME_LIMITS,
  EndpointResolver,
  HTTPTransactionSubmitter,
  HTTPVolumeTransport,
  IndexedDBVolumeCache,
  LatticeClient,
  MANY_VOLUMES_MEDIA_TYPE,
  MAXIMUM_VOLUME_ARCHIVE_BYTES,
  MAXIMUM_VOLUME_ARCHIVE_ENTRIES,
  MAXIMUM_VOLUME_CID_BYTES,
  MemoryVolumeCache,
  MemoryVolumeTransport,
  NodeClient,
  NodeError,
  OPERATOR_DECLARED,
  SIGNATURE_DOMAIN,
  SUBMISSION_REFUSALS,
  SponsorClient,
  SponsorError,
  SubmissionError,
  VOLUME_ARCHIVE_MEDIA_TYPE,
  VerifiedVolume,
  VolumeClient,
  VolumeError,
  VolumeTransportError,
  WriteError,
  accountFromPrivateKey,
  addressFromMultikey,
  addressFromPublicKey,
  assertBlockContinuity,
  assertCID,
  assertDagCborCID,
  base32Decode,
  base32Encode,
  buildTransfer,
  bytesToHex,
  canonicalBlockProofOfWorkHash,
  canonicalBlockProofOfWorkPreimage,
  cidV1,
  cidV1DagCbor,
  concatBytes,
  connect,
  dagCborCIDBytes,
  declaredEndpointURL,
  decodeCanonicalBlock,
  decodeCanonicalLatticeState,
  decodeCanonicalSignedTransaction,
  decodeChildBlockProof,
  decodeDagCbor,
  decodeEd25519Multikey,
  decodeLatticeBlock,
  decodeVolumeArchive,
  decodeVolumeRecords,
  defaultWorkers,
  encodeDagCbor,
  encodeEd25519Multikey,
  encodeSignedTransaction,
  encodeTransactionBody,
  encodeVolumeArchive,
  equalBytes,
  feeToOutbid,
  findShares,
  generatePrivateKey,
  getJSON,
  grind,
  hexToBytes,
  isPublicAddress,
  isStandardCID,
  isValidChildDirectory,
  nodeCookieAuthorization,
  normalizeNodeURL,
  parseAccount,
  parseBlock,
  parseBlockChildren,
  parseBlocksPage,
  parseCID,
  parseChainInfo,
  parseChainSpec,
  parseDeclaredEndpoints,
  parseFeeEstimates,
  parseLatestBlock,
  parseNodeStatus,
  parseTransactionProjection,
  publicKeyFromPrivate,
  retryDelay,
  searchShares,
  shareHash,
  signPreimage,
  signTransactionBody,
  signedTransactionCID,
  signedTransactionSize,
  stateGrowthCeiling,
  toWireTransactionBody,
  transactionPayload,
  transactionSigningPreimage,
  transactionWeight,
  utf8,
  verifyCID,
  verifyChildBlockProof,
  verifyDagCborCID,
  verifyNexusBlockProofOfWork,
  verifyPreimage,
  verifyUint64SparseProof,
  verifyVolume,
  workForTarget
};
/*! Bundled license information:

@noble/ed25519/index.js:
  (*! noble-ed25519 - MIT License (c) 2019 Paul Miller (paulmillr.com) *)
*/
