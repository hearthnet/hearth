// `hearth sell-coin` and the exchange lines of `hearth status`: what a
// seller locks, what it refuses before signing, and what it reports.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as sdk from "../vendor/lattice-sdk.js";
import { cheapest, coinLines, each, exchangeOf, receiptsOf, sellCoin, sellCoinBody } from "../host/coin.mjs";
import { keyFileJSON } from "../client/tx.mjs";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "../bin/hearth.mjs");
const KEY = new Uint8Array(32).fill(1);
const SELLER = sdk.accountFromPrivateKey(KEY).address;
const OTHER = sdk.accountFromPrivateKey(new Uint8Array(32).fill(2)).address;
const MARKET = "Nexus/testnet/lodger-3129cc";
const hearth = (args) => new Promise((ok) => execFile(process.execPath, [BIN, ...args], (error, stdout, stderr) => ok({ code: error?.code ?? 0, out: stdout + stderr })));

test("a buyer pays on the market's parent, naming the market's directory there", () => {
  assert.deepEqual(exchangeOf(MARKET), { parent: "Nexus/testnet", directory: "lodger-3129cc" });
});

test("selling coin locks it as the seller's own deposit, demanding the price in parent coin", () => {
  const body = sellCoinBody({ seller: SELLER, balance: 400_000n, nonce: 7n, market: MARKET, amount: 300_000n, price: 3000n, float: 100n, fee: 1n });
  assert.deepEqual(body.depositActions, [{ nonce: 7n, demander: SELLER, amountDemanded: 3000n, amountDeposited: 300_000n }], "its identity is the key's account nonce, used by no other transaction");
  assert.deepEqual(body.accountActions, [{ owner: SELLER, delta: -300_001n }], "the coin locked and the fee leave the seller's key");
  assert.deepEqual(body.signers, [SELLER]);
  assert.deepEqual(body.chainPath, MARKET.split("/"));
  assert.equal(body.nonce, 7n);
  // Lattice's own checks of the body pass (sizes, ranges): it signs.
  assert.ok(sdk.signTransactionBody(body, KEY).signature);
});

test("selling coin refuses, before signing, to leave the key less than its float for fees", () => {
  const sell = (amount, extra = {}) => sellCoinBody({ seller: SELLER, balance: 1000n, nonce: 0n, market: MARKET, amount, price: 10n, float: 100n, fee: 1n, ...extra });
  assert.ok(sell(899n), "exactly the float left");
  assert.throws(() => sell(900n), /holds 1000 on .*less than the 100 it keeps for fees \(--float\)\. It can sell at most 899 now/);
  assert.throws(() => sell(1n, { balance: 50n }), /It has nothing to sell now/);
  assert.throws(() => sell(0n), /at least 1/);
  assert.throws(() => sell(5n, { price: 0n }), /at least 1/);
});

/** A market where the seller's key holds 10000 at nonce 3; `own` are its open deposits; `sent` what was submitted. */
function fakeMarket(own = []) {
  const sent = [], reads = [];
  const answer = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (input, init = {}) => {
    if (new URL(input).pathname === "/transactions" && init.method === "POST") { sent.push(JSON.parse(init.body)); return answer({}); }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  const r = {
    deposits: async (chain, opts) => { reads.push(opts); return Object.assign([...own], { complete: true }); },
    account: async () => ({ balance: 10000n, nonce: 3n }),
    api: async () => ({ minRelayFee: "2" }),
  };
  return { sent, reads, own, sell: (amount, price, extra = {}) => sellCoin({ sdk, node: "http://127.0.0.1:1", fetchImpl, r, privateKey: KEY, market: MARKET, amount, price, float: 100n, ...extra }) };
}

test("sell-coin sends the deposit from the key's balance and nonce on the market", async () => {
  const m = fakeMarket();
  const done = await m.sell(5000n, 50n);
  assert.deepEqual(done.deposit, { demander: SELLER, amountDemanded: 50n, nonce: 3n, amountDeposited: 5000n });
  assert.equal(done.parent, "Nexus/testnet");
  assert.deepEqual(m.reads, [{ prefix: `${SELLER}/`, limit: 200 }], "only the seller's own deposits, a bounded read");
  const again = await m.sell(5000n, 50n);
  assert.equal(again.tx, done.tx, "until it lands, sending it again is the same transaction, which locks the coin once");
  await assert.rejects(m.sell(9900n, 50n), /at most 9898/, "the node's fee counts against the balance");
  assert.equal(m.sent.length, 2, "nothing sent for the refusal");
});

test("a retry after the deposit landed locks no second one, unless --again", async () => {
  const landed = { demander: SELLER, amountDemanded: 50n, nonce: 3n, amountDeposited: 5000n, key: `${SELLER}/50/3` };
  const m = fakeMarket([landed]);
  const retry = await m.sell(5000n, 50n);
  assert.equal(retry.existing, landed, "the open deposit of the same amount and price");
  assert.equal(m.sent.length, 0, "nothing signed or sent");
  assert.ok((await m.sell(5000n, 60n)).deposit, "another price is another sale");
  assert.ok((await m.sell(4000n, 50n)).deposit, "another amount too");
  const second = await m.sell(5000n, 50n, { again: true });
  assert.equal(second.deposit.amountDeposited, 5000n, "--again locks a second lot");
  assert.equal(m.sent.length, 3);
});

test("sell-coin refuses while the seller runs or a lattice-sponsor answers: they sign with the same keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-coin-"));
  const key = join(dir, "seller.json");
  writeFileSync(key, keyFileJSON(sdk, KEY));
  const server = createServer((req, res) => res.writeHead(req.url === "/terms" ? 200 : 404).end("{}"));
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const args = ["sell-coin", "100", "--price", "5", "--node", "http://127.0.0.1:9", "--token-file", "/dev/null", "--key", key];
    const sponsor = await hearth([...args, "--sponsor-port", String(server.address().port)]);
    assert.equal(sponsor.code, 2);
    assert.match(sponsor.out, /a sponsor answers on port \d+: stop it before selling coin/);
    // A seller beside the key (its pid file names a running sell-hosting.mjs).
    const seller = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", "sell-hosting.mjs"]);
    writeFileSync(join(dir, "seller.pid"), String(seller.pid));
    try {
      const running = await hearth(args);
      assert.equal(running.code, 2);
      assert.match(running.out, new RegExp(`the seller \\(pid ${seller.pid}\\) signs with the seller's key.*run hearth sell-coin`));
    } finally { seller.kill(); }
  } finally { server.close(); }
});

test("a bad amount, price or float is refused before the node is asked anything", async () => {
  for (const [args, why] of [[["sell-coin", "--price", "5"], /hearth sell-coin <coin> --price/], [["sell-coin", "100"], /--price <parent coin>/],
    [["sell-coin", "1.5", "--price", "5"], /the amount is a whole amount/], [["sell-coin", "100", "--price", "0"], /--price is a whole amount/],
    [["sell-coin", "100", "--price", "5", "--float", "x"], /--float is a whole amount/], [["sell-coin", "100", "--price", "5", "--fee", "x"], /--fee is a whole amount/]]) {
    const { code, out } = await hearth([...args, "--node", "http://127.0.0.1:9", "--token-file", "/dev/null"]);
    assert.equal(code, 2, args.join(" "));
    assert.match(out, why, args.join(" "));
  }
  assert.match((await hearth(["sell-coin", "--help"])).out, /^usage: hearth sell-coin <coin> --price <parent coin> \[--float 100\]/);
});

test("status names the cheapest coin on sale and each of the seller's deposits, and who paid for it", () => {
  const d = (demander, amountDeposited, amountDemanded, nonce) => ({ demander, amountDeposited, amountDemanded, nonce, key: `${demander}/${amountDemanded}/${nonce}` });
  const deposits = Object.assign([d(OTHER, 1000n, 30n, 1n), d(SELLER, 300_000n, 3000n, 4n), d(SELLER, 10n, 1n, 9n)], { complete: true });
  assert.equal(cheapest(deposits), deposits[1], "0.01 parent coin each beats 0.03 and 0.1");
  assert.equal(cheapest([]), undefined);
  const mine = Object.assign(deposits.slice(1), { complete: true });
  const lines = coinLines({ market: MARKET, deposits, mine, paidBy: new Map([[deposits[2].key, OTHER]]) });
  assert.equal(lines[0], "exchange: the cheapest market coin on sale is 300000 for 3000 Nexus/testnet coin (0.01 each), of 3 open deposits");
  assert.equal(lines[1], `on sale: 300000 for 3000 Nexus/testnet coin (0.01 each), deposit ${SELLER}/3000/4`);
  assert.match(lines[2], new RegExp(`deposit ${SELLER}/1/9: bought by ${OTHER}, who paid you on Nexus/testnet`));
  assert.equal(lines.length, 3);
  assert.deepEqual(coinLines({ market: MARKET, deposits: Object.assign([], { complete: true }), mine: [] }), ["exchange: no market coin is on sale", "the seller's key has no coin on sale (hearth sell-coin)"]);
  // Bounded reads say when they stopped short.
  const short = coinLines({ market: MARKET, deposits: Object.assign([deposits[0]], { complete: false }), mine: Object.assign([], { complete: false }) });
  assert.match(short[0], /of 1 open deposit in the first part of the market's deposits read$/);
  assert.match(short.at(-1), /more deposits than one read takes/);
});

test("the per-coin price is exact decimal arithmetic, marked ~ only when it does not end, never a misleading 0", () => {
  const p = (amountDemanded, amountDeposited) => each({ amountDemanded, amountDeposited });
  assert.equal(p(3000n, 300_000n), "0.01");
  assert.equal(p(7n, 5000n), "0.0014");
  assert.equal(p(5n, 2n), "2.5");
  assert.equal(p(4n, 2n), "2");
  assert.equal(p(1n, 3n), "~0.33333333");
  // Past Number's 53 bits, still exact.
  assert.equal(p(9007199254740993n, 1n), "9007199254740993");
  assert.equal(p(1n, 9007199254740993n), "<0.00000001", "never a misleading 0");
});

test("status reads at most a capped number of receipts, a few at a time, each with a deadline", async () => {
  const deps = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, demander: SELLER, amountDemanded: 1n, nonce: BigInt(i), amountDeposited: 1n }));
  let live = 0, most = 0, calls = 0;
  const n = { receipt: async (parent, directory, d) => {
    calls++; live++; most = Math.max(most, live);
    try {
      assert.deepEqual([parent, directory], ["Nexus/testnet", "lodger-3129cc"]);
      if (d.key === "k1") return new Promise(() => {});  // never answers
      if (d.key === "k2") throw new Error("unreachable");
      await new Promise((ok) => setTimeout(ok, 5));
      return d.key === "k0" ? OTHER : undefined;
    } finally { live--; }
  } };
  const paidBy = await receiptsOf({ n, ...exchangeOf(MARKET), deposits: deps, cap: 20, concurrency: 4, timeout: 50 });
  assert.equal(calls, 20, "capped");
  assert.ok(most <= 4, `at most 4 at once, saw ${most}`);
  assert.deepEqual([...paidBy], [["k0", OTHER]], "a read that fails or hangs counts as unread");
});
