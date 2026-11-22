#!/usr/bin/env node
// Keeps coin for sale on the market chain: locks lots of market coin, each
// for a price in the parent chain's coin (Lattice's deposit), so buyers can
// take them with a receipt and a withdrawal. Lots already open are kept.
//
//   node tools/sell.mjs --node <url> --market <path> --key seller.json --lots 500:250,2000:1000 [--copies 3] [--cookie <file>]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import * as sdk from "../vendor/lattice-sdk.js";
import { reader } from "../client/market.mjs";
import { depositBody, submit } from "../client/tx.mjs";

const { values: a } = parseArgs({ options: { node: { type: "string" }, market: { type: "string" }, key: { type: "string" }, lots: { type: "string" }, copies: { type: "string", default: "1" }, cookie: { type: "string" } } });
// --cookie <node root>/chains/Nexus/.cookie: submit through an operator RPC (loopback) instead of a public port.
const fetchImpl = a.cookie ? (u, init = {}) => fetch(u, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${readFileSync(a.cookie, "utf8").trim().replace(/^[^:]*:/, "")}` } }) : (...x) => fetch(...x);
const privateKey = sdk.hexToBytes(JSON.parse(readFileSync(a.key, "utf8")).privateKey);
const me = sdk.accountFromPrivateKey(privateKey).address;
const r = reader(sdk, a.node, { fetchImpl });
const want = a.lots.split(",").map((l) => l.split(":").map(BigInt));
const open = (await r.deposits(a.market)).filter((d) => d.demander === me);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
let sent = 0;
for (const [deposited, demanded] of want) {
  const have = open.filter((d) => d.amountDeposited === deposited && d.amountDemanded === demanded).length;
  for (let i = have; i < Number(a.copies); i++) {
    for (let t = 0; ; t++) {
      try {
        const { nonce } = await r.account(a.market, me);
        const cid = await submit(sdk, a.node, depositBody({ seller: me, nonce, chainPath: a.market.split("/"), depositNonce: BigInt(Date.now()) * 1000n + BigInt(sent), amountDemanded: demanded, amountDeposited: deposited, fee: 1n }), privateKey, fetchImpl);
        console.log(`lot ${deposited} for ${demanded}: ${cid}`);
        sent++;
        // One pending transaction per signer: wait for it to land.
        for (;;) { await sleep(5000); if ((await r.account(a.market, me)).nonce > nonce) break; }
        break;
      } catch (e) { if (t > 30) throw e; console.log("retry:", e.message.slice(0, 120)); await sleep(5000); }
    }
  }
}
console.log(`${sent} new lots; ${open.length} were open`);
