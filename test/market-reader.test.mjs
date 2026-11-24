// The market reader (client/market.mjs) over a fake node serving a market
// chain block by block: where each order landed.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { reader } from "../client/market.mjs";

const KEY = `order/${"bafyrei" + "a".repeat(52)}/o1/${"bafyrei" + "b".repeat(52)}/0/5/Nexus/x/app`;

/** A market chain of heights 0..tip whose state holds KEY from height `from`: `{ latest, byHeight, content }`. */
function chain(tip, from, content) {
  const put = (node) => { const bytes = sdk.encodeDagCbor(node), cid = sdk.cidV1DagCbor(bytes); content.set(cid, bytes); return cid; };
  const empty = put({ count: 0, children: [] });
  const holding = put({ count: 1, children: [{ key: "o", value: { rawCID: put({ prefix: KEY, value: "renew", children: [] }) } }] });
  const byHeight = [];
  for (let h = 0; h <= tip; h++) {
    const general = h >= from ? holding : empty;
    const state = put({ accountState: { rawCID: empty }, depositState: { rawCID: empty }, generalState: { rawCID: general }, receiptState: { rawCID: empty } });
    const link = { rawCID: empty };
    byHeight.push(put({ version: 1, transactions: link, target: "0x1", nextTarget: "0x1", spec: link, parentState: link, prevState: link, postState: { rawCID: state }, children: link, height: h, timestamp: from * 1000 + h, nonce: 0 }));
  }
  return { latest: byHeight[tip], byHeight };
}

test("a landing in the last 100 blocks is read again each time (a reorganization may move it); an older one is kept", async () => {
  const content = new Map();
  let served = chain(10, 5, content);
  let tipReads = 0;
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname.startsWith("/volumes/")) {
      const cid = url.pathname.slice(9);
      return new Response(sdk.encodeVolumeArchive({ rootCID: cid, entries: [{ cid, bytes: content.get(cid) }] }), { headers: { "content-type": sdk.VOLUME_ARCHIVE_MEDIA_TYPE } });
    }
    if (url.pathname === "/api/block/latest") { tipReads++; return Response.json({ hash: served.latest }); }
    const h = /^\/api\/block\/(\d+)$/.exec(url.pathname)?.[1];
    return Response.json({ hash: served.byHeight[Number(h)] });
  };
  const r = reader(sdk, "http://127.0.0.1:1", { fetchImpl });
  assert.equal((await r.market("Nexus/x")).orders[0].landed, 5n);
  served = chain(10, 8, content);  // the chain reorganized: the order landed at 8
  assert.equal((await r.market("Nexus/x")).orders[0].landed, 8n);
  served = chain(150, 8, content);
  assert.equal((await r.market("Nexus/x")).orders[0].landed, 8n);
  served = chain(150, 3, content);  // 142 blocks deep: kept
  assert.equal((await r.market("Nexus/x")).orders[0].landed, 8n);
  assert.equal(tipReads, 4);
});
