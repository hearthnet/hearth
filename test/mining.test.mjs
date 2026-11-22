// Old mining claims and burns: an offer's old `mines` line, the hashrate
// a chain's own blocks credit, burn addresses, and `--burn`'s once-only rule.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as sdk from "../vendor/lattice-sdk.js";
import { burnAddress, formatOffer, offerText, parseOffer, pathFromNexus } from "../client/records.mjs";
import { creditedHashrate, formatRate, workOf } from "../client/mining.mjs";
import { burn, burnChain, burnShortfall, offerFromFlags } from "../host/hearth.mjs";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "../bin/hearth.mjs");
const KEY = new Uint8Array(32).fill(1);
const HOST = sdk.accountFromPrivateKey(KEY).address;
const MARKET = "Nexus/testnet/lodger-3129cc";
const TERMS = { parent: "Nexus/testnet", price: 100n, period: 1440n, until: 900n, capacity: 50n, maxBlockSize: 1000000n, maxStateGrowth: 1000000n,
  minTargetBlockTime: 5000n, maxNumberOfTransactionsPerBlock: 1000n, modules: "any" };

test("old offers with a `mines` claim or a `blocks mine` line still parse; nothing writes `mines`", () => {
  const plain = formatOffer(TERMS);
  assert.equal(parseOffer(offerText(7n, plain)).mines, undefined);
  assert.equal(formatOffer(parseOffer(offerText(7n, plain))), plain, "an offer without a claim writes the same bytes");
  const claimed = `${plain}\nmines 1000000000000`;
  assert.equal(parseOffer(offerText(7n, claimed)).mines, 1000000000000n, "an old claim is read");
  assert.equal(formatOffer(parseOffer(offerText(7n, claimed))), plain, "and not written again");
  assert.deepEqual(parseOffer(offerText(7n, `${plain}\nblocks mine`)), parseOffer(offerText(7n, plain)), "the old `blocks` form");
  assert.equal(parseOffer(offerText(7n, `${plain}\nblocks commit\nmines 5`)).mines, 5n);
  for (const bad of ["mines 0", "mines 01", "mines -1", "mines 1.5", "mines ", "mines x"]) assert.equal(parseOffer(offerText(7n, `${plain}\n${bad}`)), undefined, bad);
  assert.equal(parseOffer(offerText(7n, `${plain}\nmines 1\nmines 2`)), undefined, "one claim at most");
});

test("offer flags make no mining claim", () => {
  assert.equal(offerFromFlags({ price: "100/day" }).mines, undefined);
  assert.equal(formatRate(1250000000000n), "1.25 TH/s");
  assert.equal(formatRate(999n), "999 H/s");
  assert.equal(formatRate(1500n), "1.5 kH/s");
});

test("credited hashrate: each block's work, 2^256 / (target + 1), to its recipient, over the window", () => {
  const A = "bafyreiaaaa", B = "bafyreibbbb";
  const t = (n) => 1_000_000 + n * 1000;
  const blocks = [
    { target: "0x" + ((1n << 256n) / 1000n - 1n).toString(16), rewardRecipient: A, timestamp: t(0) },  // before the window
    { target: (1n << 256n) / 1000n - 1n, rewardRecipient: A, timestamp: t(1) },
    { target: (1n << 256n) / 3000n - 1n, rewardRecipient: B, timestamp: t(2) },
    { target: (1n << 256n) / 1000n - 1n, rewardRecipient: undefined, timestamp: t(3) },  // burned: in the total only
    { target: (1n << 256n) / 6000n - 1n, rewardRecipient: A, timestamp: t(4) },
  ];
  assert.equal(workOf((1n << 256n) / 1000n - 1n), 1000n);
  const c = creditedHashrate(blocks);
  assert.equal(c.seconds, 4);
  assert.equal(c.work.get(A), 7000n, "the block at the window's start is not counted");
  assert.equal(c.work.get(B), 3000n);
  assert.equal(c.total, 11000n);
  assert.equal(c.rate.get(A), 1750n);
  assert.equal(c.totalRate, 2750n);
  const day = creditedHashrate(blocks, { from: t(-1), to: t(9) });
  assert.equal(day.work.get(A), 8000n);
  assert.equal(day.rate.get(A), 800n, "over a fixed window");
  assert.equal(creditedHashrate([], { from: 0, to: 0 }).totalRate, 0n);
});

test("burn addresses: the SDK's DAG-CBOR CID of {domain, host}, as Lattice's Swift computes it", () => {
  // Computed independently in Swift: HeaderImpl<BurnPreimage>(node: .init(domain:host:)).rawCID,
  // with the cashew lattice-node pins (5.0.6).
  assert.equal(HOST, "bafyreig4rfs3ywfwh3nnvysrpfhovdbodgdypmxgptlmnhduedv2iyqp34");
  assert.equal(burnAddress(sdk, HOST), "bafyreiflegmabo25dcjlk4aoa2uodgcdyzzf4dx7fpaedxe7np5z75pdsu");
  assert.notEqual(burnAddress(sdk, sdk.accountFromPrivateKey(new Uint8Array(32).fill(2)).address), burnAddress(sdk, HOST));
});

test("a burn on a chain off the path from Nexus to the market is refused", async () => {
  assert.deepEqual(pathFromNexus(MARKET), ["Nexus", "Nexus/testnet", MARKET]);
  for (const ok of pathFromNexus(MARKET)) assert.equal(burnChain(ok, MARKET), ok);
  for (const bad of ["Nexus/other", "Nexus/testnet/lodger-3129cc/app", "Nexus/test", "testnet", ""]) assert.throws(() => burnChain(bad, MARKET), /not on the path/, bad);
  const { code, out } = await new Promise((ok) => execFile(process.execPath, [BIN, "burn", "5", "--chain", "Nexus/other", "--node", "http://127.0.0.1:9", "--token-file", "/dev/null"],
    (error, stdout, stderr) => ok({ code: error?.code ?? 0, out: stdout + stderr })));
  assert.equal(code, 2);
  assert.match(out, /Nexus\/other is not on the path from Nexus to the market/);
});

/**
 * A node on one chain: each block a state of accounts; `land(updates)` makes
 * a new tip. `afterRead(owner)` runs right after an account is read, and
 * `slow` owners answer a moment later: together they land a block between
 * two reads.
 */
function fakeNode() {
  const states = new Map([["b0", new Map()]]), sent = [];
  let tip = "b0";
  const n = { sent, slow: new Set(), afterRead: undefined };
  n.land = (updates) => {
    const next = `b${states.size}`;
    states.set(next, new Map([...states.get(tip), ...Object.entries(updates)]));
    tip = next;
  };
  n.fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const answer = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    const account = async (block, owner) => {
      const pinned = block !== undefined;
      if (n.slow.has(owner)) await new Promise((ok) => setTimeout(ok, 5));
      const a = states.get(pinned ? block : tip).get(owner) ?? { balance: 0n, nonce: 0n };
      n.afterRead?.(owner);
      return answer({ balance: String(a.balance), nonce: String(a.nonce) });
    };
    if (url.pathname === "/api/chain/info") return answer({ minRelayFee: "1" });
    if (url.pathname === "/api/block/latest") return answer({ hash: tip });
    if (url.pathname.startsWith("/accounts/")) return account(url.searchParams.get("block"), url.pathname.split("/").at(-1));
    if (url.pathname.startsWith("/api/state/account/")) return account(undefined, url.pathname.split("/").at(-1));
    if (url.pathname === "/transactions" && init.method === "POST") {
      if (n.refuse) return { ok: false, status: 400, json: async () => ({}), text: async () => JSON.stringify({ error: n.refuse }) };
      sent.push(init.body); return answer({});
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  return n;
}

test("--burn burns what the burned total lacks, once; again it sends nothing new", async () => {
  assert.equal(burnShortfall({ burned: 0n, amount: 100n }), 100n);
  assert.equal(burnShortfall({ burned: 40n, amount: 100n }), 60n, "someone else burned 40 for the host");
  assert.equal(burnShortfall({ burned: 100n, amount: 100n }), 0n);
  assert.equal(burnShortfall({ burned: 500n, amount: 100n }), 0n);

  const n = fakeNode(), to = burnAddress(sdk, HOST);
  n.land({ [HOST]: { balance: 1000n, nonce: 4n } });
  const pass = () => burn({ sdk, node: "http://127.0.0.1:1", fetchImpl: n.fetchImpl, privateKey: KEY, chain: MARKET, amount: 100n, atLeast: true });
  const first = await pass();
  assert.equal(first.amount, 100n);
  assert.equal(first.to, to);
  const again = await pass();
  assert.equal(again.tx, first.tx, "not yet in a block: the same transaction, which lands once");
  assert.equal(n.sent[1], n.sent[0]);
  assert.ok(n.sent[0].includes(to), "a transfer to the burn address");
  // It lands: the burn address holds 100, the key's nonce moves on.
  n.land({ [to]: { balance: 100n, nonce: 0n }, [HOST]: { balance: 899n, nonce: 5n } });
  assert.equal(await pass(), undefined, "burned: nothing more");
  assert.equal(n.sent.length, 2);

  // `hearth burn` burns the amount it is given, every time.
  const plain = await burn({ sdk, node: "http://127.0.0.1:1", fetchImpl: n.fetchImpl, privateKey: KEY, chain: MARKET, amount: 7n });
  assert.deepEqual([plain.amount, plain.burned], [7n, 100n]);
});

test("a burn landing between the seller's reads is not burned again", async () => {
  const n = fakeNode(), to = burnAddress(sdk, HOST);
  n.land({ [HOST]: { balance: 1000n, nonce: 4n } });
  const pass = () => burn({ sdk, node: "http://127.0.0.1:1", fetchImpl: n.fetchImpl, privateKey: KEY, chain: MARKET, amount: 100n, atLeast: true });
  await pass();
  // The pending burn lands after the next pass reads the burned total (0)
  // and before it reads the key's nonce.
  n.slow.add(HOST);
  n.afterRead = (owner) => { if (owner === to) { n.afterRead = undefined; n.land({ [to]: { balance: 100n, nonce: 0n }, [HOST]: { balance: 899n, nonce: 5n } }); } };
  await pass();
  await pass();
  assert.equal(new Set(n.sent).size, 1, "every burn sent is the one transaction, at nonce 4");
});

test("a burn the node refuses as invalidState says the chain isn't synced or the key holds no coin there", async () => {
  const n = fakeNode();
  n.refuse = "invalidState";
  await assert.rejects(burn({ sdk, node: "http://127.0.0.1:1", fetchImpl: n.fetchImpl, privateKey: KEY, chain: MARKET, amount: 7n }),
    new RegExp(`${MARKET} isn't synced yet on this node, or the key has no coin there`));
});
