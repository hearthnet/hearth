#!/usr/bin/env node
// Store a file (up to 1 MiB) at every verified storage offer on the market, or
// the ones named: upload it to each host's sponsor, pay every host in one
// transaction (one order each), claim the payment at each sponsor, and wait
// until each host's node holds it. Live test of storage on Hearth.
//
//   node tools/store.mjs --key buyer.json --file photo.png \
//     [--node https://lattice-testnet-apps-iad.fly.dev] [--market Nexus/testnet/lodger-3129cc] \
//     [--offer <host>/<id> ...] [--min 1]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import * as sdk from "../vendor/lattice-sdk.js";
import { reader, holdsVolume } from "../client/market.mjs";
import { parseStorageOffer } from "../client/records.mjs";
import { recordsBody, storageClaim, storageOrderWrite, submit } from "../client/tx.mjs";
import { judgeStorage } from "../client/verdict.mjs";
import { storageVouches } from "../client/vouch.mjs";

const { values: a } = parseArgs({ options: {
  node: { type: "string", default: "https://lattice-testnet-apps-iad.fly.dev" },
  market: { type: "string", default: "Nexus/testnet/lodger-3129cc" },
  key: { type: "string" }, file: { type: "string" }, offer: { type: "string", multiple: true }, min: { type: "string", default: "1" },
} });
if (!a.key || !a.file) throw new Error("--key and --file are required");
const k = JSON.parse(readFileSync(a.key, "utf8"));
const me = { address: k.address, key: sdk.hexToBytes(k.privateKey) };
const r = reader(sdk, a.node), t0 = Date.now(), say = (...x) => console.log(`[${((Date.now() - t0) / 1000) | 0}s]`, ...x);
const wait = (ms) => new Promise((x) => setTimeout(x, ms));
const until = async (label, f, s = 3600) => { for (const end = Date.now() + s * 1000; ;) { const v = await f().catch((e) => (say(label, "…", e.message.slice(0, 100)), undefined)); if (v) return v; if (Date.now() > end) throw new Error("timeout: " + label); await wait(15000); } };
const ask = async (url, body) => {
  const response = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`${url}: ${response.status} ${text}`), { status: response.status });
  return JSON.parse(text);
};

// The file as one Volume, as lattice-storage's fileVolumes makes it.
const bytes = new Uint8Array(readFileSync(a.file));
if (bytes.length > 1 << 20) throw new Error("this tool stores files up to 1 MiB (one Volume)");
const block = sdk.encodeDagCbor({ bytes, size: BigInt(bytes.length), type: "application/octet-stream" });
const root = sdk.cidV1DagCbor(block);
const volumes = [{ cid: root, entries: { [root]: Buffer.from(block).toString("base64") } }];
say("file", a.file, bytes.length, "bytes, root", root);

// The offers: verified ones only.
const m = await r.market(a.market);
const chosen = [];
for (const [ref, text] of m.offers) {
  const offer = parseStorageOffer(text);
  if (!offer || (a.offer && !a.offer.includes(ref)) || offer.until <= m.height) continue;
  const host = ref.split("/")[0];
  const v = await storageVouches({ host, urlValue: m.urlValues.get(host), offer, market: a.market });
  say(ref.slice(-20), v.ok ? "verified" : `NOT verified: ${v.reason}`);
  if (v.ok && chosen.some((c) => c.host === host)) say(ref.slice(-20), "skipped: one offer per host (one claim per sponsor)");
  else if (v.ok) chosen.push({ ref, host, id: ref.split("/").slice(1).join("/"), offer, sponsor: offer.sponsor.replace(/\/$/, ""), read: m.urls.get(host) });
}
if (chosen.length < Number(a.min)) throw new Error(`${chosen.length} verified storage offers; --min ${a.min}`);

// 1. Upload to each sponsor; it counts the bytes it will keep.
for (const c of chosen) {
  c.counted = BigInt((await ask(`${c.sponsor}/store`, { root, volumes })).bytes);
  say("uploaded to", c.sponsor, "—", c.counted, "bytes");
}

// 2. One transaction: an order at each host, each paying it.
const { height } = await r.tip(a.market);
const writes = chosen.map((c) => storageOrderWrite({ host: c.host, id: c.id, offer: c.offer, payer: me.address, root, bytes: c.counted, height }));
const { nonce } = await r.account(a.market, me.address);
const info = await r.api("/api/chain/info", a.market);
const txCID = await submit(sdk, a.node, recordsBody({ signer: me.address, nonce, chainPath: a.market.split("/"),
  actions: writes.flatMap((w) => w.actions), payments: writes.flatMap((w) => w.payments), fee: BigInt(info.minRelayFee ?? 1) }), me.key);
say("ordered at", chosen.length, "hosts, paying", writes.map((w) => w.order.paid).join(" + "), "coin:", txCID);

// 3. Claim the payment at each sponsor once it is deep enough.
const signature = sdk.signPreimage(storageClaim(a.market, txCID, root), me.key);
for (const c of chosen) {
  const paid = await until(`claim at ${c.sponsor}`, async () => {
    try { return await ask(`${c.sponsor}/pay`, { chain: a.market, txCID, signer: me.address, signature, store: root }); }
    catch (e) { if (/notIncluded|notDeepEnough/.test(e.message)) return undefined; throw e; }
  });
  say("claimed at", c.sponsor, JSON.stringify(paid));
}

// 4. Each host's node holds it.
for (const c of chosen) {
  await until(`${c.sponsor} pins it`, async () => (await ask(`${c.sponsor}/store/${root}`)).stored);
  await until(`${c.read} holds it`, () => holdsVolume(sdk, c.read, root));
  say("held by", c.read);
}

// 5. Every reader judges the orders owed.
const verdicts = await until("the orders settle", async () => {
  const now = await r.market(a.market);
  const v = judgeStorage({ height: now.height, offers: now.offers, orders: now.orders.filter((o) => o.path === root && o.payer === me.address && o.created === height) });
  const kinds = [...v.values()].map((x) => x.kind);
  return kinds.length === chosen.length && kinds.every((x) => x !== "pending") && kinds;
});
say(verdicts.every((x) => x === "owed") ? "PASS" : "FAIL", root, verdicts.join(" "));
