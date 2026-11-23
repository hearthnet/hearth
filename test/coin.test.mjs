// `hearth sell-coin` and the exchange lines of `hearth status`: what a
// seller locks, what it refuses before signing, and what it reports.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as sdk from "../vendor/lattice-sdk.js";
import { cheapest, coinLines, exchangeOf, sellCoin, sellCoinBody } from "../host/coin.mjs";

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

test("sell-coin sends the deposit from the key's balance and nonce on the market", async () => {
  const sent = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const answer = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.pathname === "/api/chain/info") return answer({ minRelayFee: "2" });
    if (url.pathname === `/api/state/account/${SELLER}`) return answer({ balance: "10000", nonce: "3" });
    if (url.pathname === "/transactions" && init.method === "POST") { sent.push(JSON.parse(init.body)); return answer({}); }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  const done = await sellCoin({ sdk, node: "http://127.0.0.1:1", fetchImpl, privateKey: KEY, market: MARKET, amount: 5000n, price: 50n, float: 100n });
  assert.deepEqual(done.deposit, { demander: SELLER, amountDemanded: 50n, nonce: 3n, amountDeposited: 5000n });
  assert.equal(done.parent, "Nexus/testnet");
  assert.equal(sent.length, 1);
  const again = await sellCoin({ sdk, node: "http://127.0.0.1:1", fetchImpl, privateKey: KEY, market: MARKET, amount: 5000n, price: 50n, float: 100n });
  assert.equal(again.tx, done.tx, "until it lands, sending it again is the same transaction, which locks the coin once");
  await assert.rejects(sellCoin({ sdk, node: "http://127.0.0.1:1", fetchImpl, privateKey: KEY, market: MARKET, amount: 9900n, price: 50n, float: 100n }), /at most 9898/,
    "the node's fee counts against the balance");
  assert.equal(sent.length, 2, "nothing sent for the refusal");
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
  const deposits = [d(OTHER, 1000n, 30n, 1n), d(SELLER, 300_000n, 3000n, 4n), d(SELLER, 10n, 1n, 9n)];
  assert.equal(cheapest(deposits), deposits[1], "0.01 parent coin each beats 0.03 and 0.1");
  assert.equal(cheapest([]), undefined);
  const lines = coinLines({ market: MARKET, self: SELLER, deposits, paidBy: new Map([[deposits[2].key, OTHER]]) });
  assert.equal(lines[0], "exchange: the cheapest market coin on sale is 300000 for 3000 Nexus/testnet coin (0.0100 each), of 3 open deposits");
  assert.equal(lines[1], `on sale: 300000 for 3000 Nexus/testnet coin (0.0100 each), deposit ${SELLER}/3000/4`);
  assert.match(lines[2], new RegExp(`deposit ${SELLER}/1/9: bought by ${OTHER}, who paid you on Nexus/testnet`));
  assert.equal(lines.length, 3, "another seller's deposit is only in the cheapest line");
  assert.deepEqual(coinLines({ market: MARKET, self: SELLER, deposits: [] }), ["exchange: no market coin is on sale", "the seller's key has no coin on sale (hearth sell-coin)"]);
});
