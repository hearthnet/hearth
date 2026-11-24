// The verdict corpus: orders with the verdicts every reader must reach.
// The host (host/sell-hosting.mjs) and the web app import the same module.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { CREATED_WINDOW, formatOffer, formatPayload, inForce, isClosed, moduleCID, newestOffers, offerAt, offerText, orderKey, parseOffer, parsePayload, sponsorAt, strictJSON, SETTLE } from "../client/records.mjs";
import { judge, sameGenesis } from "../client/verdict.mjs";

const key = (n) => sdk.accountFromPrivateKey(new Uint8Array(32).fill(n)).address;
const HOST = key(1), A = key(2), B = key(3), C = key(4);
const OFFER = { created: 100n, parent: "Nexus/testnet", price: 50n, period: 1440n, until: 100000n, capacity: 2n,
  maxBlockSize: 100000n, maxStateGrowth: 100000n, minTargetBlockTime: 1000n, maxNumberOfTransactionsPerBlock: 100n, modules: "any" };
const SPEC = { maxNumberOfTransactionsPerBlock: 10n, maxStateGrowth: 1000n, maxBlockSize: 1000n, premine: 0n, targetBlockTime: 5000n, initialReward: 10n, halvingInterval: 1000n, halfLife: 100n, wasmPolicies: [] };
const payload = (spec = SPEC, extra = {}) => formatPayload({ spec, premineTo: null, modules: {}, genesisTransactions: [], ...extra });

let n = 0;
const order = ({ buyer = A, path = "Nexus/testnet/x", created = 200n, paid = 50n, id = "o", payloadText = payload() } = {}) => {
  const key = orderKey({ host: HOST, id, payer: buyer, height: created, paid, path });
  return { key, host: HOST, id, buyer, payer: buyer, created, paid, path, payloadText, n: n++ };
};
const renewal = ({ payer = B, path = "Nexus/testnet/x", created, paid = 50n, id = "o" }) =>
  ({ key: orderKey({ host: HOST, id, payer, height: created, paid, path }), host: HOST, id, payer, created, paid, path });
// One offer, written once.
const offers = (offer = OFFER) => new Map([[`${HOST}/o`, [offerText(offer.created, formatOffer(offer))]]]);
const verdicts = (orders, { height = 1000n, versions = offers(), genesis, renewals } = {}) => {
  const v = judge({ sdk, height, versions, orders, renewals, genesis });
  return orders.map((o) => v.get(o.key).kind);
};

test("records round-trip and parse strictly", () => {
  const text = (o) => offerText(o.created, formatOffer(o));
  assert.deepEqual(parseOffer(text(OFFER)), OFFER);
  assert.equal(parseOffer(text(OFFER) + "\n"), undefined);
  assert.equal(parseOffer(`${text(OFFER)}\nblocks both`), undefined);
  assert.equal(parseOffer(text(OFFER).replace("price 50", "price 050")), undefined);
  assert.deepEqual(parseOffer(text({ ...OFFER, modules: [] })).modules, []);
  assert.throws(() => strictJSON('{"a":1,"a":2}'), /duplicate/);
  assert.throws(() => strictJSON('{"a":1.5}'), /integers/);
  assert.throws(() => strictJSON('{"a":1e3}'), /integers/);
  assert.throws(() => strictJSON('{"a":-0}'), /minus zero/);
  assert.equal(strictJSON('{"a":18446744073709551616}').a, 18446744073709551616n);
  assert.ok(!parsePayload(payload()).error);
});

test("an offer without `blocks` and one written before it was dropped both parse and sell", () => {
  const value = formatOffer(OFFER);
  assert.doesNotMatch(value, /blocks/, "new offers omit it");
  for (const old of ["", "\nblocks mine", "\nblocks commit"]) {
    const text = offerText(OFFER.created, value + old);
    assert.deepEqual(parseOffer(text), OFFER, `parses: ${JSON.stringify(old)}`);
    const o = order();
    assert.equal(judge({ sdk, height: 1000n, versions: new Map([[`${HOST}/o`, [text]]]), orders: [o] }).get(o.key).kind, "owed", `sells: ${JSON.stringify(old)}`);
  }
});

test("an order is judged only once settled", () => {
  assert.deepEqual(verdicts([order({ created: 200n })], { height: 200n + SETTLE - 1n }), ["pending"]);
  assert.deepEqual(verdicts([order({ created: 200n })], { height: 200n + SETTLE }), ["owed"]);
});

test("void: the buyer's fault, from bytes alone", () => {
  const cases = {
    "no such offer": order({ id: "missing" }),
    "created before the offer": order({ created: 99n }),
    "created before the offer took effect": order({ created: 109n }),
    "created after the offer ends": order({ created: 100001n }),
    "paid less than one period": order({ paid: 49n }),
    "not under the offer's parent": order({ path: "Nexus/other/x" }),
    "nested too deep": order({ path: "Nexus/testnet/x/y" }),
    "over maxBlockSize": order({ payloadText: payload({ ...SPEC, maxBlockSize: 100001n }) }),
    "faster than minTargetBlockTime": order({ payloadText: payload({ ...SPEC, targetBlockTime: 999n }) }),
    "a legacy spec key": order({ payloadText: payload({ ...SPEC, transactionFilters: [] }) }),
    "a duplicate key": order({ payloadText: payload().replace('{"spec":', '{"premineTo":null,"spec":') }),
    "a module the spec does not name": order({ payloadText: payload(SPEC, { modules: { bafyreigbhstawgutxnn4hlqqjgfmnarkc3qffq6rbwsumabvvfobthkyaq: "AAAA" } }) }),
    "a premine with no account": order({ payloadText: payload({ ...SPEC, premine: 5n }) }),
    "not JSON": order({ payloadText: "{" }),
  };
  for (const [why, o] of Object.entries(cases)) assert.deepEqual(verdicts([o], { height: 200000n }), ["void"], why);
});

test("modules: the offer's list, and bytes matching their CIDs", () => {
  const bytes = Buffer.from("not really wasm").toString("base64");
  const cid = moduleCID(sdk, bytes);
  const spec = { ...SPEC, wasmPolicies: [{ moduleCID: cid, abiVersion: 1n, scope: "transaction", entrypoint: "lattice_validate_transaction" }] };
  const withModule = payload(spec, { modules: { [cid]: bytes } });
  assert.deepEqual(verdicts([order({ payloadText: withModule })]), ["owed"], "any module");
  const listed = offers({ ...OFFER, modules: [cid] });
  assert.deepEqual(verdicts([order({ payloadText: withModule })], { versions: listed }), ["owed"], "a listed module");
  const unlisted = offers({ ...OFFER, modules: [] });
  assert.deepEqual(verdicts([order({ payloadText: withModule })], { versions: unlisted }), ["void"], "a module outside the list");
  const wrong = payload(spec, { modules: { [cid]: Buffer.from("other bytes!").toString("base64") } });
  assert.deepEqual(verdicts([order({ payloadText: wrong })]), ["void"], "bytes that do not match");
  assert.deepEqual(verdicts([order({ payloadText: payload(spec) })]), ["void"], "a named module missing");
});

test("full: capacity counts chains, in created order", () => {
  // capacity 2: X, Y counted; Z full; a second order for X shares X.
  const x = order({ path: "Nexus/testnet/x", created: 200n });
  const y = order({ path: "Nexus/testnet/y", created: 201n });
  const z = order({ path: "Nexus/testnet/z", created: 202n });
  const x2 = order({ path: "Nexus/testnet/x", buyer: B, created: 203n });
  assert.deepEqual(verdicts([z, x2, y, x]), ["full", "owed", "owed", "owed"]);
});

test("full: a late order with an earlier created is judged in created order", () => {
  const y = order({ path: "Nexus/testnet/y", created: 205n });
  const z = order({ path: "Nexus/testnet/z", created: 206n });
  const late = order({ path: "Nexus/testnet/w", created: 204n });  // landed last, created first
  assert.deepEqual(verdicts([y, z, late]), ["owed", "full", "owed"]);
});

test("full: the sybil-filled offer stays full when its orders are renewed", () => {
  const sybils = [order({ buyer: B, path: "Nexus/testnet/s1", created: 200n }), order({ buyer: B, path: "Nexus/testnet/s2", created: 200n })];
  const real = order({ buyer: A, path: "Nexus/testnet/real", created: 210n });
  assert.deepEqual(verdicts([...sybils, real]), ["owed", "owed", "full"]);
  const renewals = sybils.map((s) => renewal({ path: s.path, created: 300n }));
  assert.deepEqual(verdicts([...sybils, real], { renewals }), ["owed", "owed", "full"]);
});

test("taken: one path, two payloads at one host", () => {
  const first = order({ path: "Nexus/testnet/x", created: 200n });
  const other = order({ path: "Nexus/testnet/x", buyer: B, created: 201n, payloadText: payload({ ...SPEC, initialReward: 11n }) });
  const same = order({ path: "Nexus/testnet/x", buyer: C, created: 202n });
  assert.deepEqual(verdicts([other, first, same]), ["taken", "owed", "owed"]);
});

test("taken: the path holds a genesis built from another payload", () => {
  const o = order();
  const facts = (spec, premineTo = null) => ({ specCID: sdk.cidV1DagCbor(sdk.encodeDagCbor(spec)), premineTo, transactions: [] });
  assert.deepEqual(verdicts([o], { genesis: new Map([["Nexus/testnet/x", facts(SPEC)]]) }), ["owed"]);
  assert.deepEqual(verdicts([o], { genesis: new Map([["Nexus/testnet/x", facts({ ...SPEC, initialReward: 99n })]]) }), ["taken"]);
  assert.deepEqual(verdicts([o], { genesis: new Map([["Nexus/testnet/x", facts(SPEC, A)]]) }), ["taken"], "another premine");
  assert.ok(sameGenesis(sdk, facts(SPEC), parsePayload(payload())));
});

test("one payload ordered at two paths is two chains", () => {
  const one = offers({ ...OFFER, capacity: 1n });
  assert.deepEqual(verdicts([order({ path: "Nexus/testnet/a" }), order({ path: "Nexus/testnet/b", created: 201n })], { versions: one }), ["owed", "full"]);
});

test("paid time: orders and renewals add whole periods, oldest first", () => {
  const o = order({ created: 200n });  // one period: 200 + 1440
  const until = (renewals, offer = OFFER) => judge({ sdk, height: 250n, versions: offers(offer), orders: [o], renewals }).get(o.key);
  assert.equal(until([]).until, 1640n);
  assert.equal(until([]).from, 200n + SETTLE);
  assert.equal(until([]).active, true);
  assert.equal(until([renewal({ created: 300n, paid: 100n })]).until, 1640n + 2880n, "two more periods from where paid time ends");
  const late = [renewal({ created: 5000n })];
  assert.equal(judge({ sdk, height: 5000n + SETTLE, versions: offers(), orders: [o], renewals: late }).get(o.key).until, 6440n, "lapsed: from the renewal's own height, once settled");
  assert.equal(judge({ sdk, height: 5000n + SETTLE - 1n, versions: offers(), orders: [o], renewals: late }).get(o.key).until, 1640n, "a renewal of a lapsed chain counts only once settled");
  assert.equal(until([renewal({ created: 300n, paid: 99n })]).until, 1640n + 1440n, "a part period counts as none");
  assert.equal(until([renewal({ created: 199n })]).until, 1640n, "a renewal before the order does not count");
  assert.equal(until([renewal({ created: 300n, path: "Nexus/testnet/y" })]).until, 1640n, "another chain's renewal");
  assert.equal(until([renewal({ created: 300n, id: "other" })]).until, 1640n, "another offer's renewal");
  const ended = until([renewal({ created: 300n })], { ...OFFER, until: 260n });
  assert.equal(ended.until, 260n, "never past the offer's end");
});

test("paid time: a second order for the same chain adds to it", () => {
  const first = order({ created: 200n }), second = order({ buyer: B, created: 300n });
  const v = judge({ sdk, height: 1000n, versions: offers(), orders: [first, second] });
  assert.equal(v.get(first.key).until, 1640n + 1440n);
  assert.equal(v.get(second.key).until, 1640n + 1440n);
});

test("an offer names the address its blocks pay and, if it runs one, its sponsor; both parse strictly", () => {
  const text = (o) => offerText(o.created, formatOffer(o));
  const full = { ...OFFER, blocks: C, sponsor: "https://host.example/sponsor" };
  assert.equal(formatOffer(full), `${formatOffer(OFFER)}\nblocks ${C}\nsponsor https://host.example/sponsor`);
  assert.deepEqual(parseOffer(text(full)), full);
  assert.deepEqual(parseOffer(text({ ...OFFER, blocks: C })), { ...OFFER, blocks: C }, "no sponsor line: no sponsor");
  assert.equal(parseOffer(text({ ...OFFER, blocks: C })).sponsor, undefined);
  const value = formatOffer(OFFER);
  for (const bad of [`blocks ${C}x`, "blocks bafyrei", "sponsor http://host.example/sponsor", "sponsor host.example", "sponsor ",
    `sponsor https://host.example\nblocks ${C}`, `blocks ${C}\nblocks ${C}`, `blocks ${C}\nsponsor https://a.example\nsponsor https://b.example`, `blocks ${C}\n`]) {
    assert.equal(parseOffer(offerText(OFFER.created, `${value}\n${bad}`)), undefined, bad);
  }
  assert.deepEqual(parseOffer(offerText(OFFER.created, `${value}\nblocks ${C}\nsponsor https://host.example\nmines 7`)).mines, 7n, "an old claim after them still reads");
});

// An offer written at 100, sold again (cheaper sponsor URL, same terms) at
// 300, closed at 500 (`until` = 500), and opened again at 700. Each takes
// effect CREATED_WINDOW (10) blocks after it is written.
const version = (o) => offerText(o.created ?? OFFER.created, formatOffer({ ...OFFER, ...o }));
const VERSIONS = [version({}), version({ created: 300n, sponsor: "https://host.example" }), version({ created: 500n, until: 500n }), version({ created: 700n })];
const judged = (orders, { versions = VERSIONS, renewals, height = 2000n } = {}) =>
  judge({ sdk, height, versions: new Map([[`${HOST}/o`, versions]]), orders, renewals });

test("judge needs every version: one text per offer cannot show which was in force", () => {
  const o = order();
  assert.throws(() => judge({ sdk, height: 1000n, offers: new Map([[`${HOST}/o`, VERSIONS[0]]]), orders: [o] }), /versions/);
});

test("a version takes effect CREATED_WINDOW blocks after it is written; the newest version is the offer on sale", () => {
  assert.equal(CREATED_WINDOW, 10n);
  assert.equal(offerAt(VERSIONS, 309n).created, 100n);
  assert.equal(offerAt(VERSIONS, 310n).sponsor, "https://host.example");
  assert.equal(offerAt(VERSIONS, 109n), undefined);
  assert.equal(offerAt(VERSIONS, 110n).created, 100n);
  assert.equal(inForce(VERSIONS, 310n), VERSIONS[1], "the text, for hosting and storage offers alike");
  assert.equal(parseOffer(newestOffers(new Map([[`${HOST}/o`, VERSIONS]])).get(`${HOST}/o`)).created, 700n);
  assert.equal(isClosed(offerAt(VERSIONS, 509n)), false);
  assert.equal(isClosed(offerAt(VERSIONS, 510n)), true);
  assert.equal(isClosed(offerAt(VERSIONS, 709n)), true);
  assert.equal(isClosed(offerAt(VERSIONS, 710n)), false);
  const pricier = [version({}), version({ created: 300n, price: 100n })];
  const before = order({ created: 309n }), after = order({ buyer: B, path: "Nexus/testnet/y", created: 310n });
  const v = judged([before, after], { versions: pricier });
  assert.equal(v.get(before.key).kind, "owed", "the price in force where it was placed");
  assert.deepEqual([v.get(after.key).kind, v.get(after.key).reason], ["void", "paid less than one period"], "the newer price, once in force");
});

test("a host cannot backdate a version over an order it has seen", () => {
  // An order keyed at 200 lands at 203; the host writes a version keyed at
  // 195 that lands at 204 (a key may name any of the last 10 heights).
  const o = order({ created: 200n });
  const honest = judged([o], { versions: [version({})] }).get(o.key);
  const close = judged([o], { versions: [version({}), version({ created: 195n, until: 195n })] }).get(o.key);
  const rise = judged([o], { versions: [version({}), version({ created: 199n, price: 51n })] }).get(o.key);
  for (const v of [close, rise]) assert.deepEqual([v.kind, v.until], [honest.kind, honest.until]);
  assert.deepEqual([honest.kind, honest.until], ["owed", 200n + 1440n]);
  // Keyed 10 back (it lands no later than the order it would void), it counts.
  assert.equal(judged([o], { versions: [version({}), version({ created: 190n, until: 190n })] }).get(o.key).kind, "void");
});

test("closed: an order where the close is in force is void; time paid before it is kept", () => {
  const before = order({ created: 505n }), at = order({ buyer: B, path: "Nexus/testnet/y", created: 510n }), after = order({ buyer: C, path: "Nexus/testnet/z", created: 600n });
  const v = judged([before, at, after]);
  assert.deepEqual([at, after].map((o) => [v.get(o.key).kind, v.get(o.key).reason]), [["void", "the offer was closed at market block 500"], ["void", "the offer was closed at market block 500"]]);
  assert.deepEqual([v.get(before.key).kind, v.get(before.key).until], ["owed", 505n + 1440n], "placed before the close took effect: a whole period, past the close");
  assert.equal(judged([order({ buyer: C, path: "Nexus/testnet/z", created: 705n })]).get(order({ buyer: C, path: "Nexus/testnet/z", created: 705n }).key).kind, "void", "not open again yet");
  const reopened = order({ buyer: C, path: "Nexus/testnet/z", created: 710n });
  assert.equal(judged([reopened]).get(reopened.key).kind, "owed", "opened again at 700, in force at 710");
});

test("closed: a renewal where the close is in force buys nothing; one before it counts", () => {
  const o = order({ created: 400n });
  const until = (renewals) => judged([o], { renewals }).get(o.key).until;
  assert.equal(until([]), 1840n);
  assert.equal(until([renewal({ created: 450n })]), 1840n + 1440n);
  assert.equal(until([renewal({ created: 509n })]), 1840n + 1440n, "before the close takes effect");
  assert.equal(until([renewal({ created: 510n })]), 1840n, "where it is in force");
  assert.equal(until([renewal({ created: 650n })]), 1840n, "while closed");
  assert.equal(until([renewal({ created: 800n })]), 1840n + 1440n, "opened again");
});

test("each payment buys time at the price in force at its own height", () => {
  const o = order({ created: 200n });  // 50 at price 50: one period, to 1640
  const versions = [version({}), version({ created: 300n, price: 100n })];
  assert.equal(judged([o], { versions, renewals: [renewal({ created: 305n, paid: 100n })] }).get(o.key).until, 1640n + 2880n, "before the rise: two periods");
  assert.equal(judged([o], { versions, renewals: [renewal({ created: 310n, paid: 100n })] }).get(o.key).until, 1640n + 1440n, "after it: one");
  const longer = [version({}), version({ created: 300n, period: 2000n })];
  assert.equal(judged([o], { versions: longer, renewals: [renewal({ created: 400n })] }).get(o.key).until, 1640n + 2000n, "its period too");
});

test("an offer ends at the latest `until` any version names", () => {
  const o = order({ created: 200n, paid: 500n });  // ten periods
  const short = [version({ until: 1000n }), version({ created: 300n, until: 5000n }), version({ created: 400n, until: 400n })];
  assert.equal(judged([o], { versions: short }).get(o.key).until, 5000n, "extended at 300, closed at 400: still 5000");
});

test("whole path: an order pays the price for each chain on its path, Nexus included", async () => {
  const { orderWrite, renewWrite } = await import("../client/tx.mjs");
  const { pathPrice } = await import("../client/records.mjs");
  const WHOLE = { ...OFFER, wholePath: true };   // under Nexus/testnet: Nexus, Nexus/testnet, the chain = 3 × 50
  const text = offerText(WHOLE.created, formatOffer(WHOLE));
  assert.ok(text.endsWith("\nwhole path"));
  assert.equal(parseOffer(text).wholePath, true);
  assert.equal(parseOffer(offerText(OFFER.created, formatOffer(OFFER))).wholePath, undefined, "an offer from before 2.1 is priced per order");
  assert.equal(pathPrice(WHOLE, "Nexus/testnet/x"), 150n);
  assert.equal(pathPrice(OFFER, "Nexus/testnet/x"), 50n);

  const at = (orders, renewals = []) => judge({ sdk, height: 1000n, versions: offers(WHOLE), orders, renewals });
  const short = order({ paid: 50n });
  assert.equal(at([short]).get(short.key).kind, "void", "one chain's price is less than one period of the path");
  const one = order({ paid: 150n }), two = order({ buyer: B, paid: 300n, path: "Nexus/testnet/y" });
  const v = at([one, two], [renewal({ created: 300n, paid: 150n })]);
  assert.equal(v.get(one.key).until, 200n + 1440n + 1440n, "one period, and one renewed");
  assert.equal(v.get(two.key).until, 200n + 2880n, "two periods");

  const w = orderWrite({ host: HOST, id: "o", offer: WHOLE, buyer: A, path: "Nexus/testnet/x", payload: { spec: SPEC, premineTo: null, modules: {}, genesisTransactions: [] }, periods: 2n, height: 500n });
  assert.equal(w.payments[0].amount, 300n);
  assert.equal(renewWrite({ host: HOST, id: "o", offer: WHOLE, payer: A, path: "Nexus/testnet/x", periods: 1n, height: 500n }).payments[0].amount, 150n);
});

test("an offer's sponsor by its path is on the host's url record's origin, as the record is now", () => {
  const text = (sponsor) => version({ sponsor });
  assert.equal(parseOffer(text("/sponsor")).sponsor, "/sponsor");
  assert.equal(parseOffer(text("https://host.example/sponsor")).sponsor, "https://host.example/sponsor");
  for (const bad of ["//evil.example/sponsor", "/\\evil.example/sponsor", "sponsor", "/sponsor?x=1", "/spon sor", "http://host.example/sponsor"]) assert.equal(parseOffer(text(bad)), undefined, bad);
  assert.equal(sponsorAt("/sponsor", "https://a-b.trycloudflare.com"), "https://a-b.trycloudflare.com/sponsor");
  assert.equal(sponsorAt("/sponsor", "https://host.example/read/\nproof https://host.example/.well-known/lattice.json"), "https://host.example/sponsor", "the origin, not the read path");
  assert.equal(sponsorAt("/sponsor", undefined), undefined, "no url record: no sponsor");
  assert.equal(sponsorAt("https://other.example/s", "https://host.example"), "https://other.example/s");
  assert.equal(sponsorAt(undefined, "https://host.example"), undefined);
});

test("the first order for a path, at any host, wins it", () => {
  const HOST2 = key(5);
  const text = offerText(OFFER.created, formatOffer(OFFER));
  const versions = new Map([[`${HOST}/o`, [text]], [`${HOST2}/o`, [text]]]);
  const at = (host, o) => ({ ...o, host, key: orderKey({ host, id: o.id, payer: o.buyer, height: o.created, paid: o.paid, path: o.path }) });
  const theirs = payload({ ...SPEC, initialReward: 11n });
  const first = order({ created: 200n, paid: 50n }), richer = at(HOST2, order({ buyer: B, created: 205n, paid: 1000n, payloadText: theirs }));
  const v = judge({ sdk, height: 1000n, versions, orders: [richer, first] });
  assert.deepEqual([v.get(first.key).kind, v.get(richer.key).kind], ["owed", "taken"], "a later, larger payment at another host does not take it");
  assert.equal(v.get(richer.key).elsewhere, true, "lost at another host: not this host's fault");
  assert.equal(v.get(first.key).until, 200n + 1440n, "paid time from the order, as before");
  const sameElsewhere = at(HOST2, order({ buyer: C, created: 300n }));
  assert.equal(judge({ sdk, height: 1000n, versions, orders: [first, sameElsewhere] }).get(sameElsewhere.key).kind, "owed", "the same genesis at a second host");
  const here = order({ buyer: B, created: 201n, payloadText: theirs });
  assert.equal(judge({ sdk, height: 1000n, versions, orders: [first, here] }).get(here.key).elsewhere, false, "at the same host: counted against it, as before");
});

test("a reader that knows a path's genesis judges which order was first as one that does not", () => {
  const facts = (spec) => ({ specCID: sdk.cidV1DagCbor(sdk.encodeDagCbor(spec)), premineTo: null, transactions: [] });
  const OTHER = { ...SPEC, initialReward: 11n };
  const x = order({ created: 200n }), y = order({ buyer: B, created: 205n, payloadText: payload(OTHER) });
  for (const g of [facts(SPEC), facts(OTHER)]) {
    const v = judge({ sdk, height: 1000n, versions: offers(), orders: [x, y], genesis: new Map([["Nexus/testnet/x", g]]) });
    assert.equal(v.get(y.key).kind, "taken", "y is never owed: x came first");
  }
});

test("an order taken by an earlier one takes none of its offer's chains", () => {
  const ONE = { ...OFFER, capacity: 1n };
  const x = order({ created: 200n }), rival = order({ buyer: B, created: 201n, payloadText: payload({ ...SPEC, initialReward: 11n }) });
  const again = order({ buyer: C, created: 202n });  // the same chain as x
  assert.deepEqual(verdicts([x, rival, again], { versions: offers(ONE) }), ["owed", "taken", "owed"]);
  const ONE2 = { ...OFFER, capacity: 2n }, other = order({ buyer: C, path: "Nexus/testnet/y", created: 203n });
  assert.deepEqual(verdicts([x, rival, other], { versions: offers(ONE2) }), ["owed", "taken", "owed"], "the rival did not fill the second chain");
});

test("a name is held while its chain has paid time; once that runs out the next order takes it", () => {
  const HOST2 = key(5);
  const text = offerText(OFFER.created, formatOffer(OFFER));
  const versions = new Map([[`${HOST}/o`, [text]], [`${HOST2}/o`, [text]]]);
  const at = (host, o) => ({ ...o, host, key: orderKey({ host, id: o.id, payer: o.buyer, height: o.created, paid: o.paid, path: o.path }) });
  const NEW = payload({ ...SPEC, initialReward: 11n });
  const first = order({ created: 200n });  // paid to 1640
  const early = at(HOST2, order({ buyer: B, created: 1639n, payloadText: NEW }));
  const after = at(HOST2, order({ buyer: B, created: 1640n, payloadText: NEW }));
  const j = (orders, rs = [], h = 5000n) => judge({ sdk, height: h, versions, orders, renewals: rs });
  assert.equal(j([first, early]).get(early.key).kind, "taken", "while the first chain has paid time");
  let v = j([first, after]);
  assert.deepEqual([v.get(first.key).kind, v.get(after.key).kind], ["owed", "owed"], "its time ran out at 1640: the name passes");
  assert.equal(v.get(after.key).until, 1640n + 1440n);
  assert.equal(v.get(after.key).elsewhere, undefined);

  // A renewal keyed before the next order keeps the name; one keyed at or after it buys nothing.
  const kept = [renewal({ payer: A, created: 1000n })];
  assert.equal(j([first, after], kept).get(after.key).kind, "taken", "renewed in time");
  const lateRenewal = [renewal({ payer: A, created: 1700n })];
  v = j([first, after], lateRenewal);
  assert.deepEqual([v.get(first.key).until, v.get(after.key).kind], [1640n, "owed"], "the old chain's renewal after the handover buys nothing");

  // The old payload ordered again while the new holder has time is taken; after it lapses, it may win back.
  const back = order({ buyer: C, created: 2000n }), backLater = order({ buyer: C, created: 3080n });
  assert.equal(j([first, after, back]).get(back.key).kind, "taken");
  v = j([first, after, backLater]);
  assert.equal(v.get(backLater.key).kind, "owed", "the old genesis again, once the new one's time ran out");
  assert.equal(v.get(first.key).until, 1640n, "the old era keeps its own paid time");
  assert.equal(v.get(backLater.key).until, 3080n + 1440n, "a new era's paid time starts fresh");
});

test("a lapsed chain's renewal that would keep its name is fixed before the next order is judged", () => {
  const first = order({ created: 200n });  // paid to 1640
  const next = order({ buyer: B, path: "Nexus/testnet/x", created: 1705n, payloadText: payload({ ...SPEC, initialReward: 11n }) });
  const renew = [renewal({ payer: A, created: 1700n })];  // after the lapse, before the next order
  for (const h of [1716n, 1720n, 1721n, 3000n]) {
    const v = judge({ sdk, height: h, versions: offers(), orders: [first, next], renewals: renew });
    assert.equal(v.get(first.key).until, h >= 1716n ? 1700n + 1440n : 1640n);
    if (h >= 1721n) assert.equal(v.get(next.key).kind, "taken", `at ${h}: the renewal kept the name`);
  }
});
