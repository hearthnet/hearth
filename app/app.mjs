// Hearth: launch a Lattice chain without running a node.
//
// Everything is read from the market chain through any node that hosts it,
// verified by CID (client/market.mjs), and judged with the same module the
// hosts use (client/verdict.mjs). The account is a key kept in this
// browser; it signs every write. The buyer configures its chain and this
// page mints the chain's genesis (app/genesis.mjs); the order carries it to
// each host. Coin is bought from sellers on the market chain with
// parent-chain coin, through Lattice's own exchange: the seller's deposit,
// the buyer's receipt on the parent, the buyer's withdrawal.
import * as sdk from "../vendor/lattice-sdk.js";
import { loadGenesis } from "../vendor/lattice-genesis.js";
import { TESTNET_MARKET, marketMismatch, reader } from "../client/market.mjs";
import { chainReaders, declaredNodes } from "../client/chains.mjs";
import { holderOf, judge } from "../client/verdict.mjs";
import { isRenewal, parseOffer, parseOrderKey, moduleCID, isAddress, burnAddress, pathFromNexus, sellsUnder, overLimits } from "../client/records.mjs";
import { snippet } from "./snippet.mjs";
import { uniqueNodes, nodesNow, chooseAnchor, disagreeMessage, blocksTime, CHECKPOINT_AFTER, WALK } from "./anchor.mjs";
import { chosenTerms, heldCheck, launchAttempt, offersFor } from "./launch.mjs";
import { chainSpec, mintGenesis, BLOCK_REWARD } from "./genesis.mjs";
import { once } from "./once.mjs";
import { creditedHashrate, formatRate } from "../client/mining.mjs";
import { renewWrite, recordsBody, receiptBody, withdrawalBody, depositBody, submit, keyFileJSON } from "../client/tx.mjs";

// The browser SDK a buyer's page loads: this repository's vendored copy
// (vendor/lattice-browser.js) at a release tag. null until a tag holds it;
// the app itself imports the local file.
const SDK_TAG = "v3.1.0";
const SDK_URL = `https://cdn.jsdelivr.net/gh/hearthnet/hearth@${SDK_TAG}/vendor/lattice-browser.js`;
const DOCS = "https://hearthnet.github.io/";

// ---- configuration: ?node=&entry=&market=&genesis=&sponsor= override the defaults ----
const params = new URLSearchParams(location.search);
// The markets this page knows, by path, and each one's genesis, so a node
// serving another chain at that path is never read as the market. Testnet's
// (client/market.mjs) is the default; mainnet's (chain/market.json) still
// runs the earlier design until it is relaunched, and this page reads only
// offers as client/records.mjs reads them. ?market= with ?genesis= reads another.
const MARKETS = {
  [TESTNET_MARKET.path]: TESTNET_MARKET.genesis,
  "Nexus/hearth": "bafyreiallx3geissybbne6zlbvpovmnl7uqtsvfkwvgr3o4ii66w3xommq",
};
const cfg = {
  // Any node hosting Nexus: it lists the market's nodes (findNode), and every other chain's (nodesFor).
  entry: params.get("entry") ?? "https://rpc.lattice.build",
  node: params.get("node"),
  market: params.get("market") ?? TESTNET_MARKET.path,
  // A fee sponsor that pays out the parent's coin for work; none by default.
  sponsor: params.get("sponsor") ?? "",
  blockSeconds: Number(params.get("blockSeconds") ?? 60),
};
const marketPath = cfg.market.split("/");
const parentPath = marketPath.slice(0, -1).join("/");
const directory = marketPath.at(-1);
const coinName = "Hearth coin", parentCoin = `${marketPath.at(-2)} coin`;

/** Nodes for `chainPath` the entry's network declares (`/api/chain/endpoints`, through the SDK's resolver): `[{ url, declaresSubmit }]`. */
const declared = (chainPath) => declaredNodes(sdk, cfg.entry, chainPath);
/**
 * A node serving the market, found through Lattice: of the nodes the entry
 * lists for it, all probed at once, each with a timeout, the fastest that
 * takes transactions (the app reads from and sends to one node) and whose
 * market has the market's genesis; none, the entry.
 */
async function findNode() {
  const market = cfg.market.split("/");
  const genesis = params.get("genesis") ?? MARKETS[cfg.market];
  const hosts = await declared(cfg.market);
  const fastest = (some) => Promise.any(some.map(async ({ url }) => {
    if (genesis && (await new sdk.NodeClient(url, market).chainInfo(AbortSignal.timeout(5_000))).genesisHash !== genesis) throw new Error("another chain");
    return url;
  }));
  try { return await fastest(hosts.filter((h) => h.declaresSubmit)); } catch { return cfg.entry; }
}
if (!cfg.node) cfg.node = await findNode();
const r = reader(sdk, cfg.node);

/**
 * Readers of the chain above an ordered one, which the market's node may
 * not host (client/chains.mjs): the app's node when it serves the chain,
 * else the fastest node the entry lists for it.
 */
const { readerOf } = chainReaders(sdk, r, { entry: cfg.entry });

/**
 * The nodes serving `chainPath` from `genesis`, those taking transactions
 * first: the app's node and every node the entry lists for the chain, each
 * asked for the chain's genesis. Kept for a minute.
 */
const nodesOnce = once({ ttl: 60_000 });
const nodesFor = (chainPath, genesis) => nodesOnce(`${chainPath} ${genesis}`, async () => {
  const listed = await declared(chainPath);
  const urls = uniqueNodes(sdk, [...listed.filter((h) => h.declaresSubmit).map((h) => h.url), cfg.node, ...listed.map((h) => h.url)]);
  const serving = await Promise.all(urls.map((url) => new sdk.NodeClient(url, chainPath.split("/")).chainInfo(AbortSignal.timeout(5_000))
    .then((info) => (info.genesisHash === genesis ? url : null), () => null)));
  return serving.filter(Boolean);
});

// ---- small helpers ----
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => BigInt(n).toLocaleString("en-US");
const short = (a) => (a ? `${a.slice(0, 10)}…${a.slice(-4)}` : "");
const store = {
  // The key is the account's, on any market; what is bought, ordered or
  // chosen belongs to one market.
  // The prefix keeps the old name "lodger": renaming it would lose keys saved in browsers.
  name: (k, app = "lodger") => (k === "key" || k === "draft" ? `${app}:${k}` : `${app}:${cfg.market}:${k}`),
  get(k, d) {
    try {
      let v = localStorage.getItem(store.name(k));
      // Before the rename the app was Moorage; carry its entries over.
      if (v === null && (v = localStorage.getItem(store.name(k, "moorage"))) !== null) localStorage.setItem(store.name(k), v);
      return v === null ? d : JSON.parse(v);
    } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem(store.name(k), JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x))); } catch {} },
};
const revive = (o) => JSON.parse(JSON.stringify(o), (_, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
const duration = (blocks) => {
  const s = Number(blocks) * cfg.blockSeconds;
  if (s >= 86400 * 2) return `${Math.round(s / 86400)} days`;
  if (s >= 3600 * 2) return `${Math.round(s / 3600)} hours`;
  if (s >= 120) return `${Math.round(s / 60)} minutes`;
  return `${s} seconds`;
};
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** A host's name: its address past the fixed `bafyrei`, 8 and 8. */
const hostName = (host) => { const k = host.replace(/^bafyrei/, ""); return `${k.slice(0, 8)}…${k.slice(-8)}`; };

// ---- the account: one key in this browser ----
let me = (() => {
  const hex = store.get("key");
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/.test(hex)) return null;
  const privateKey = sdk.hexToBytes(hex);
  return { privateKey, address: sdk.accountFromPrivateKey(privateKey).address };
})();
function makeAccount() {
  const privateKey = sdk.generatePrivateKey();
  store.set("key", sdk.bytesToHex(privateKey));
  me = { privateKey, address: sdk.accountFromPrivateKey(privateKey).address };
  return me;
}
const keyFile = () => keyFileJSON(sdk, me.privateKey);

const balances = { market: null, parent: null, at: 0 };
async function loadBalances() {
  if (!me) return;
  const [m, p] = await Promise.all([r.account(cfg.market, me.address).catch(() => null), r.account(parentPath, me.address).catch(() => null)]);
  balances.market = m; balances.parent = p; balances.at = Date.now();
  renderChip();
}
function renderChip() {
  const chip = $("#chip");
  if (!me) { chip.innerHTML = `<span>No account yet</span>`; return; }
  chip.innerHTML = `<span><b>${balances.market ? fmt(balances.market.balance) : "…"}</b> ${coinName}</span><span><b>${balances.parent ? fmt(balances.parent.balance) : "…"}</b> ${esc(parentCoin)}</span>`;
}

// ---- the market, judged ----
let market = null, verdicts = new Map(), loading = null, policyRead;
async function loadMarket(force = false) {
  if (!force && market && Date.now() - market.at < 15_000) return market;
  loading ??= (async () => {
    // This page reads only v3.1 offers and orders: on any other market it would judge every order void.
    const wrong = marketMismatch(await (policyRead ??= r.spec(cfg.market).catch((e) => { policyRead = undefined; throw e; })), cfg.market);
    if (wrong) throw new Error(wrong);
    const m = await r.market(cfg.market);
    m.at = Date.now();
    // Each offer's terms now: what an order placed now asserts and pays at.
    m.terms = new Map([...m.offers].map(([k, t]) => [k, parseOffer(t)]).filter(([, o]) => o));
    verdicts = judge({ sdk, height: m.height, orders: m.orders, market: cfg.market });
    market = m;
    return m;
  })().finally(() => { loading = null; });
  return loading;
}
/** Orders that launch a chain (not renewals). */
const launches = (m) => m.orders.filter((o) => !isRenewal(o.value));
/** Owed orders still paid for, at `host` (any host when undefined), one per path. */
const owedNow = (m, host) => [...new Map(launches(m).filter((o) => (host === undefined || o.host === host) && verdicts.get(o.key)?.kind === "owed" && verdicts.get(o.key).active).map((o) => [o.path, o])).values()];

/** Checks' answers, kept for five minutes (app/once.mjs). */
const checkOnce = once();

/**
 * The hash rate `blocks` (an offer's reward address) is credited with on
 * `chainPath` (genesis `genesis`) over the last day, at most 200 blocks, read
 * by CID from a node serving that genesis: `{ rate }`, or `{ reason }`.
 */
const DAY = 86_400_000;
const creditedOn = (chainPath, genesis, blocks) => checkOnce(`credited ${chainPath} ${genesis} ${blocks}`, async () => {
  const [node] = await nodesFor(chainPath, genesis);
  if (!node) return { reason: "no node serves it" };
  const since = Date.now() - DAY, max = 200;
  const read = await reader(sdk, node).recentBlocks(chainPath, { since, max });
  if (!read.length) return { reason: "no blocks in the last day" };
  const c = creditedHashrate(read, read.complete ? { from: since, to: Date.now() } : {});
  return { rate: c.rate.get(blocks) ?? 0n };
});
/**
 * What a host delivers: the lowest hash rate its offer's `blocks` address is
 * credited with over up to three chains it is paid to host now. `{ rate,
 * chains }`, or `{ reason }` when no chain could be read.
 */
async function delivered(m, host, offer) {
  const owed = owedNow(m, host).slice(0, 3);
  if (!owed.length) return { reason: "No chain of its to measure yet" };
  const read = (await Promise.all(owed.map((o) => creditedOn(o.path, verdicts.get(o.key).genesis, offer.blocks).catch(() => ({ reason: "unreadable" }))))).filter((x) => x.rate !== undefined);
  if (!read.length) return { reason: "Its chains could not be read" };
  return { rate: read.reduce((lo, x) => (x.rate < lo ? x.rate : lo), read[0].rate), chains: read.length };
}
const deliveredText = (d) => (d.rate === undefined ? d.reason : `${formatRate(d.rate)} (lowest of ${d.chains} chain${d.chains > 1 ? "s" : ""}, last day)`);

const fee = async (chain) => BigInt((await r.api("/api/chain/info", chain).catch(() => ({}))).minRelayFee ?? 1);

/** Sign and send, retrying refusals a later block may clear; `onRetry` hears why. */
async function send(build, { tries = 60, onRetry } = {}) {
  for (let i = 0; ; i++) {
    try { return await submit(sdk, cfg.node, await build(), me.privateKey); }
    catch (e) {
      // Retried: refusals a later block may clear — nonceAhead (an earlier tx of ours not yet
      // in a block), unavailable (content not fetched yet), feeTooLow (a conflicting pooled tx).
      const retriable = e.status === 400 && /unavailable|feeTooLow|nonce/i.test(e.message);
      if (!retriable || i >= tries) throw e;
      onRetry?.(e);
      await sleep(4000);
    }
  }
}

// ---- routing ----
const routes = { "": viewLaunch, coin: viewCoin, hosts: viewHosts, orders: viewOrders, order: viewOrder, wallet: viewWallet };
let renderId = 0;
async function route() {
  const [name, ...rest] = location.hash.replace(/^#\/?/, "").split("?")[0].split("/");
  const id = ++renderId;
  for (const a of document.querySelectorAll("nav a")) {
    if (a.dataset.route === (name || "launch") || (name === "order" && a.dataset.route === "orders")) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const view = $("#view");
  try {
    await (routes[name] ?? viewLaunch)(view, decodeURIComponent(rest.join("/")), () => id === renderId);
  } catch (e) {
    console.error(e);
    if (id === renderId) view.innerHTML = `<div class="notice bad">Could not read the market from ${esc(cfg.node)}: ${esc(e.message)}. <a href="" onclick="location.reload();return false">Try again</a></div>`;
  }
  window.scrollTo?.(0, 0);
}
addEventListener("hashchange", route);

// ---- Launch a chain ----
// Sizes to start from; every number can be changed under Advanced.
const PRESETS = {
  small: { label: "Small app", targetBlockTime: 30000, maxBlockSize: 20000, maxStateGrowth: 10000, maxNumberOfTransactionsPerBlock: 100 },
  busy: { label: "Busy app", targetBlockTime: 5000, maxBlockSize: 1000000, maxStateGrowth: 1000000, maxNumberOfTransactionsPerBlock: 1000 },
};

// Who may write what: presets built from app/rules (build.sh there), or a
// module of the buyer's own.
const RULES = {
  anyone: { label: "Anyone can write", hint: "Anyone can write any key, and change or delete it." },
  own: { label: "Each person edits only their own keys", hint: "Every key ends with its writer's address, like <span class=\"mono\">events/42/&lt;address&gt;</span>, and only that person can change or delete it. Lists still read by prefix: <span class=\"mono\">events/</span> lists everyone's.", file: "own_keys.wasm" },
  once: { label: "Append-only (write once)", hint: "Anyone can add a new key; nobody can change or delete it after.", file: "write_once.wasm" },
  custom: { label: "Upload your own .wasm (advanced)", hint: "Policy modules you built." },
};
const rulesReady = Promise.all(Object.values(RULES).filter((x) => x.file).map(async (x) => {
  const bytes = new Uint8Array(await (await fetch(new URL(`./rules/${x.file}`, import.meta.url))).arrayBuffer());
  x.b64 = btoa(String.fromCharCode(...bytes));
  x.cid = moduleCID(sdk, x.b64);
}));
/** The genesis builder (vendor/lattice-genesis.js), loaded when first used. */
let builder;
const genesisBuilder = () => (builder ??= loadGenesis(new URL("../vendor/lattice-genesis.wasm", import.meta.url)).catch((e) => { builder = undefined; throw e; }));

/** The buyer's chain as last configured (the Launch page keeps it): what Hosts prices. */
const { label: _, ...SMALL } = PRESETS.small;
const DRAFT = { name: "", parent: parentPath, preset: "small", ...SMALL, premine: "21000", periods: "7", rules: "anyone", modules: {} };
const draft = () => ({ ...DRAFT, ...store.get("draft", {}) });
/** The spec a draft makes, numbers checked: `{ spec }`, or `{ error }`. */
function draftSpec(d, modules) {
  const n = (v) => Number(v);
  const sizes = { maxBlockSize: n(d.maxBlockSize), targetBlockTime: n(d.targetBlockTime), maxStateGrowth: n(d.maxStateGrowth), maxNumberOfTransactionsPerBlock: n(d.maxNumberOfTransactionsPerBlock) };
  for (const [k, v] of Object.entries(sizes)) if (!Number.isSafeInteger(v) || v < 1) return { error: `${k} must be a whole number above 0` };
  const premineCoin = Math.max(0, Math.floor(n(d.premine) || 0));
  return { spec: chainSpec({ ...sizes, premineCoin, moduleCIDs: Object.keys(modules) }) };
}

/** A launch is in flight (it outlives its view): no other Launch may start. */
let launchInFlight = false;
async function viewLaunch(view, _, current) {
  const m = await loadMarket();
  // The fees each step pays: an order and a withdrawal on the market, a receipt on its parent.
  const [, marketFee, parentFee] = await Promise.all([rulesReady.catch(() => {}), fee(cfg.market), fee(parentPath)]);
  if (!current()) return;
  const d = draft();
  const rulesChoice = RULES[d.rules] ? d.rules : Object.keys(d.modules ?? {}).length ? "custom" : "anyone";
  const numberField = (id, label, value, hint) => `<div><label for="${id}">${label}</label><input id="${id}" type="number" min="1" step="1" value="${esc(value)}">${hint ? `<p class="hint">${hint}</p>` : ""}</div>`;
  view.innerHTML = `
  <section>
    <h1>Launch an app</h1>
    <p class="lead">Name your app, choose who can write, and pay hosts for the time you want. This page makes your chain's first block; the hosts run it and mine it. Then paste the code into your page. <a href="${DOCS}">How it works</a></p>
  </section>
  <section class="stack">
    <h2>1. Your app</h2>
    <div class="fields">
      <div><label for="name">App name</label><input id="name" type="text" autocomplete="off" spellcheck="false" placeholder="my-app" value="${esc(d.name)}"><p class="hint" id="pathHint"></p></div>
    </div>
    <fieldset class="stack" style="border:0;padding:0;margin:16px 0 0"><legend style="font-weight:600;font-size:14px;margin-bottom:4px">Who can write</legend>
      ${Object.entries(RULES).map(([k, x]) => `<label class="choice"><input type="radio" name="rules" value="${k}" ${k === rulesChoice ? "checked" : ""}><span><b>${x.label}</b><br><span class="hint">${x.hint}</span></span></label>`).join("")}
      <p id="customRules" ${rulesChoice === "custom" ? "" : "hidden"}><input type="file" id="modules" accept=".wasm" multiple><span class="hint" id="moduleList" style="display:block"></span></p>
      <p class="hint"><b>Rules are fixed at launch:</b> they can't be changed later. To change them, launch a new app.</p>
    </fieldset>
    <details${d.preset !== "small" || d.parent !== parentPath || d.premine !== "21000" ? " open" : ""}><summary>Advanced</summary>
      <div class="fields" style="margin-top:12px">
        <div><label for="parent">Under the chain</label><input id="parent" type="text" autocomplete="off" spellcheck="false" value="${esc(d.parent)}"><p class="hint">Only hosts that sell under this chain are listed. You pay for your chain alone.</p></div>
        <div><label for="preset">Size</label><select id="preset">${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}" ${d.preset === k ? "selected" : ""}>${p.label}: ${p.targetBlockTime / 1000} s blocks, ${fmt(p.maxBlockSize / 1000)} kB</option>`).join("")}<option value="custom" ${d.preset === "custom" ? "selected" : ""}>Custom</option></select></div>
        ${numberField("maxBlockSize", "Block size (bytes)", d.maxBlockSize)}
        ${numberField("targetBlockTime", "Block time (ms)", d.targetBlockTime)}
        ${numberField("maxStateGrowth", "New state a block (bytes)", d.maxStateGrowth)}
        ${numberField("maxNumberOfTransactionsPerBlock", "Transactions a block", d.maxNumberOfTransactionsPerBlock)}
        <div><label for="premine">Coin your app starts with</label><input id="premine" type="number" min="0" step="1" value="${esc(d.premine)}"><p class="hint">Paid to your account on the app's own chain. Writes pay fees from it.</p></div>
      </div>
      <p class="hint">Your app runs as its own chain, <span class="mono" id="pathFull"></span>. Each host sets one price a period for a chain, and the largest block rate and state growth it takes: hosts whose limits are below your chain's are not listed. Each block pays ${fmt(BLOCK_REWARD)} of its coin to whoever mines it.</p>
    </details>
  </section>
  <section class="stack">
    <h2>2. Hosts</h2>
    <p class="muted small">Two hosts are picked for you when two are open: if one stops, the other keeps your app online. Each is paid separately. Every host mines each chain it hosts with all of its hash rate: what it claims, and what its blocks show. <a href="#/hosts">Compare hosts</a></p>
    <div id="offers"></div>
  </section>
  <section class="stack">
    <h2>3. Pay and launch</h2>
    <div class="row"><div style="width:140px"><label for="periods">Periods</label><input id="periods" type="number" min="1" step="1" value="${esc(d.periods)}"><p class="hint" id="periodHint"></p></div><p class="muted" id="cost" style="margin-top:22px"></p></div>
    <div id="launchNote"></div>
    <div id="pending"></div>
    <p class="small muted">Your order is judged as soon as it is in a block: owed by the host from then until its paid time runs out, or void, with the reason. When paid time ends, a host may stop hosting your app. Anyone can pay for more time from the app's page.</p>
    <div class="row"><button class="btn primary" id="launch">Launch</button></div>
  </section>`;

  let custom = d.modules ?? {};
  const rules = () => document.querySelector("input[name=rules]:checked")?.value ?? "anyone";
  const modules = () => {
    const k = rules();
    if (k === "custom") return custom;
    return RULES[k].cid ? { [RULES[k].cid]: RULES[k].b64 } : {};
  };
  const SIZE_FIELDS = ["maxBlockSize", "targetBlockTime", "maxStateGrowth", "maxNumberOfTransactionsPerBlock"];
  const read = () => ({ name: $("#name").value.trim(), parent: $("#parent").value.trim().replace(/\/+$/, ""), preset: $("#preset").value, premine: $("#premine").value, periods: $("#periods").value, rules: rules(), modules: custom,
    ...Object.fromEntries(SIZE_FIELDS.map((f) => [f, $(`#${f}`).value])) });
  // Hearth coin for sale: a buyer short of it pays in the parent's coin, and Launch buys it first.
  let forSale = [];
  const readSales = async () => { forSale = (await r.deposits(cfg.market)).filter((x) => x.amountDeposited > marketFee); };
  readSales().then(() => current() && refresh()).catch(() => {});
  /** The cheapest sale that covers `short`: a purchase lands the sale less the withdrawal's fee. */
  const dealFor = (short) => forSale.filter((x) => x.amountDeposited - marketFee >= short && x.demander !== me?.address)
    .sort((a, b) => (a.amountDemanded < b.amountDemanded ? -1 : 1))[0];
  const saved = store.get("offers", null);
  let chosen = Array.isArray(saved) ? saved : [];
  // Hosts are picked for the buyer until they pick themselves (unchecking every host stays unchecked).
  let autoPick = chosen.length === 0;
  let lastError = null;
  // Prices for the configuration as it stands; recomputed as it changes (`priced` is the latest).
  let priced = { offers: [] };
  const stats = statsByHost();

  const reprice = () => {
    const now = read(), s = draftSpec(now, modules());
    priced = s.error ? { error: s.error, offers: [] } : { offers: offersFor({ terms: m.terms, parent: now.parent, spec: s.spec }), spec: s.spec };
    refresh();
  };

  const refresh = () => {
    const now = read();
    store.set("draft", now);
    $("#customRules").hidden = rules() !== "custom";
    $("#moduleList").textContent = Object.keys(custom).length ? `Modules: ${Object.keys(custom).map(short).join(", ")}` : "";
    // One offer per host, its cheapest, so each pick is another host.
    const byHost = new Map();
    for (const x of priced.offers) if (!byHost.has(x.host)) byHost.set(x.host, x);
    const shown = [...byHost.values()];
    const before = chosen.length;
    chosen = chosen.filter((k) => shown.some((x) => x.k === k));
    if (before && !chosen.length) autoPick = true;   // what they picked is gone: pick again
    if (!chosen.length && autoPick) chosen = shown.slice(0, 2).map((x) => x.k);
    $("#offers").innerHTML = priced.error ? `<div class="notice bad">${esc(priced.error)}</div>`
      : !priced.spec ? `<p class="muted">Pricing your chain…</p>`
      : shown.length === 0 ? `<div class="empty">No host sells under ${esc(now.parent)} for a chain this size right now. Check back, or see <a href="#/hosts">Hosts</a>.</div>`
      : `<div class="table-scroll"><table><thead><tr><th></th><th>Host</th><th class="num">Price</th><th>Hash rate</th><th>Record</th></tr></thead><tbody>${shown.map((x) => `<tr data-offer="${esc(x.k)}"><td><input type="checkbox" name="offer" value="${esc(x.k)}" ${chosen.includes(x.k) ? "checked" : ""} aria-label="Choose ${esc(hostName(x.host))}"></td>
            <td class="mono">${esc(hostName(x.host))}</td>
            <td class="num"><b>${fmt(x.price)}</b> <span class="muted small">per ${duration(x.offer.period)}</span></td>
            <td class="small">claims ${formatRate(x.offer.hashrate)}<br><span class="muted" data-delivered>delivered: …</span></td>
            <td class="small">${recordLine(stats.get(x.host))}</td></tr>`).join("")}</tbody></table></div>`;
    for (const x of shown) delivered(m, x.host, x.offer).then((dl) => {
      const el = document.querySelector(`[data-offer="${CSS.escape(x.k)}"] [data-delivered]`);
      if (el && current()) el.textContent = `delivered: ${deliveredText(dl)}`;
    });
    for (const box of document.querySelectorAll("input[name=offer]")) box.onchange = () => {
      autoPick = false; lastError = null;
      chosen = box.checked ? [...chosen, box.value] : chosen.filter((k) => k !== box.value);
      store.set("offers", chosen); refresh();
    };
    const offers = chosen.map((k) => shown.find((x) => x.k === k));
    const periods = BigInt(Math.max(1, Math.floor(Number(now.periods) || 1)));
    const path = now.parent ? `${now.parent}/${now.name}` : now.name;
    const nameOK = sdk.isValidChildDirectory?.(now.name) !== false && /^[a-z0-9][a-z0-9-]{0,39}$/.test(now.name);
    $("#pathHint").innerHTML = now.name && !nameOK ? `<span style="color:var(--bad)">Lowercase letters, digits and dashes, up to 40.</span>` : "Lowercase letters, digits and dashes.";
    $("#pathFull").textContent = path || "…";
    const lengths = [...new Set(offers.map((x) => x.offer.period))];
    $("#periodHint").textContent = lengths.length === 1 ? `× ${duration(lengths[0])} = ${duration(lengths[0] * periods)}` : "";
    const cost = offers.reduce((sum, x) => sum + x.price * periods, 0n);
    $("#cost").innerHTML = offers.length === 0 ? ""
      : offers.length === 1 ? `<b>${fmt(cost)} ${coinName}</b> for ${duration(offers[0].offer.period * periods)} of hosting`
      : `<b>${fmt(cost)} ${coinName}</b>: ${offers.map((x) => `${fmt(x.price * periods)} for ${duration(x.offer.period * periods)} at ${esc(hostName(x.host))}`).join(", ")}`;
    const out = { offers, path, periods, now, mods: modules(), nameOK, cost };
    const note = $("#launchNote");
    const button = $("#launch");
    // A launch in flight owns the button and the note until it ends.
    if (launchInFlight) { button.disabled = true; return out; }
    const known = !me || (balances.market && balances.parent);   // unknown is not zero: never buy on a failed read
    const have = balances.market?.balance ?? 0n, need = cost + marketFee;
    const lacking = offers.length > 0 && known && have < need;
    button.disabled = !offers.length || !nameOK || !now.parent;
    if (RULES[rules()].file && !RULES[rules()].cid) { note.innerHTML = `<div class="notice bad">These rules did not load. <a href="" onclick="location.reload();return false">Reload</a> to try again.</div>`; button.disabled = true; }
    // A coin purchase not finished (in progress, or failed after paying): finish or dismiss it first.
    else if (buying && buying.step !== "done") { note.innerHTML = `<div class="notice">Finish or dismiss your coin purchase below before launching.</div>`; button.disabled = true; showPending(); }
    else if (!known) { note.innerHTML = `<p class="small muted">Reading your balance…</p>`; button.disabled = true; }
    else if (lacking) {
      // Short of Hearth coin: pay in the parent's coin instead, through the cheapest sale that covers it.
      const deal = dealFor(need - have), pay = deal ? deal.amountDemanded + parentFee : 0n, hasParent = balances.parent?.balance ?? 0n;
      if (!deal) { note.innerHTML = `<div class="notice">This takes ${fmt(need)} ${coinName}${me ? `; you have ${fmt(have)}` : ""}, and nobody is selling enough right now. <a href="#/coin">See what's for sale</a></div>`; button.disabled = true; }
      else if (hasParent < pay) { note.innerHTML = `<div class="notice">This costs <b>${fmt(pay)} ${esc(parentCoin)}</b>${me ? `; you have ${fmt(hasParent)}` : ""}. ${me ? "" : "Launching makes an account in this browser. "}<a href="#/coin">Get ${esc(parentCoin)}</a></div>`; button.disabled = true; }
      else {
        const landed = deal.amountDeposited - marketFee, left = have + landed - need;
        note.innerHTML = `<p class="small muted">This costs <b>${fmt(pay)} ${esc(parentCoin)}</b>: Launch buys ${fmt(landed)} ${coinName} with it (the cheapest sale that covers this), then pays ${offers.length > 1 ? "the hosts" : "the host"}${left > 0n ? `; the ${fmt(left)} left over stays in your account` : ""}. It takes a few minutes. There are no refunds: <a href="#/hosts">check ${offers.length > 1 ? "each host's" : "the host's"} record</a> first.</p>`;
      }
    }
    else note.innerHTML = offers.length ? `<p class="small muted">There are no refunds: <a href="#/hosts">check a host's record</a> first. If a host changes its terms before your payment lands, the market refuses it and nothing is paid.</p>` : "";
    if (lastError) note.insertAdjacentHTML("afterbegin", `<div class="notice bad">${esc(lastError)}</div>`);
    button.textContent = lacking && !button.disabled ? "Buy coin and launch" : "Launch";
    return out;
  };
  const edit = () => { lastError = null; refresh(); };
  const editSize = () => { lastError = null; reprice(); };
  $("#name").oninput = edit;
  $("#periods").oninput = edit;
  $("#premine").oninput = editSize;
  let parentTimer;
  $("#parent").oninput = () => { clearTimeout(parentTimer); parentTimer = setTimeout(editSize, 400); };
  for (const f of SIZE_FIELDS) $(`#${f}`).oninput = () => { $("#preset").value = "custom"; editSize(); };
  $("#preset").onchange = () => {
    const p = PRESETS[$("#preset").value];
    if (p) for (const f of SIZE_FIELDS) $(`#${f}`).value = p[f];
    editSize();
  };
  for (const radio of document.querySelectorAll("input[name=rules]")) radio.onchange = editSize;
  $("#modules").onchange = async (e) => {
    custom = {};
    for (const file of e.target.files) {
      const b64 = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
      custom[moduleCID(sdk, b64)] = b64;
    }
    reprice();
  };
  if (me) loadBalances().then(() => current() && refresh());
  refresh();
  reprice();
  // Coin that lands while this page is open (the 20 s balance check) updates what Launch can do.
  refreshYou = () => { if (current()) refresh(); };

  $("#launch").onclick = async () => {
    if (launchInFlight || (buying && buying.step !== "done")) return;
    const { offers, path, periods, now, mods, nameOK, cost } = refresh();
    if (!offers.length || !nameOK || !priced.spec) return;
    const spec = priced.spec;
    if (!me) makeAccount();
    const button = $("#launch");
    button.disabled = true; launchInFlight = true; lastError = null;
    try {
      // Short of Hearth coin: buy it first (Buy coin's own purchase, shown here). Whatever happens
      // after, the coin bought stays in this browser's account.
      await loadBalances();
      if (!balances.market || !balances.parent) throw new Error(`Could not read your balance from ${cfg.node}. Try again.`);
      const need = cost + marketFee;
      const missing = need - balances.market.balance;
      if (missing > 0n) {
        await readSales();
        const deal = dealFor(missing);
        if (!deal) throw new Error(`Nobody is selling ${fmt(missing)} ${coinName} right now.`);
        button.textContent = "Buying coin…";
        await buy(deal);
        if (buying?.step !== "done") throw new Error(buying?.error ?? "Buying coin did not finish.");
        buying = null; store.set("buying", null);
        // Left this page while buying: the coin stays in the account, and nothing is paid.
        if (!current()) { launchInFlight = false; refreshYou?.(); return; }
        $("#pending").innerHTML = "";
        await loadBalances();
        if ((balances.market?.balance ?? 0n) < need) throw new Error(`You hold ${fmt(balances.market?.balance ?? 0n)} ${coinName} after buying, and this takes ${fmt(need)}. Launch again to buy the rest.`);
      }
      // The name: not already a chain under the parent, nor paid for by someone else.
      button.textContent = "Checking the name…";
      const parent = await readerOf(now.parent);
      if (await parent.hasChild(now.parent, now.name)) throw new Error(`${path} is already a chain; pick another name.`);
      const fresh = await loadMarket(true);
      if (owedNow(fresh).some((o) => o.path === path && o.payer !== me.address)) throw new Error(`Someone else has paid hosts for ${path}; pick another name.`);
      heldCheck({ chosen: offers, orders: fresh.orders, verdicts, path, name: hostName });
      // The genesis, on the parent's state now.
      button.textContent = "Making your chain…";
      const { buildChildGenesis } = await genesisBuilder();
      const tip = await parent.tip(now.parent);
      const { value } = mintGenesis(buildChildGenesis, { spec, path, premineTo: me.address, modules: mods, parentStateCID: tip.block.postStateCID });
      button.textContent = offers.length > 1 ? "Paying the hosts…" : "Paying the host…";
      // Each offer exactly as the buyer was shown it (`m`, this page's read), and as it stands now.
      const picked = chosenTerms({ offers, shown: m.offers, now: fresh.offers, name: hostName });
      let keys;
      // One transaction pays every host (app/launch.mjs).
      await send(async () => {
        const launched = await launchAttempt({ reader: r, market: cfg.market, chosen: picked, payer: me.address, path, value, periods, chainPath: marketPath, fee: () => fee(cfg.market), name: hostName });
        keys = launched.keys;
        return launched.body;
      });
      const mine = store.get("orders", []);
      store.set("orders", [...mine.filter((k) => !keys.includes(k)), ...keys]);
      store.set("draft", { ...store.get("draft", {}), name: "" });
      launchInFlight = false;
      location.hash = `#/order/${encodeURIComponent(keys[0])}`;
    } catch (e) {
      launchInFlight = false;
      if (!current()) { refreshYou?.(); return; }
      lastError = e.message; refresh();
    }
  };
}

/** Per host: chains it was paid for (owed), those still paid for (active), void orders, and the coin paid. */
function statsByHost() {
  const stats = new Map();
  for (const o of market.orders) {
    const v = verdicts.get(o.key);
    const s = stats.get(o.host) ?? { owed: 0, active: 0, void: 0, paid: 0n };
    if (v?.kind === "owed") { s.owed++; if (v.active) s.active++; }
    if (v?.kind === "void") s.void++;
    s.paid += o.paid;
    stats.set(o.host, s);
  }
  return stats;
}
function recordLine(s) {
  if (!s || !s.owed) return `<span class="muted">No orders yet</span>`;
  return `${s.owed} sold · ${s.active} hosted now`;
}

// ---- Buy coin: the main way to get coin ----
let buying = null;
async function viewCoin(view, _, current) {
  const need = BigInt(new URLSearchParams(location.hash.split("?")[1] ?? "").get("need") ?? 0);
  view.innerHTML = `
  <section>
    <h1>Buy ${coinName}</h1>
    <p class="lead">Hosts are paid in ${coinName}. You buy it with ${esc(parentCoin)}, and the chains check both sides of the trade: nobody holds your payment in between. Launching an app buys what it needs for you.</p>
  </section>
  <section class="stack" id="you"></section>
  <section class="stack"><div class="row"><h2>For sale</h2><span class="spacer"></span><button class="btn small" id="reload">Refresh</button></div><div id="deposits"><p class="muted">Reading the market…</p></div></section>
  <section class="stack" id="pending"></section>
  <section class="stack">
    <details id="earn"><summary>Need ${esc(parentCoin)}?</summary>
      <div class="stack" style="margin-top:12px">
        <p class="muted">Anyone holding ${esc(parentCoin)} can send it to your address.${cfg.sponsor ? ` You can also earn it with this device: it does work for the fee sponsor, which pays your address each time your earnings reach its payout. It keeps a few cores busy until you press Stop or close this page.` : ""} <a href="${DOCS}">More in the docs</a>.</p>
        ${cfg.sponsor ? `<div class="row"><button class="btn" id="grind">Earn with this device</button><span class="muted small" id="grindStatus"></span></div>` : ""}
      </div>
    </details>
    <details><summary>Sell ${coinName}</summary>
      <div class="stack" style="margin-top:12px">
        <p class="muted">Lock ${coinName} for a price in ${esc(parentCoin)}. It stays locked until someone pays; there is no cancel.</p>
        <div class="fields"><div><label for="sellAmount">${coinName} to sell</label><input id="sellAmount" type="number" min="1" step="1"></div><div><label for="sellPrice">for ${esc(parentCoin)}</label><input id="sellPrice" type="number" min="1" step="1"></div></div>
        <div class="row"><button class="btn" id="sell">Lock for sale</button><span class="small" id="sellNote"></span></div>
      </div>
    </details>
  </section>`;
  const you = () => {
    if (!$("#you")) return;   // a balance read landing after the page changed
    $("#you").innerHTML = me
      ? `<div class="grid"><div class="card soft"><p class="muted small">${coinName}</p><p class="stat">${balances.market ? fmt(balances.market.balance) : "…"}</p></div>
         <div class="card soft"><p class="muted small">${esc(parentCoin)} to pay with</p><p class="stat">${balances.parent ? fmt(balances.parent.balance) : "…"}</p></div>
         <div class="card soft"><p class="muted small">Your address</p><p class="mono" style="margin-top:6px">${esc(me.address)}</p></div></div>
         ${need > 0n ? `<div class="notice info">You need ${fmt(need)} more ${coinName} to launch your chain.</div>` : ""}`
      : `<div class="notice info">Buying makes an account in this browser. Its key stays here; you can download it from <a href="#/wallet">your account</a>. <button class="btn small primary" id="make">Make an account</button></div>`;
    $("#make")?.addEventListener("click", () => { makeAccount(); loadBalances().then(you); you(); });
  };
  you();
  const list = async () => {
    const deposits = (await r.deposits(cfg.market)).filter((d) => d.amountDeposited > 0n);
    deposits.sort((a, b) => (a.amountDemanded * b.amountDeposited < b.amountDemanded * a.amountDeposited ? -1 : 1));
    if (!current()) return;
    $("#deposits").innerHTML = deposits.length === 0
      ? `<div class="empty">Nobody is selling right now. Check back, or ask a host: hosts are paid in ${coinName} and sell it on.</div>`
      : `<div class="table-scroll"><table><thead><tr><th class="num">${coinName}</th><th class="num">Price</th><th class="num">Each</th><th>Seller</th><th></th></tr></thead><tbody>${deposits.map((d, i) => {
          const each = Number(d.amountDemanded) / Number(d.amountDeposited);
          const afford = balances.parent && balances.parent.balance >= d.amountDemanded + 1n;
          return `<tr><td class="num"><b>${fmt(d.amountDeposited)}</b></td><td class="num">${fmt(d.amountDemanded)} <span class="muted small">${esc(parentCoin)}</span></td><td class="num small">${each.toPrecision(3)}</td>
            <td class="mono">${esc(short(d.demander))}${me && d.demander === me.address ? ` <span class="pill">yours</span>` : ""}</td>
            <td style="text-align:right"><button class="btn small ${need > 0n && d.amountDeposited >= need ? "primary" : ""}" data-buy="${i}" ${(me && !afford) || buying ? "disabled" : ""} title="${me && !afford ? `You need ${fmt(d.amountDemanded + 1n)} ${esc(parentCoin)}` : ""}">Buy</button></td></tr>`;
        }).join("")}</tbody></table></div>`;
    for (const b of document.querySelectorAll("[data-buy]")) b.onclick = () => buy(deposits[Number(b.dataset.buy)]);
  };
  $("#reload").onclick = () => list().catch(() => {});
  await list();
  if (me) loadBalances().then(() => { if (current()) { you(); list().catch(() => {}); } });
  showPending();

  // Earning with this device's cores (`startEarning`), where a sponsor pays out.
  refreshYou = () => { if (current()) { you(); list().catch(() => {}); } };
  showEarning();
  if ($("#grind")) $("#grind").onclick = () => {
    if (earning) { earning.stop(); return; }
    if (!me) { makeAccount(); you(); }
    startEarning();
  };

  $("#sell").onclick = async () => {
    const amount = BigInt(Math.floor(Number($("#sellAmount").value) || 0)), price = BigInt(Math.floor(Number($("#sellPrice").value) || 0));
    const note = $("#sellNote");
    if (!me || amount <= 0n || price <= 0n) { note.textContent = "Enter both amounts."; return; }
    if ((balances.market?.balance ?? 0n) < amount + 1n) { note.textContent = `You have ${fmt(balances.market?.balance ?? 0n)} ${coinName}.`; return; }
    note.textContent = "Locking…";
    try {
      await send(async () => {
        const { nonce } = await r.account(cfg.market, me.address);
        return depositBody({ seller: me.address, nonce, chainPath: marketPath, depositNonce: BigInt(Date.now()), amountDemanded: price, amountDeposited: amount, fee: await fee(cfg.market) });
      });
      note.textContent = "Locked. It shows here once it is in a block.";
      setTimeout(() => list().catch(() => {}), 8000);
    } catch (e) { note.textContent = e.message; }
  };
}

// ---- Earning the parent's coin with this device, through a sponsor ----
//
// The fee sponsor pays an address once the work done for it reaches its
// payout. The page asks for work and hands back shares itself, one request at
// a time, and splits each piece of work across the cores (grind-worker.mjs).
// A sponsor limits how often one browser may ask, and its refusal, sent
// without CORS headers, reads here as a failed fetch: so after any failure one
// gate holds every request, shares included, until it opens again, longer
// each time. A share the sponsor no longer knows (its work was replaced by
// newer work, or expired) only means fetching new work.

/** The one gate on requests to the sponsor, kept across Stop and Start. */
const gate = { line: Promise.resolve(), openAt: 0, delay: 2000 };
let earning = null, earnEnded = "", refreshYou = null;
function showEarning() {
  const button = $("#grind"), status = $("#grindStatus");
  if (!button) return;
  button.textContent = earning ? "Stop" : "Earn with this device";
  status.textContent = earning ? [earning.progress, earning.note].filter(Boolean).join(" ") : earnEnded;
}
function startEarning() {
  const cores = Math.max(1, Math.min(8, (navigator.hardwareConcurrency ?? 2) - 1));
  const workers = Array.from({ length: cores }, () => new Worker(new URL("./grind-worker.mjs", import.meta.url), { type: "module" }));
  const abort = new AbortController();
  const stopped = new Promise((ok) => abort.signal.addEventListener("abort", ok));
  // The account earned for: fixed at Start, so forgetting or replacing the key stops earning, not the code below.
  const address = me.address;
  const e = earning = { progress: `Earning on ${cores} of this device's cores.`, note: "Fetching work…", wake: () => {} };
  earnEnded = "";
  const say = (note) => { if (!abort.signal.aborted) { e.note = note; showEarning(); } };
  e.stop = (why = "") => {
    if (abort.signal.aborted) return;
    abort.abort();
    for (const w of workers) w.terminate();
    clearInterval(timer);
    e.wake();
    earning = null; earnEnded = why;
    showEarning();
  };

  /** One request, after every one before it and once the gate is open: its JSON, or `{ refusal }`; `{ stopped }` after Stop or once `live()` turns false. */
  const call = (path, body, live = () => true) => {
    const run = gate.line.then(async () => {
      for (;;) {
        if (abort.signal.aborted || !live()) throw { stopped: true };
        const wait = gate.openAt - Date.now();
        if (wait > 0) {
          say(`The sponsor is busy; trying again in ${Math.ceil(wait / 1000)} s.`);
          await Promise.race([sleep(wait), stopped]);
          continue;
        }
        let res;
        try {
          res = await fetch(`${cfg.sponsor}/${path}`, body === undefined ? { cache: "no-store", signal: abort.signal } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: abort.signal });
        } catch { if (abort.signal.aborted) throw { stopped: true }; busy(); continue; }
        const text = await res.text().catch(() => "");
        let json;
        try { json = JSON.parse(text); } catch {}
        if (res.status === 429 || res.status >= 500 || json === undefined) { busy(1000 * Number(res.headers.get("Retry-After") ?? 0)); continue; }
        gate.delay = 2000;
        if (e.note.startsWith("The sponsor is busy")) say("");
        if (!res.ok) throw { refusal: json?.error?.message ?? `HTTP ${res.status}` };
        return json;
      }
    });
    gate.line = run.catch(() => {});
    return run;
  };
  const busy = (ms) => {
    gate.openAt = Date.now() + (ms || gate.delay);
    gate.delay = Math.min(gate.delay * 2, 60_000);
  };

  // Progress from the sponsor's own book, and the time left from how fast it grows.
  let since = null;
  const poll = async () => {
    let book;
    try { book = await call(`earnings?chain=${encodeURIComponent(parentPath)}&address=${address}`); } catch { return; }
    const earned = Number(book.earned), payoutAt = Number(book.payoutAt), now = Date.now();
    if (since && earned < since.earned) loadBalances().then(() => refreshYou?.());  // a payout landed
    if (!since || earned < since.earned) since = { at: now, earned };
    const perMs = (earned - since.earned) / Math.max(1, now - since.at);
    const left = perMs > 0 ? (payoutAt - earned) / perMs / 60_000 : undefined;
    e.progress = `Earning on ${cores} cores: ${earned} of ${payoutAt} ${parentCoin} for your next payout`
      + (book.paying ? ", paying it to you now."
        : earned >= payoutAt ? ". The sponsor has no coin to pay with right now; your earnings wait in its book and are paid when it has."
        : left === undefined ? ", working out how long that takes…" : left < 1 ? ", under a minute left." : `, about ${Math.ceil(left)} min left.`);
    showEarning();
  };
  const timer = setInterval(poll, 15_000);
  poll();

  (async () => {
    let soldOut = 0;
    for (let round = 1; !abort.signal.aborted; round++) {
      say("Fetching work…");
      let work;
      try { work = await call("work", { chain: parentPath, payTo: address }); } catch (err) {
        if (err.stopped) return;
        if (err.refusal === "soldOut") {
          if (++soldOut >= 3) { e.stop("Stopped: the sponsor has no payouts left to earn right now (soldOut). Try again later."); return; }
          say(`The sponsor has no payouts left to earn right now (soldOut); asking again in a minute.`);
          await Promise.race([sleep(60_000), stopped]);
        } else {
          say(`The sponsor isn't giving out work right now (${err.refusal}); asking again in 30 s.`);
          await Promise.race([sleep(30_000), stopped]);
        }
        continue;
      }
      soldOut = 0;
      const count = BigInt(work.count), each = count / BigInt(cores), start = BigInt(work.startNonce);
      const expiresAt = Date.now() + Number(work.expiresInMilliseconds ?? 60_000);
      let wake, over = false;
      const finished = new Promise((ok) => { wake = e.wake = ok; });
      let working = cores;
      // A refused share (unknownAssignment, expired, soldOut) ends this work;
      // shares still queued when it ends are dropped, not sent.
      const share = (nonce) => call("shares", { assignment: work.assignment, nonce }, () => !over).catch((err) => { if (err.refusal) wake(); });
      workers.forEach((w, i) => {
        w.onmessage = ({ data }) => {
          if (data.id !== round) return;
          if (data.nonce) share(data.nonce);
          if ((data.done || data.error) && --working === 0) wake();
        };
        w.postMessage({ id: round, prefixHex: work.prefixHex, shareTarget: work.shareTarget, startNonce: String(start + each * BigInt(i)), count: String(i === cores - 1 ? count - each * BigInt(i) : each), expiresAt });
      });
      say("");
      await finished;
      over = true;
      for (const w of workers) w.postMessage("stop");
    }
  })();
}

/** A purchase, resumed after a reload: pay on the parent, wait for the receipt, take the coin. */
async function buy(deposit) {
  if (!me) makeAccount();
  buying = { deposit, step: "pay", started: Date.now() };
  store.set("buying", buying);
  showPending();
  await runPurchase();
}
async function runPurchase() {
  const p = buying;
  const d = p.deposit;
  const status = (msg) => { p.message = msg; store.set("buying", p); showPending(); };
  try {
    if (p.step === "pay") {
      status("Paying the seller…");
      await send(async () => {
        const { nonce } = await r.account(parentPath, me.address);
        // Kept, so the same payment can be sent again if a node drops it.
        p.pay = { nonce: String(nonce), fee: String(await fee(parentPath)) };
        return receiptBody({ buyer: me.address, nonce, parentPath: parentPath.split("/"), directory, deposit: d, fee: BigInt(p.pay.fee) });
      });
      p.sentAt = Date.now();
      p.step = "receipt"; status("Waiting for your payment to be in a block…");
    }
    if (p.step === "receipt") {
      for (;;) {
        const who = await r.receipt(parentPath, directory, d).catch(() => undefined);
        if (who === me.address) break;
        if (who) throw new Error("Someone else paid for this sale first. Your coin was not spent unless your payment landed; check your balance.");
        // Not in a block after two minutes and its nonce still unused: a node
        // may have dropped it from its pool, so send the same payment again
        // (same nonce, so it can only land once).
        if (p.pay && Date.now() - (p.sentAt ?? 0) > 120_000) {
          const { nonce } = await r.account(parentPath, me.address).catch(() => ({ nonce: -1n }));
          if (nonce >= 0n && nonce <= BigInt(p.pay.nonce)) {
            const body = receiptBody({ buyer: me.address, nonce: BigInt(p.pay.nonce), parentPath: parentPath.split("/"), directory, deposit: d, fee: BigInt(p.pay.fee) });
            await submit(sdk, cfg.node, body, me.privateKey).catch(() => {});
            status("Still waiting for a block; sent your payment again.");
          }
          p.sentAt = Date.now(); store.set("buying", p);
        }
        await sleep(5000);
      }
      p.step = "take"; status("Taking your coin on the market chain…");
    }
    if (p.step === "take") {
      await send(async () => {
        const { nonce } = await r.account(cfg.market, me.address);
        return withdrawalBody({ buyer: me.address, nonce, chainPath: marketPath, deposit: d, fee: await fee(cfg.market) });
      }, { tries: 200, onRetry: () => status("Waiting for the market chain to see your payment…") });
      p.step = "landing"; status("Waiting for your coin to land…");
    }
    if (p.step === "landing") {
      for (;;) { const left = await r.deposit(cfg.market, d).catch(() => undefined); if (left === 0n) break; await sleep(5000); }
      p.step = "done";
      await loadBalances();
      status(`Bought ${fmt(d.amountDeposited - await fee(cfg.market))} ${coinName}.`);
      refreshYou?.();
      if (location.hash.startsWith("#/coin")) route();
    }
  } catch (e) {
    p.error = e.message; store.set("buying", p); showPending();
  }
}
function showPending() {
  const el = $("#pending");
  if (!el || !buying) return;
  const order = ["pay", "receipt", "take", "landing", "done"];
  const at = order.indexOf(buying.step);
  const step = (i, label) => `<li class="${i < at || buying.step === "done" ? "done" : i === at ? (buying.error ? "failed" : "now") : ""}"><span class="dot">${i < at || buying.step === "done" ? "✓" : ""}</span><span>${label}</span></li>`;
  const d = buying.deposit;
  el.innerHTML = `<h2>Your purchase</h2><div class="card"><p><b>${fmt(d.amountDeposited)} ${coinName}</b> for ${fmt(d.amountDemanded)} ${esc(parentCoin)}</p>
    <ol class="steps">${step(0, `Pay the seller on ${esc(parentPath)}`)}${step(1, "Your payment is in a block")}${step(2, "Take the coin on the market chain")}${step(3, "Your coin lands")}</ol>
    <p class="small ${buying.error ? "" : "muted"}" style="${buying.error ? "color:var(--bad)" : ""}">${esc(buying.error ?? buying.message ?? "")}</p>
    ${buying.step === "done" || buying.error ? `<div class="row" style="margin-top:10px">${buying.step === "done" ? `<a class="btn primary small" href="#/">Launch an app</a>` : `<button class="btn small" id="retryBuy">Try again</button>`}<button class="btn small" id="clearBuy">Dismiss</button></div>` : ""}</div>`;
  $("#clearBuy")?.addEventListener("click", () => { buying = null; store.set("buying", null); el.innerHTML = ""; route(); });
  $("#retryBuy")?.addEventListener("click", () => { delete buying.error; runPurchase(); });
}


// ---- Hosts ----
async function viewHosts(view, _, current) {
  const m = await loadMarket();
  const stats = statsByHost();
  // Priced for the chain the Launch page is set to (its rules do not change the price).
  const d = draft();
  const s = draftSpec(d, {});
  const priced = { offers: s.error ? [] : offersFor({ terms: m.terms, parent: d.parent, spec: s.spec }) };
  if (!current()) return;
  const hosts = [...new Set(priced.offers.map((x) => x.host)), ...[...m.terms.keys()].map((k) => k.split("/")[0])].filter((h, i, a) => a.indexOf(h) === i);
  view.innerHTML = `
  <section><h1>Hosts</h1>
    <p class="lead">What each host charges for your chain, the hash rate it claims, and the hash rate its blocks show.</p>
    <p class="small muted">For the chain set on <a href="#/">Launch</a>: ${s.error ? esc(s.error) : `${fmt(s.spec.maxBlockSize / 1000)} kB blocks every ${s.spec.targetBlockTime / 1000} s, ${fmt(s.spec.maxStateGrowth / 1000)} kB of new state a block, under ${esc(d.parent)}`}. Offers that take it first, cheapest per market block; a dash marks one that does not.</p></section>
  <section class="stack">${hosts.length === 0 ? `<div class="empty">No host has made an offer yet.</div>` : hosts.map((h) => {
    const st = stats.get(h);
    const offers = [...m.terms].filter(([k]) => k.startsWith(`${h}/`)).map(([k, offer]) => priced.offers.find((x) => x.k === k) ?? { k, host: h, id: k.split("/")[1], offer });
    return `<div class="card stack" data-host="${esc(h)}">
      <div><h3 class="mono">${esc(hostName(h))}</h3><p class="mono muted small">${esc(h)}</p></div>
      <div class="grid">
        <div><p class="muted small">Chains sold</p><p class="stat">${st?.owed ?? 0}</p><p class="small muted">${st ? `${st.active} hosted now` : "No orders yet"}</p></div>
        <div><p class="muted small">Void orders</p><p class="stat">${st?.void ?? 0}</p><p class="small muted">The buyer's order did not hold up</p></div>
        <div><p class="muted small">Burned for it</p><p class="small" data-burns>…</p></div>
      </div>
      <div class="table-scroll"><table><thead><tr><th>Offer</th><th class="num">Your chain</th><th>Takes</th><th>Hash rate</th><th>Blocks pay</th></tr></thead><tbody>${offers.map((x) => `<tr data-offer="${esc(x.k)}"><td class="mono">${esc(x.id)}</td>
        <td class="num">${x.price === undefined ? "—" : `<b>${fmt(x.price)}</b>`} <span class="muted small">per ${duration(x.offer.period)}</span></td>
        <td class="small">chains of up to ${fmt(x.offer.throughput)} bytes/s of blocks and ${fmt(x.offer.storage)} bytes of state growth a block<br><span class="muted">under ${x.offer.under.map(esc).join(", ")}</span></td>
        <td class="small">claims ${formatRate(x.offer.hashrate)}<br><span data-delivered>delivered: …</span></td>
        <td class="mono small">${esc(short(x.offer.blocks))}</td></tr>`).join("")}</tbody></table></div>
    </div>`;
  }).join("")}</section>
  <section class="card soft small">
    <details><summary><b>How hosts are judged, and what this can't show</b></summary><div class="stack" style="margin-top:12px">
    <p>An offer sets one price a period for a chain, the largest block rate (block size over block time) and state growth a block it takes, and the parent chains it sells under: a host runs each of them, and you can order a chain directly under one. You pay for your chain alone. An order asserts the offer unchanged, so it pays exactly the terms you saw; the market refuses one under another parent, or paying less than the price.</p>
    <p>An order is judged as soon as it is in a block: owed from that block until its paid time runs out, or void (its genesis did not check out, or its block rate or state growth is above the offer's). A host can raise its count by buying its own chains.</p>
    <p>“Claims” is the host's own word: the hash rate it mines every chain it hosts with. “Delivered” reads, by CID, up to a day of blocks (at most 200) of up to three chains the host is paid to host now, from a node serving each chain's genesis, and shows the lowest hash rate credited to the offer's block address. A host that mines less than it claims shows here; don't renew with it.</p>
    <p>“Burned” is coin sent, by anyone, to an address nobody can spend from, named for the host, on each chain from Nexus down to the market. Each chain's coin is its own, so they are never added up. A burn costs whoever made it; it says nothing about how a host serves.</p>
    </div></details>
  </section>`;
  // Each host's burns, chain by chain along the market's path, never summed.
  const chains = pathFromNexus(cfg.market);
  for (const h of hosts) {
    const el = view.querySelector(`[data-host="${h}"] [data-burns]`);
    Promise.all(chains.map((p) => r.account(p, burnAddress(sdk, h)).then((a) => a.balance, () => undefined))).then((burned) => {
      if (!current()) return;
      const parts = chains.map((p, i) => burned[i] === undefined ? "" : `${fmt(burned[i])} ${p === cfg.market ? "market" : p}`).filter(Boolean);
      el.textContent = parts.join(" · ") || "nothing it can read";
    });
  }
  // What each offer's block address is credited with on the chains its host is paid to host.
  for (const h of hosts) for (const [k, offer] of [...m.terms].filter(([k]) => k.startsWith(`${h}/`))) {
    delivered(m, h, offer).then((dl) => {
      const el = view.querySelector(`[data-offer="${CSS.escape(k)}"] [data-delivered]`);
      if (el && current()) el.textContent = `delivered: ${deliveredText(dl)}`;
    });
  }
}

// ---- Your chains ----
async function viewOrders(view) {
  const m = await loadMarket(true);
  const local = new Set(store.get("orders", []));
  const mine = launches(m).filter((o) => (me && o.payer === me.address) || local.has(o.key));
  const waiting = [...local].filter((k) => !m.orders.some((o) => o.key === k));
  view.innerHTML = `<section><h1>Your apps</h1><p class="lead">Apps you paid hosts to run, from this browser's account.</p></section>
  <section>${mine.length + waiting.length === 0 ? `<div class="empty">None yet. <a href="#/">Launch an app</a>.</div>` : `<div class="table-scroll"><table><thead><tr><th>App</th><th>Host</th><th>Verdict</th><th>Paid until</th></tr></thead><tbody>
    ${waiting.map((k) => `<tr><td><a href="#/order/${encodeURIComponent(k)}" class="mono">${esc(parseOrderKey(k)?.path ?? k)}</a></td><td></td><td><span class="pill info">Paying</span></td><td></td></tr>`).join("")}
    ${mine.map((o) => { const v = verdicts.get(o.key); return `<tr><td><a href="#/order/${encodeURIComponent(o.key)}" class="mono">${esc(o.path)}</a></td><td class="mono">${esc(hostName(o.host))}</td><td>${pill(v)}</td><td class="small">${v?.kind === "owed" ? (v.active ? `in ${duration(v.until - m.height)}` : "ended") : ""}</td></tr>`; }).join("")}
  </tbody></table></div>`}</section>`;
}
const pill = (v) => ({
  owed: v?.active ? `<span class="pill ok">Owed</span>` : `<span class="pill">Ended</span>`,
  void: `<span class="pill bad">Void</span>`,
})[v?.kind] ?? `<span class="pill">Unknown</span>`;

async function viewOrder(view, key, current) {
  const m = await loadMarket(true);
  const o = m.orders.find((x) => x.key === key);
  if (!current()) return;
  const path = parseOrderKey(key)?.path ?? key;
  if (!o) {
    view.innerHTML = `<section class="stack"><h1 class="mono">${esc(path)}</h1><div class="notice info">Your payment is on its way into a block. This page updates by itself.</div></section>`;
    setTimeout(() => current() && route(), 8000);
    return;
  }
  const v = verdicts.get(o.key);
  const header = `<section class="stack"><p><a href="#/orders">← Your apps</a></p><div class="row"><h1 class="mono" style="font-size:22px">${esc(o.path)}</h1>${pill(v)}</div>
    <p class="muted small">Ordered from <span class="mono">${esc(hostName(o.host))}</span>, offer <span class="mono">${esc(o.id)}</span>: ${fmt(o.paid)} ${coinName} paid, in market block ${fmt(o.landed)}.</p></section>`;
  if (v?.kind !== "owed") {
    view.innerHTML = `${header}${v?.kind === "void" ? `<div class="notice bad"><b>Void:</b> ${esc(v.reason)}. The host does not owe this chain, and the payment is not refunded.</div>`
      : `<div class="notice info">Not judged yet: ${esc(v?.reason ?? "the market is still being read")}. This page updates by itself.</div>`}`;
    if (v?.kind !== "void") setTimeout(() => current() && route(), 15000);
    return;
  }
  const genesis = v.genesis, spec = o.genesis.spec;
  view.innerHTML = `${header}
  <section class="card stack"><div class="grid">
    <div><p class="muted small">Owed</p><p class="stat" style="font-size:20px">market blocks ${fmt(v.from)} to ${fmt(v.until)}</p><p class="small muted">${v.active ? `ends in ${duration(v.until - m.height)}` : "ended"} (the market is at ${fmt(m.height)})</p></div>
    <div><p class="muted small">Genesis</p><p class="mono small" style="word-break:break-all">${esc(genesis)}</p></div>
  </div></section>
  <section class="card stack" id="use"><h2>Use it</h2><p class="muted">Looking for nodes serving this chain…</p></section>
  <section class="stack" id="keep"></section>`;

  // The hosts this browser ordered this chain from, each owed now, for the same genesis.
  const local = new Set(store.get("orders", []));
  const hosting = launches(m).filter((x) => x.path === o.path && (local.has(x.key) || (me && x.payer === me.address))
    && verdicts.get(x.key)?.kind === "owed" && verdicts.get(x.key).active && verdicts.get(x.key).genesis === genesis);

  // Keep it running: renew at the offer's terms now.
  const k = `${o.host}/${o.id}`, termsNow = m.offers.get(k), offerNow = m.terms.get(k);
  // A renewal pays for the genesis holding the path at this host: only this order's, while it does,
  // at an offer that still sells under its parent and takes its spec.
  const holds = holderOf({ orders: m.orders, verdicts, host: o.host, path: o.path }) === genesis;
  const fits = offerNow && sellsUnder(offerNow, o.path) && !overLimits(offerNow, spec);
  const price = holds && fits ? offerNow.price : undefined;
  $("#keep").innerHTML = `<h2>Keep it running</h2><p class="muted">When paid time ends, this host may stop hosting the chain; anyone still hosting it keeps it. ${!holds ? `Another chain now holds ${esc(o.path)} at this host, so it sells no more time for this one.` : price !== undefined ? `Anyone can pay for more time: each period is ${duration(offerNow.period)} for ${fmt(price)} ${coinName}, at this offer's terms now.` : offerNow ? "This offer no longer sells under this chain's parent or no longer takes its size, so it sells no more time here." : "This offer is closed, so it sells no more time here."}</p>
    ${price !== undefined ? `<div class="row"><div style="width:120px"><input id="more" type="number" min="1" value="7" aria-label="Periods"></div><button class="btn primary" id="renew">Pay for more</button><span class="small" id="renewNote"></span></div>` : ""}`;
  $("#renew")?.addEventListener("click", async () => {
    const periods = BigInt(Math.max(1, Math.floor(Number($("#more").value) || 1)));
    if (!me) { $("#renewNote").textContent = "Make an account and buy coin first."; return; }
    $("#renewNote").textContent = "Paying…";
    try {
      await send(async () => {
        const { nonce } = await r.account(cfg.market, me.address);
        const fresh = await r.market(cfg.market);
        const text = fresh.offers.get(k);
        if (text === undefined) throw new Error("This offer has closed: it sells no more time.");
        if (text !== termsNow) throw new Error("The offer's terms changed. Reload to pay at them.");
        const w = renewWrite({ host: o.host, id: o.id, terms: text, payer: me.address, n: nonce, path: o.path, genesis, periods });
        return recordsBody({ signer: me.address, nonce, chainPath: marketPath, actions: w.actions, payments: w.payments, fee: await fee(cfg.market) });
      });
      $("#renewNote").textContent = "Paid. It counts once it is in a block.";
    } catch (e) { $("#renewNote").textContent = e.message; }
  });

  // Use it: the nodes serving this genesis, found through the entry's network.
  const nodes = await nodesFor(o.path, genesis).catch(() => []);
  if (!current()) return;
  if (!nodes.length) {
    $("#use").innerHTML = `<h2>Use it</h2><p class="muted">No node serves this chain yet: the host starts it from the genesis your order carries. This page checks again by itself.</p>`;
    setTimeout(() => current() && route(), 15000);
    return;
  }
  await rulesReady.catch(() => {});
  const now = await nodesNow(nodes, o.path);
  const anchor = await chooseAnchor({ now, chain: o.path, genesis });
  if (!current()) return;
  const policies = spec.wasmPolicies ?? [];
  const rulesKnown = policies.length === 0 || RULES.own.cid !== undefined;
  const ownKeys = policies.some((p) => p.moduleCID === RULES.own.cid);
  const top = now.filter((x) => x.error === undefined).reduce((a, x) => (x.height > a ? x.height : a), 0n);
  const blockTime = spec.targetBlockTime ?? 60_000;
  const pinNote = anchor.checkpoint !== undefined
    ? `Pins block ${fmt(anchor.height)}; refresh it when you redeploy, about every ${fmt(WALK)} blocks (${blocksTime(WALK, blockTime)} at this chain's block time).`
    : `Pins the chain's genesis; once the chain is past ${fmt(CHECKPOINT_AFTER)} blocks (${blocksTime(Number(CHECKPOINT_AFTER), blockTime)} at this chain's block time), copy it again to pin a recent block.`;
  // No sponsors: a sponsor is a service of its own, not part of an offer. Writes pay fees from the writing key.
  const use = { sdkURL: SDK_URL, chain: o.path, anchor, nodes, ownKeys };
  $("#use").innerHTML = `<h2>Use it</h2>
    <div class="grid"><div><p class="muted small">Served by</p><p class="mono small">${nodes.map(esc).join("<br>")}</p></div>
    <div><p class="muted small">Height</p><p class="stat">${fmt(top)}</p></div>
    <div><p class="muted small">You ordered it from</p><p class="mono small">${hosting.map((x) => esc(hostName(x.host))).join("<br>") || "No host, from this browser"}</p></div></div>
    <p class="small" id="making">${hosting.map((x) => `<span data-making="${esc(x.key)}"></span>`).join("<br>")}</p>
    ${!rulesKnown ? `<div class="notice bad">The rule presets did not load, so this page can't tell which keys this chain lets you write. <a href="" onclick="location.reload();return false">Reload</a> to try again.</div>`
    : `<p class="muted">Paste this into any web page. It writes one key and reads it back, checking what it reads against a pinned block. ${pinNote} ${nodes.length > 1 ? "It reads a block only once two of these nodes hold it." : "Only one node serves the chain, so reads trust it: it could serve a made-up block."} Writes pay their fee in this chain's coin from the writing key (your premine is yours); a fee sponsor, a separate service, can pay instead: add its URL as <span class="mono">sponsors</span>.</p>
     <pre class="mono card soft" style="white-space:pre-wrap;margin:0" id="snippet">${esc(snippet(use))}</pre>
     <div class="row"><button class="btn small" id="copy">Copy</button><button class="btn small" id="tryWrite">Test write</button><span class="small" id="tryNote"></span></div>`}`;
  // The hash rate each of your hosts' block address is credited with on this chain, against its claim.
  for (const x of hosting) {
    const t = parseOffer(x.terms);
    if (!t) continue;
    creditedOn(o.path, genesis, t.blocks).catch((e) => ({ reason: `its blocks could not be read (${e.message})` })).then((c) => {
      const el = document.querySelector(`[data-making="${CSS.escape(x.key)}"]`);
      if (el && current()) el.textContent = `${hostName(x.host)}: ${c.rate === undefined ? c.reason : `${formatRate(c.rate)} credited over the last day`}, of ${formatRate(t.hashrate)} claimed.`;
    });
  }
  $("#copy")?.addEventListener("click", () => navigator.clipboard?.writeText($("#snippet").textContent).then(() => { $("#tryNote").textContent = "Copied."; }, () => {}));
  $("#tryWrite")?.addEventListener("click", async () => {
    const note = $("#tryNote");
    note.style.color = "";
    note.textContent = "Loading the SDK…";
    try {
      // The vendored copy the snippet's URL serves once tagged: no remote code beside your key.
      const { connect } = await import("../vendor/lattice-browser.js");
      const before = use.nodes.length > 1 ? await nodesNow(use.nodes, use.chain) : [];
      note.textContent = "Writing…";
      try {
        // Your key: it holds the chain's premine, which pays the fee.
        const db = await connect({ chain: use.chain, genesis: use.anchor.genesis, checkpoint: use.anchor.checkpoint, node: use.nodes, key: me?.privateKey });
        const key = ownKeys ? `hello/${db.address}` : `hello/${Date.now()}`;
        await db.set(key, "Test write from Hearth");
        note.textContent = `Wrote ${key} and read back: ${await db.get(key)}`;
      } catch (e) {
        if (e.code === "disagree" && before.length) throw new Error(disagreeMessage(before));
        throw e;
      }
    } catch (e) {
      note.style.color = "var(--bad)";
      note.textContent = /insufficient/i.test(e.message)
        ? "The test write failed: this browser's key holds no coin on this chain to pay the fee. Launch with a premine, or add a sponsor."
        : `The test write failed: ${e.message}`;
    }
  });
}

// ---- Account ----
async function viewWallet(view) {
  view.innerHTML = `<section><h1>Your account</h1><p class="lead">A key kept in this browser. It holds your ${coinName} and signs your orders. Download it to keep it: anyone with the file can spend from it.</p></section>
  <section class="stack">${me ? `<div class="card stack"><div><p class="muted small">Address</p><p class="mono">${esc(me.address)}</p></div>
    <div class="row"><button class="btn" id="download">Download key file</button><button class="btn" id="forget">Forget it here</button></div></div>` : `<div class="empty">No account in this browser yet.</div>`}
    <div class="card stack"><h3>Use a key file</h3><p class="muted small">A file from <span class="mono">lattice key generate</span>, or one downloaded here.</p><input type="file" id="import" accept=".json"><p class="small" id="importNote"></p></div></section>`;
  $("#download")?.addEventListener("click", () => {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([keyFile()], { type: "application/json" })), download: `hearth-${me.address.slice(-6)}.json` });
    a.click();
  });
  $("#forget")?.addEventListener("click", () => {
    if (!confirm("Forget this key in this browser? Without the downloaded file, its coin is gone.")) return;
    try { localStorage.removeItem(store.name("key")); localStorage.removeItem(store.name("key", "moorage")); } catch {}
    earning?.stop("Stopped: the account it paid was forgotten.");
    me = null; renderChip(); route();
  });
  $("#import").onchange = async (e) => {
    try {
      const j = JSON.parse(await e.target.files[0].text());
      const privateKey = sdk.hexToBytes(j.privateKey);
      const address = sdk.accountFromPrivateKey(privateKey).address;
      if (!isAddress(address)) throw new Error("not a key");
      store.set("key", sdk.bytesToHex(privateKey));
      if (address !== me?.address) earning?.stop("Stopped: this browser uses another account now.");
      me = { privateKey, address };
      await loadBalances(); route();
    } catch (err) { $("#importNote").textContent = `That file is not a key: ${err.message}`; }
  };
}

// ---- start ----
$("#foot").innerHTML = `Market chain <span class="mono">${esc(cfg.market)}</span> read from <span class="mono">${esc(cfg.node)}</span>, every record checked against its CID. <a href="${DOCS}">Docs</a> · <a href="https://github.com/hearthnet/hearth">Source</a>`;
renderChip();
if (me) loadBalances();
buying = (() => { const b = store.get("buying", null); return b ? revive(b) : null; })();
if (buying && buying.step !== "done" && !buying.error && me) runPurchase();
setInterval(() => { if (me && document.visibilityState === "visible") loadBalances().then(() => refreshYou?.()); }, 20000);
route();
