// `hearth sell`: the offer from flags, the seller's key, the chains it makes
// its node host, which hosts the page sells, and the service it installs.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { chmodSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as sdk from "../vendor/lattice-sdk.js";
import { keyFileJSON } from "../client/tx.mjs";
import { hostVouches, standing } from "../client/vouch.mjs";
import { formatOffer, offerText } from "../client/records.mjs";
import { DEFAULT_MARKET, DEFAULT_TERMS, currentOffer, ensureKey, fundingMessage, fundingStep, growthLine, liveOffers, offerFromFlags, parsePrice, parseSize, periodBlocks, sellerChains,
  serviceUnits, worstGrowth } from "../host/hearth.mjs";
import { earnings, report } from "../host/status.mjs";


const BIN = join(dirname(fileURLToPath(import.meta.url)), "../bin/hearth.mjs");
const HOST = sdk.accountFromPrivateKey(new Uint8Array(32).fill(1)).address;
const temp = () => mkdtempSync(join(tmpdir(), "hearth-"));

test("--price is coin per market blocks, or per hour, day or week at the market's block time", () => {
  assert.deepEqual(parsePrice("100/day"), { price: 100n, period: "day" });
  assert.deepEqual(parsePrice("7/1440"), { price: 7n, period: 1440n });
  assert.throws(() => offerFromFlags({ price: "1/day", chains: "9007199254740992" }), /--chains/);
  for (const bad of ["100", "0/day", "100/month", "100/0", "-1/day", "1.5/day", "9007199254740992/day", "1/9007199254740992", undefined]) assert.throws(() => parsePrice(bad), /--price/, String(bad));
  assert.deepEqual(parsePrice("9007199254740991/day").price, 9007199254740991n, "the largest exact price");
  assert.equal(periodBlocks("day", "60000"), 1440n, "a day of one-minute blocks");
  assert.equal(periodBlocks("hour", 5000n), 720n);
  assert.equal(periodBlocks("week", "60000"), 10080n);
  assert.equal(periodBlocks("hour", "7200000"), 1n, "never under one block");
  assert.equal(periodBlocks(1440n, "1"), 1440n, "blocks stay blocks");
});

test("the same flags make the same offer, with small chains' limits", () => {
  const offer = offerFromFlags({ price: "100/day" });
  assert.deepEqual({ ...offer, id: undefined }, { id: undefined, parent: "Nexus", price: 100, period: "day", capacity: 10, maxBlockSize: 20000,
    maxStateGrowth: 10000, minTargetBlockTime: 30000, maxNumberOfTransactionsPerBlock: 100, modules: "any" });
  assert.equal(offerFromFlags({ price: "100/day" }).id, offer.id, "written once: the same id again");
  assert.notEqual(offerFromFlags({ price: "100/day", chains: "5" }).id, offer.id);
  assert.equal(offerFromFlags({ price: "100/day", id: "mine" }).id, "mine");
  assert.deepEqual([offerFromFlags({ price: "1/1", parent: "Nexus/x", chains: "3" })].map((o) => [o.parent, o.capacity]), [["Nexus/x", 3]]);
});

test("the default terms bound what one order can add to the host's disk in a day", () => {
  assert.deepEqual(worstGrowth(DEFAULT_TERMS), { blocks: 2880, perChain: 86_400_000, all: 864_000_000 }, "30 s blocks of 20 kB adding 10 kB of state, 10 chains");
  assert.match(growthLine(DEFAULT_TERMS), /^worst case, each chain sold adds up to 86\.4 MB a day to this node's disk \(2880 blocks of 20\.0 kB, each adding 10\.0 kB of state\), 864\.0 MB a day for all 10/);
  const before = { capacity: 50, maxBlockSize: 1000000, maxStateGrowth: 1000000, minTargetBlockTime: 5000 };
  assert.equal(worstGrowth(before).perChain, 34_560_000_000, "the old terms: 34.6 GB a day per chain");
  assert.ok(worstGrowth(before).perChain / worstGrowth(DEFAULT_TERMS).perChain >= 400);
});

test("--storage-budget is bytes, or K, M, G or T (binary)", () => {
  assert.equal(parseSize("256M", "--storage-budget"), 268435456);
  assert.equal(parseSize("1GiB", "--storage-budget"), 1073741824);
  assert.equal(parseSize("1g", "--storage-budget"), 1073741824);
  assert.equal(parseSize("500000", "--storage-budget"), 500000);
  for (const bad of ["0", "-1M", "1.5G", "1P", "lots", "", undefined]) assert.throws(() => parseSize(bad, "--storage-budget"), /--storage-budget is a size/, String(bad));
});

test("the seller's first writes are funded from the sponsor key's block rewards, before lattice-sponsor signs with it", () => {
  const at = { fee: 1n, chain: "Nexus/testnet/lodger", address: HOST, interval: "30" };
  assert.deepEqual(fundingStep({ ...at, seller: 3n, sponsor: 0n, canMove: true }), { ready: true });
  assert.deepEqual(fundingStep({ ...at, seller: 0n, sponsor: 5000n, canMove: true }), { move: 4n }, "offer, url, storage offer and a close");
  assert.deepEqual(fundingStep({ ...at, seller: 1n, sponsor: 4n, canMove: true }), { move: 3n });
  const waiting = fundingStep({ ...at, seller: 0n, sponsor: 2n, canMove: true }).wait;
  assert.match(waiting, /waiting for block rewards\. This seller's blocks pay the sponsor's key \(it holds 2\), and the seller moves 4 from it once it holds 5\./);
  assert.match(waiting, new RegExp(`Not to wait, send 3 coin on Nexus/testnet/lodger to ${HOST}, or earn it with this machine: hearth earn`));
  assert.match(fundingStep({ ...at, seller: 0n, sponsor: 5000n, canMove: true, otherSponsor: "8650" }).wait,
    /^a lattice-sponsor already answers on port 8650 and may sign with the sponsor's key, so the seller moves nothing from it: stop that sponsor, or send 3 coin/,
    "a sponsor on the port may sign with the same key: nothing moved");
  const remote = fundingStep({ ...at, seller: 0n, sponsor: 5000n, canMove: false }).wait;
  assert.match(remote, /^Send at least 3 coin .* hearth sweep moves them here while no lattice-sponsor signs with it\.$/, "a sponsor signs with the key already, or --node: never moved here");
});

test("a pass reports both balances, what buyers paid and what is owed, and storage against the budget", () => {
  const o = (created, paid, path) => ({ key: `order/${path}`, created, paid, path });
  const lines = report({ market: "Nexus/testnet/lodger", height: 100n, seller: { address: "S", balance: 297n }, sponsor: { address: "P", balance: 52000n },
    mine: [o(10n, 100n, "Nexus/testnet/a"), o(95n, 200n, "Nexus/testnet/b")], renewals: [o(50n, 100n, "Nexus/testnet/a")], counts: { owed: 1, pending: 1 },
    until: new Map([["Nexus/testnet/a", 3000n]]), earned: 200n, settling: 200n, storage: { budget: 256 * 2 ** 20, stored: 12 * 2 ** 20, held: 2 ** 20 } });
  assert.deepEqual(lines, [
    "market Nexus/testnet/lodger at block 100: the seller's key S holds 297; the sponsor's key P holds 52000 (its block rewards)",
    '2 orders {"owed":1,"pending":1} and 1 renewals: earned 200 coin from buyers, 200 more settling',
    "owes hosting to Nexus/testnet/a (to market block 3000)",
    "storage pinned by the sponsor: 12.0 MiB of its 256.0 MiB budget, 1.0 MiB held for uploads being paid, 243.0 MiB left",
  ]);
  assert.deepEqual(report({ market: "M", height: 1n, seller: { address: "S", balance: 0n }, sponsor: { address: "P", balance: 0n }, mine: [], renewals: [], counts: {},
    until: new Map(), earned: 0n, settling: 0n }).slice(2), ["owes hosting to no chain now", "storage: no lattice-sponsor reporting it on the sponsor port (not running yet, or older than its storage report)"]);
});

test("earned counts only other buyers' payments for hosting owed: not void orders, the seller's own, or renewals after a close", () => {
  const B = "buyer", A = "Nexus/testnet/a", V = "Nexus/testnet/v", S = "Nexus/testnet/s", N = "Nexus/testnet/n";
  const ord = (key, created, paid, path, buyer = B) => ({ key, host: HOST, id: "o", created, paid, path, buyer });
  const ren = (created, paid, path, payer = B) => ({ key: `r${created}`, host: HOST, id: "o", created, paid, path, payer });
  // On sale from block 10, closed at block 200 (in force from 210).
  const versions = new Map([[`${HOST}/o`, [offerAt({ created: 10n, until: 5000n }), offerAt({ created: 200n, until: 200n })]]]);
  const mine = [ord("a", 30n, 100n, A), ord("v", 40n, 300n, V), ord("s", 50n, 400n, S, HOST), ord("n", 295n, 500n, N)];
  const verdicts = new Map([["a", { kind: "owed" }], ["v", { kind: "void" }], ["s", { kind: "owed" }], ["n", { kind: "pending" }]]);
  const renewals = [ren(100n, 20n, A), ren(250n, 50n, A), ren(120n, 70n, A, HOST), ren(130n, 9n, V), ren(296n, 1n, A)];
  assert.deepEqual(earnings({ m: { height: 300n, versions }, self: HOST, mine, renewals, verdicts }), { earned: 120n, settling: 501n },
    "a's order and its renewal before the close; settling: n's order and the newest renewal");
});

test("the seller's key is made once, mode 0600, as `lattice key generate` writes it", () => {
  const path = join(temp(), "hearth/seller.json");
  const first = ensureKey(sdk, path, keyFileJSON);
  assert.equal(first.created, true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(file).sort(), ["address", "privateKey", "publicKey"]);
  assert.equal(file.address, first.address);
  assert.deepEqual(ensureKey(sdk, path, keyFileJSON), { address: first.address, created: false }, "reused");
  chmodSync(path, 0o640);
  assert.throws(() => ensureKey(sdk, path, keyFileJSON), /chmod 600/, "a key others can read is refused");
});

const offerAt = (o) => offerText(o.created, formatOffer({ price: 1n, period: 1n, capacity: 1n, maxBlockSize: 1n, maxStateGrowth: 1n,
  minTargetBlockTime: 1n, maxNumberOfTransactionsPerBlock: 1n, modules: "any", ...o }));

test("the fragment lists the market, its offers' parents, and owed chains only under parents someone chose", () => {
  const M = "Nexus/testnet/lodger";
  assert.deepEqual(sellerChains({ market: M, parents: ["Nexus/testnet"] }), ["Nexus/testnet", M]);
  assert.deepEqual(sellerChains({ market: M, parents: ["Nexus/testnet"], owed: ["Nexus/testnet/app", "Nexus/other/app", "Nexus/kept/app", "Nexus/top"], others: new Set(["Nexus/kept"]) }),
    ["Nexus/testnet", "Nexus/top", "Nexus/kept/app", "Nexus/testnet/app", M]);
  assert.deepEqual(sellerChains({ market: M, owed: ["Nexus/testnet/app"] }), [M], "no offer yet: no parent chosen");
});

test("a chain owed on an older offer stays in the fragment after the flags change", () => {
  const M = "Nexus/testnet/lodger", OTHER = sdk.accountFromPrivateKey(new Uint8Array(32).fill(2)).address;
  const offers = new Map([
    [`${HOST}/old`, offerAt({ created: 10n, parent: "Nexus/old", until: 500n })],
    [`${HOST}/ended`, offerAt({ created: 10n, parent: "Nexus/ended", until: 100n })],
    [`${OTHER}/theirs`, offerAt({ created: 10n, parent: "Nexus/theirs", until: 500n })],
  ]);
  const live = liveOffers(offers, HOST, 200n);
  assert.deepEqual(live, [{ id: "old", parent: "Nexus/old", until: 500n }], "only this key's offers still on sale");
  // The flags now sell under Nexus/new; Nexus/old/app was sold on the old offer.
  const parents = ["Nexus/new", ...live.map((o) => o.parent)];
  assert.deepEqual(sellerChains({ market: M, parents, owed: ["Nexus/old/app", "Nexus/new/app", "Nexus/ended/app"] }),
    ["Nexus/new", "Nexus/old", "Nexus/new/app", "Nexus/old/app", M]);
});

test("funding waits until the key holds the market coin its writes cost", () => {
  const need = (balance) => ({ chain: "Nexus/testnet/lodger", amount: 3n, balance });
  assert.equal(fundingMessage({ address: HOST, need: need(2n), interval: "30" }),
    `Send at least 3 coin on Nexus/testnet/lodger to ${HOST}, from any account that holds some, or earn it with this machine: hearth earn; this seller waits and checks again every 30 s.`);
  assert.equal(fundingMessage({ address: HOST, need: need(3n), interval: "30" }), undefined, "covered: it writes");
});

const web = (pages) => async (url) => (url in pages ? { ok: true, json: async () => pages[url] } : { ok: false, status: 404 });

test("a host with no url record sells under its key; one whose url fails stays hidden", async () => {
  const listed = web({ "https://host.example/.well-known/lattice.json": { sellers: [HOST] } });
  assert.equal(standing(await hostVouches({ host: HOST, urlValue: "https://host.example", fetchImpl: listed })), "verified");
  assert.equal(standing(await hostVouches({ host: HOST, urlValue: undefined, fetchImpl: listed })), "key-only");
  assert.equal(standing(await hostVouches({ host: HOST, urlValue: "https://host.example", fetchImpl: web({}) })), undefined, "names a domain that does not list it");
  assert.equal(standing(await hostVouches({ host: HOST, urlValue: "not a url", fetchImpl: listed })), undefined, "a malformed url record");
});

test("--install writes units for the node and the seller, the seller after the node, and only says how to load them", () => {
  const command = ["/usr/bin/node", "/opt/hearth/bin/hearth.mjs", "sell", "--root", "/srv/my node", "--offer", "/srv/o.json", "--key", "/k/100%$HOME"];
  const nodeCommand = ["/usr/local/bin/lattice", "up", "--root", "/srv/my node"];
  const linux = serviceUnits({ platform: "linux", home: "/home/h", command, nodeCommand, path: "/usr/bin:/bin" });
  assert.deepEqual(linux.units.map((u) => u.file), ["/home/h/.config/systemd/user/hearth-node.service", "/home/h/.config/systemd/user/hearth.service"]);
  const [node, seller] = linux.units.map((u) => u.content);
  assert.match(node, /^ExecStart=\/usr\/local\/bin\/lattice up --root "\/srv\/my node"$/m);
  assert.match(node, /^Restart=on-failure$/m, "restarted on a failure exit, which `lattice restart` is; left stopped by `lattice down`");
  assert.match(node, /^RestartPreventExitStatus=78$/m);
  assert.match(seller, /^ExecStart=\/usr\/bin\/node \/opt\/hearth\/bin\/hearth.mjs sell --root "\/srv\/my node" --offer \/srv\/o.json --key \/k\/100%%\$\$HOME$/m);
  assert.match(seller, /^After=hearth-node.service$/m);
  assert.match(seller, /^Requires=hearth-node.service$/m);
  assert.match(seller, /^Restart=on-failure$/m, "not after it exits 0: `hearth stop`, once nothing paid is left");
  for (const unit of [node, seller]) assert.doesNotMatch(unit, /network-online/, "a user manager has no network-online.target");
  for (const unit of [node, seller]) assert.match(unit, /^WantedBy=default.target$/m);
  assert.equal(linux.load, "loginctl enable-linger $USER && systemctl --user daemon-reload && systemctl --user enable --now hearth-node.service hearth.service");
  assert.match(linux.note, /without a login/);
  const mac = serviceUnits({ platform: "darwin", home: "/home/h", command, nodeCommand, path: "/usr/bin:/bin" });
  assert.deepEqual(mac.units.map((u) => u.file), ["/home/h/Library/LaunchAgents/net.hearth.node.plist", "/home/h/Library/LaunchAgents/net.hearth.seller.plist"]);
  assert.ok(mac.units[0].content.includes("<key>Label</key><string>net.hearth.node</string>") && mac.units[0].content.includes("<string>up</string>"));
  for (const unit of mac.units) assert.ok(unit.content.includes("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>"), "down after `lattice down`, and after the seller's last paid chain");
  assert.ok(mac.units[1].content.includes("<key>Label</key><string>net.hearth.seller</string>") && mac.units[1].content.includes("<string>/srv/my node</string>"));
  // launchd cannot exempt exit 78: the node runs under /bin/sh, which exits 0 for it.
  const argv = [...mac.units[0].content.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/&gt;/g, ">"));
  const sh = argv.slice(argv.indexOf("/bin/sh"), argv.indexOf("up") + 3);
  assert.deepEqual(sh.slice(4), ["/usr/local/bin/lattice", "up", "--root", "/srv/my node"]);
  for (const [code, exits] of [[78, 0], [75, 75], [1, 1], [0, 0]]) {
    const r = spawnSync(sh[0], [sh[1], sh[2], sh[3], "/bin/sh", "-c", `exit ${code}`]);
    assert.equal(r.status, exits, `exit ${code}`);
  }
  assert.equal(mac.load, "launchctl bootstrap gui/$(id -u) /home/h/Library/LaunchAgents/net.hearth.node.plist && launchctl bootstrap gui/$(id -u) /home/h/Library/LaunchAgents/net.hearth.seller.plist");
  assert.match(mac.note, /logged in.*LaunchDaemons/);
  const remote = serviceUnits({ platform: "linux", home: "/home/h", command, path: "/usr/bin:/bin" });
  assert.deepEqual(remote.units.map((u) => u.file), ["/home/h/.config/systemd/user/hearth.service"], "with --node: no node to run here");
  assert.doesNotMatch(remote.units[0].content, /Requires=/);
  assert.throws(() => serviceUnits({ platform: "win32", home: "C:", command, nodeCommand, path: "" }), /systemd/);
});

/**
 * A node that answers only its configuration routes and `GET /status`: a
 * fresh node, which reads no market yet. `version` is what its status
 * reports; `old`: a node before 4.0.1, whose `GET /config` does not say
 * which layer lists each chain; `chains` maps a chain path to its status
 * (absent: not hosted).
 */
async function freshNode({ version = "4.0.0+dev", old = false, chains = {}, balance } = {}) {
  const puts = [], posted = [];
  let fragment;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer secret") { res.writeHead(401).end(); return; }
      const url = new URL(req.url, "http://x");
      // With `balance`, each account on the market holds `balance(address)`.
      if (balance && url.pathname.startsWith("/api/state/account/")) { res.writeHead(200).end(JSON.stringify({ balance: String(balance(url.pathname.split("/").at(-1))), nonce: "0" })); return; }
      if (balance && url.pathname === "/api/chain/info") { res.writeHead(200).end(JSON.stringify({ minRelayFee: 1 })); return; }
      if (url.pathname === "/transactions") { posted.push(JSON.parse(body)); res.writeHead(200).end("{}"); return; }
      if (url.pathname === "/status") {
        const path = url.searchParams.get("chainPath");
        const status = path ? chains[path] : { phase: "active", height: "1", ...(version ? { version } : {}) };
        if (status) { res.writeHead(200).end(JSON.stringify(status)); return; }
      }
      if (req.url === "/config" && !old) { res.writeHead(200).end(JSON.stringify({ fragments: ["lattice"], status: { chains: [] } })); return; }
      if (req.url === "/config/fragments/hostmarket" && req.method === "PUT") {
        puts.push({ body: JSON.parse(body), condition: req.headers["if-none-match"] ?? req.headers["if-match"] });
        fragment = body; res.writeHead(204).end(); return;
      }
      if (req.url === "/config/fragments/hostmarket" && fragment) { res.writeHead(200, { ETag: `"${puts.length}"` }).end(fragment); return; }
      res.writeHead(404).end();
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const root = temp(), port = server.address().port;
  mkdirSync(join(root, "chains/Nexus"), { recursive: true });
  writeFileSync(join(root, "chains/Nexus/.cookie"), "__cookie__:secret");
  writeFileSync(join(root, "lattice.json"), JSON.stringify({ rpc: port }));
  // `lattice config get rpc`, as a 4.0.1 `lattice` answers it.
  const lattice = join(temp(), "lattice");
  writeFileSync(lattice, `#!/bin/sh\n[ "$1 $2 $3" = "config get rpc" ] && echo ${port} && exit 0\nexit 64\n`, { mode: 0o755 });
  // A lattice-sponsor that writes down how it was run, and runs until stopped.
  const sponsorRan = join(temp(), "sponsor-args");
  const sponsor = join(temp(), "lattice-sponsor");
  writeFileSync(sponsor, `#!/bin/sh\necho $$ "$@" > ${sponsorRan}\nexec sleep 30\n`, { mode: 0o755 });
  return { root, puts, posted, lattice, sponsor, sponsorRan, close: () => server.close() };
}
const hearth = (args, env = {}) => new Promise((ok) => execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => ok({ code: error?.code ?? 0, out: stdout + stderr })));
const sell = (node, more = [], env) => hearth(["sell", "--price", "100/day", "--root", node.root, "--once", "--lattice", node.lattice, "--sponsor-bin", node.sponsor, ...more], env);

test("`hearth sell --price` beside a fresh node: makes the key, and has the node host the market and the parent", async () => {
  const node = await freshNode();
  try {
    const { code, out } = await sell(node);
    assert.equal(code, 0, out);
    const key = join(node.root, "hearth/seller.json");
    assert.equal(statSync(key).mode & 0o777, 0o600);
    const { address, privateKey } = JSON.parse(readFileSync(key, "utf8"));
    assert.ok(out.includes(address) && !out.includes(privateKey), "the address, never the private key");
    assert.match(out, new RegExp(`waiting for the node to host ${DEFAULT_MARKET}`));
    assert.doesNotMatch(out, /HTTP 404/, "no error while the market is not hosted yet");
    assert.deepEqual(node.puts, [{ body: { hostedChains: [DEFAULT_MARKET] }, condition: "*" }]);
    const first = join(node.root, `hearth/${offerFromFlags({ price: "100/day" }).id}.json`);
    assert.equal(JSON.parse(readFileSync(first, "utf8")).period, "day");
    const again = await hearth(["sell", "--price", "200/day", "--root", node.root, "--once", "--lattice", node.lattice, "--sponsor-bin", node.sponsor]);
    assert.equal(again.code, 0, again.out);
    assert.equal(JSON.parse(readFileSync(first, "utf8")).price, 100, "other flags leave the first offer's file");
    assert.equal(JSON.parse(readFileSync(join(node.root, `hearth/${offerFromFlags({ price: "200/day" }).id}.json`), "utf8")).price, 200, "and write their own");
  } finally { node.close(); }
});

test("`hearth sell` beside a node older than 4.0.1 says so and stops", async () => {
  const node = await freshNode({ version: "4.0.0", old: true });
  try {
    const { code, out } = await sell(node);
    assert.equal(code, 2, out);
    assert.match(out, /Hearth needs Lattice 5\.0\.0 or newer \(you have 4\.0\.0: its GET \/config does not say which layer lists each chain\)/);
    assert.deepEqual(node.puts, [], "it changes nothing on the node");
    // A 4.0.0 `lattice` has no `config`: lattice.json finds the node, only to say this.
    const old = join(temp(), "lattice");
    writeFileSync(old, "#!/bin/sh\necho \"Error: Unexpected argument 'config'\" >&2\nexit 64\n", { mode: 0o755 });
    const viaFile = await hearth(["sell", "--price", "100/day", "--root", node.root, "--once", "--lattice", old, "--sponsor-bin", node.sponsor]);
    assert.match(viaFile.out, /Hearth needs Lattice 5\.0\.0 or newer \(you have 4\.0\.0: its GET \/config does not say which layer lists each chain\)/);
    const burnt = await hearth(["burn", "5", "--chain", DEFAULT_MARKET, "--root", node.root, "--lattice", node.lattice]);
    assert.equal(burnt.code, 2);
    assert.match(burnt.out, /Hearth needs Lattice 5\.0\.0 or newer/);
  } finally { node.close(); }
});

test("while the node syncs the market, the seller says how far it is and asks for no coin", async () => {
  const node = await freshNode({ chains: { [DEFAULT_MARKET]: { phase: "active", height: "5", bestHeaderHeight: "10" } } });
  try {
    const { code, out } = await sell(node);
    assert.equal(code, 0, out);
    assert.match(out, /syncing market: 5 \/ 10/);
    assert.doesNotMatch(out, /Send at least|send coin|hearth earn/i);
    assert.deepEqual(node.puts.map((p) => p.body.hostedChains), [[DEFAULT_MARKET]], "it still has the node host the market");
  } finally { node.close(); }
});

/** `hearth sell` running until the sponsor has started: what the sponsor was run with, then the seller stopped as `hearth stop` stops it. */
async function sellUntilSponsor(node, more = []) {
  const child = spawn(process.execPath, [BIN, "sell", "--price", "100/day", "--root", node.root, "--lattice", node.lattice, "--sponsor-bin", node.sponsor, "--interval", "1", ...more]);
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 100 && !existsSync(node.sponsorRan); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
  const [pid, ...ran] = readFileSync(node.sponsorRan, "utf8").trim().split(" ");
  const pidFile = join(node.root, "hearth/seller.pid");
  const seller = Number(readFileSync(pidFile, "utf8"));
  const exited = new Promise((ok) => child.on("exit", ok));
  process.kill(seller, "SIGTERM");
  await exited;
  await new Promise((r) => setTimeout(r, 200));
  let sponsorAlive = true;
  try { process.kill(Number(pid), 0); } catch { sponsorAlive = false; }
  rmSync(node.sponsorRan);
  return { out, ran: ran.join(" "), sponsorAlive, pidLeft: existsSync(pidFile) };
}

const SYNCED = { [DEFAULT_MARKET]: { phase: "active", height: "5", bestHeaderHeight: "5" } };

test("`hearth sell` runs lattice-sponsor beside the node with a key of its own, on loopback without --sponsor-url, and stops it with itself", async () => {
  const node = await freshNode({ chains: SYNCED, balance: () => 1000n });
  try {
    const { out, ran, sponsorAlive, pidLeft } = await sellUntilSponsor(node);
    const sponsorKey = join(node.root, "hearth/sponsor.json");
    assert.equal(statSync(sponsorKey).mode & 0o777, 0o600);
    const seller = JSON.parse(readFileSync(join(node.root, "hearth/seller.json"), "utf8")).address;
    const sponsor = JSON.parse(readFileSync(sponsorKey, "utf8")).address;
    assert.notEqual(sponsor, seller, "never the seller's key");
    assert.match(out, new RegExp(`blocks pay ${sponsor}`));
    assert.ok(ran.includes(`--key ${sponsorKey}`) && ran.includes(`--cookie-file ${join(node.root, "chains/Nexus/.cookie")}`), ran);
    assert.ok(ran.includes("--port 8650") && ran.includes("--host 127.0.0.1"), ran);
    assert.ok(ran.includes(`--sell-storage --storage-rate ${DEFAULT_MARKET}=10240`) && ran.includes(`--pay-to ${seller}`) && !ran.includes("--funds"), ran);
    assert.ok(ran.includes("--storage-budget 268435456"), `a budget of 256 MiB unless --storage-budget says: ${ran}`);
    assert.match(out, /no --sponsor-url: the offer names no sponsor/);
    assert.equal(sponsorAlive, false, "the sponsor stops with the seller");
    assert.equal(pidLeft, false);
    const open = await sellUntilSponsor(node, ["--sponsor-url", "https://host.example/sponsor", "--sponsor-port", "9650", "--storage-rate", "4096", "--storage-budget", "1G"]);
    assert.ok(open.ran.includes("--port 9650 --host 0.0.0.0") && open.ran.includes(`${DEFAULT_MARKET}=4096`), open.ran);
    assert.ok(open.ran.includes("--storage-budget 1073741824"), open.ran);
    assert.equal(JSON.parse(readFileSync(sponsorKey, "utf8")).address, sponsor, "the same key again");
  } finally { node.close(); }
});

test("without lattice-sponsor, `hearth sell` says where to get it; --mine is gone", async () => {
  const node = await freshNode();
  try {
    const { code, out } = await hearth(["sell", "--price", "100/day", "--root", node.root, "--once", "--lattice", node.lattice, "--sponsor-bin", "/nonexistent/lattice-sponsor"]);
    assert.equal(code, 2);
    assert.match(out, /no lattice-sponsor at \/nonexistent\/lattice-sponsor: .*https:\/\/lattice\.build\/docs\/.*--sponsor-bin/);
    const onPath = await hearth(["sell", "--price", "100/day", "--root", node.root, "--once", "--lattice", node.lattice], { PATH: dirname(process.execPath) });
    assert.match(onPath.out, /no lattice-sponsor at lattice-sponsor on PATH/);
    const mine = await sell(node, ["--mine", "1TH/s"]);
    assert.equal(mine.code, 2);
    assert.match(mine.out, /Unknown option '--mine'/);
  } finally { node.close(); }
});

test("`hearth sell --install` writes the node's and the seller's units for this OS and loads nothing", async () => {
  const node = await freshNode();
  node.close();
  const home = temp(), bin = join(temp(), "bin");
  // The node a shell finds, as a link (as /opt/homebrew/bin/node links into a versioned Cellar).
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  mkdirSync(join(node.root, "hearth"), { recursive: true });
  writeFileSync(join(node.root, "hearth/closing"), "closed before\n");
  const { code, out } = await hearth(["sell", "--price", "100/day", "--root", node.root, "--install", "--lattice", node.lattice, "--sponsor-bin", node.sponsor], { HOME: home, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(code, 0, out);
  const [nodeUnit, file] = process.platform === "darwin"
    ? [join(home, "Library/LaunchAgents/net.hearth.node.plist"), join(home, "Library/LaunchAgents/net.hearth.seller.plist")]
    : [join(home, ".config/systemd/user/hearth-node.service"), join(home, ".config/systemd/user/hearth.service")];
  assert.ok(existsSync(file) && existsSync(nodeUnit), out);
  assert.ok(readFileSync(nodeUnit, "utf8").includes(node.lattice) && readFileSync(nodeUnit, "utf8").includes(node.root), "the node: lattice up --root <root>");
  const unit = readFileSync(file, "utf8");
  assert.ok(unit.includes(join(bin, "node")) && !unit.includes(process.execPath), "the node on PATH, not this process's resolved path");
  assert.ok(unit.includes(join(node.root, `hearth/${offerFromFlags({ price: "100/day" }).id}.json`)) && unit.includes(node.sponsor));
  assert.ok(unit.includes("--resume"), "a service restart never reopens a closed offer");
  assert.ok(existsSync(join(node.root, "hearth/reopen")) && !existsSync(join(node.root, "hearth/closing")), "but installing puts the offer on sale: the service's next start writes it once");
  assert.match(out, process.platform === "darwin" ? /launchctl bootstrap gui\/\$\(id -u\) .*net\.hearth\.node\.plist && launchctl bootstrap/ : /systemctl --user enable --now hearth-node.service hearth.service/);
});

test("hosting goes by the offer as written on the market, not the local file", () => {
  const file = { id: "o", parent: "Nexus/edited" };
  assert.deepEqual(currentOffer({ self: HOST, id: "o", file }), { parent: "Nexus/edited" }, "not written yet: the file");
  const offers = new Map([[`${HOST}/o`, offerAt({ created: 10n, parent: "Nexus/testnet", until: 500n })]]);
  assert.deepEqual(currentOffer({ offers, self: HOST, id: "o", file }), { parent: "Nexus/testnet" });
  assert.equal(currentOffer({ offers: new Map(), self: HOST, id: "o" }), undefined);
});


test("a `lattice` that prints no JSON fails the pass, which is logged, not the process", async () => {
  const node = await freshNode();
  try {
    const lattice = join(temp(), "lattice");
    writeFileSync(lattice, "#!/bin/sh\necho 'not json'\n", { mode: 0o755 });
    const { code, out } = await hearth(["sell", "--price", "100/day", "--root", node.root, "--once", "--lattice", lattice, "--sponsor-bin", node.sponsor]);
    assert.equal(code, 0, out);
    assert.match(out, /pass failed: .*config get rpc/);
  } finally { node.close(); }
});

test("an unfunded seller starts no lattice-sponsor: the sponsor's key is its own to move the first fees from", async () => {
  const node = await freshNode({ chains: SYNCED, balance: () => 0n });
  try {
    const child = spawn(process.execPath, [BIN, "sell", "--price", "100/day", "--root", node.root, "--lattice", node.lattice, "--sponsor-bin", node.sponsor, "--interval", "1"]);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    await new Promise((r) => setTimeout(r, 3000));
    child.kill("SIGTERM");
    await new Promise((ok) => child.on("exit", ok));
    assert.equal(existsSync(node.sponsorRan), false, out);
    assert.match(out, /worst case, each chain sold adds up to 86\.4 MB a day/, "the offer's worst case, before anything is on sale");
  } finally { node.close(); }
});

test("every verb takes --help", async () => {
  for (const verb of ["sell", "status", "stop", "unpin", "sweep", "earn", "burn", "sell-coin"]) {
    const { code, out } = await hearth([verb, "--help"]);
    assert.equal(code, 0, `${verb}: ${out}`);
    assert.match(out, new RegExp(`^usage: hearth ${verb} `), verb);
  }
  assert.match((await hearth(["sell", "--price", "100/day", "-h"])).out, /--storage-budget 256M/);
  assert.match((await hearth(["status", "-h"])).out, /--sponsor-port 8650/);
});

test("a bad flag is refused before `hearth sell` writes anything", async () => {
  const node = await freshNode();
  const badStorage = join(temp(), "storage.json"), badJSON = join(temp(), "storage.json");
  writeFileSync(badStorage, JSON.stringify({ id: "files", sponsor: "http://host.example", bytesPerCoin: 10240, capacity: 1000 }));
  writeFileSync(badJSON, "{ not json");
  try {
    for (const bad of [["--price", "100/dya"], ["--price", "100/day", "--storage-budget", "lots"], ["--price", "100/day", "--sponsor-url", "http://host.example"],
      ["--price", "100/day", "--interval", "0"], ["--price", "100/day", "--burn", "x"], ["--price", "100/day", "--storage-rate", "1.5"], ["--offer", "/nonexistent/offer.json"],
      ["--parent", "testnet/app"], ["--parent", "Nexus//x"], ["--storage-offer", badStorage], ["--storage-offer", badJSON]]) {
      const { code, out } = await hearth(["sell", ...bad, "--root", node.root, "--once", "--lattice", node.lattice, "--sponsor-bin", node.sponsor]);
      assert.equal(code, 2, `${bad.join(" ")}: ${out}`);
      assert.doesNotMatch(out, /made the seller's key/, bad.join(" "));
      assert.equal(existsSync(join(node.root, "hearth")), false, `${bad.join(" ")}: nothing written`);
    }
    assert.deepEqual(node.puts, []);
  } finally { node.close(); }
});

test("--root where no Lattice node lives says so and exits", async () => {
  const empty = temp();
  for (const verb of [["sell", "--price", "100/day"], ["status"], ["stop"], ["sweep"]]) {
    const { code, out } = await hearth([...verb, "--root", empty]);
    assert.equal(code, 2, out);
    assert.equal(out.trim(), `hearth: no Lattice node at ${empty}: give the root of one (lattice init --root <dir>, then lattice up --root <dir>), or --node with --token-file`);
  }
  assert.equal(existsSync(join(empty, "hearth")), false, "no key made there");
});

test("`hearth unpin <cid>` takes a file down on the sponsor beside the node, with the node's cookie", async () => {
  const CID = "bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", REFUSED = "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const node = await freshNode();
  node.close();
  const asked = [];
  const sponsor = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      asked.push({ route: `${req.method} ${req.url}`, auth: req.headers.authorization, body });
      if (req.headers.authorization !== `Basic ${Buffer.from("__cookie__:secret").toString("base64")}`) return res.writeHead(401).end();
      const { cid } = JSON.parse(body);
      if (cid === REFUSED) return res.writeHead(502).end(JSON.stringify({ error: "notUnpinned" }));
      res.writeHead(200).end(JSON.stringify({ cid, unpinned: [cid, "bafyreibbbb"] }));
    });
  });
  await new Promise((ok) => sponsor.listen(0, "127.0.0.1", ok));
  const port = String(sponsor.address().port);
  try {
    const done = await hearth(["unpin", CID, "--root", node.root, "--sponsor-port", port]);
    assert.equal(done.code, 0, done.out);
    assert.deepEqual(asked[0], { route: "POST /takedown", auth: `Basic ${Buffer.from("__cookie__:secret").toString("base64")}`, body: JSON.stringify({ cid: CID }) });
    assert.match(done.out, new RegExp(`took ${CID} down: the sponsor refuses it from now on, and unpinned 2 Volumes .*no refund`));
    const retry = await hearth(["unpin", REFUSED, "--root", node.root, "--sponsor-port", port]);
    assert.equal(retry.code, 2);
    assert.match(retry.out, new RegExp(`the sponsor blocked ${REFUSED}, but the node refused to unpin it: run hearth unpin ${REFUSED} again`));
    const notCID = await hearth(["unpin", "hello", "--root", node.root, "--sponsor-port", port]);
    assert.match(notCID.out, /hello is not a CID/);
    assert.equal(asked.length, 2, "nothing asked for a non-CID");
  } finally { sponsor.close(); }
  const none = await hearth(["unpin", CID, "--root", node.root, "--sponsor-port", port]);
  assert.equal(none.code, 2);
  assert.match(none.out, new RegExp(`no lattice-sponsor answers on 127\\.0\\.0\\.1:${port}: unpin while the seller \\(and its sponsor\\) runs`));
});

test("`hearth sweep` while the seller runs says how to pause it without closing its offers", async () => {
  const node = await freshNode();
  // A process whose command line names sell-hosting.mjs, as the seller's does.
  const seller = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", "sell-hosting.mjs"]);
  try {
    mkdirSync(join(node.root, "hearth"), { recursive: true });
    ensureKey(sdk, join(node.root, "hearth/seller.json"), keyFileJSON);
    ensureKey(sdk, join(node.root, "hearth/sponsor.json"), keyFileJSON);
    writeFileSync(join(node.root, "hearth/seller.pid"), `${seller.pid}\n`);
    const { code, out } = await hearth(["sweep", "--root", node.root, "--lattice", node.lattice], { HOME: temp() });
    assert.equal(code, 2, out);
    assert.match(out, new RegExp(`the seller \\(pid ${seller.pid}\\) runs lattice-sponsor with the sponsor's key`));
    assert.match(out, /stop it \(Ctrl-C, or kill its pid\), run hearth sweep, then start it again with the same hearth sell flags and --resume/);
    assert.match(out, /Its offers stay on sale meanwhile \(hearth stop would close them\)\. The seller funds its first writes from the sponsor's key by itself\./);
  } finally { seller.kill(); node.close(); }
});

test("`hearth sell` alone sells at 10000 coin a day, and its first run says what a host earns and spends", async () => {
  const node = await freshNode();
  try {
    const run = () => hearth(["sell", "--root", node.root, "--once", "--lattice", node.lattice, "--sponsor-bin", node.sponsor]);
    const first = await run();
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /You earn Hearth coin \(the market's coin\): buyers' orders pay the seller's key, and the blocks it makes pay its sponsor's key .*Spend it on hosting or storage from any seller on the market\./);
    const file = join(node.root, `hearth/${offerFromFlags({ price: "10000/day" }).id}.json`);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).price, 10000);
    const again = await run();
    assert.doesNotMatch(again.out, /You earn Hearth coin/, "said once, when the key is made");
    const both = await hearth(["sell", "--price", "1/day", "--offer", file, "--root", node.root, "--once"]);
    assert.match(both.out, /not both/);
  } finally { node.close(); }
});

test("`hearth sell --node` checks the node is reachable before it writes a key", async () => {
  const dir = temp(), token = join(dir, "token");
  writeFileSync(token, "t\n");
  const { code, out } = await hearth(["sell", "--node", "http://127.0.0.1:9", "--token-file", token, "--key", join(dir, "seller.json"), "--once"]);
  assert.equal(code, 2, out);
  assert.match(out, /cannot reach the node at http:\/\/127\.0\.0\.1:9/);
  assert.equal(existsSync(join(dir, "seller.json")), false, "no key made");
});

test("`hearth unpin` beside a node that is not running says to start it", async () => {
  const root = temp();
  writeFileSync(join(root, "lattice.json"), "{}");
  const { code, out } = await hearth(["unpin", "bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", "--root", root]);
  assert.equal(code, 2, out);
  assert.match(out, new RegExp(`the Lattice node at ${root} is not running \\(no chains/Nexus/\\.cookie\\): start it`));
  assert.doesNotMatch(out, /ENOENT/);
});

test("`hearth status` never waits: an unsynced market is reported, and a node that does not answer times out", async () => {
  const node = await freshNode({ chains: { [DEFAULT_MARKET]: { phase: "active", height: "5", bestHeaderHeight: "10" } } });
  try {
    for (const k of ["seller", "sponsor"]) ensureKey(sdk, join(node.root, `hearth/${k}.json`), keyFileJSON);
    const { code, out } = await hearth(["status", "--root", node.root, "--lattice", node.lattice]);
    assert.equal(code, 0, out);
    assert.equal(out.trim(), "market not synced (height 5 of 10): run hearth status again once it is");
  } finally { node.close(); }
  // A node that takes the connection and never answers.
  const silent = createServer(() => {});
  await new Promise((ok) => silent.listen(0, "127.0.0.1", ok));
  try {
    const root = temp(), token = join(root, "token");
    writeFileSync(token, "t\n");
    for (const k of ["seller", "sponsor"]) ensureKey(sdk, join(root, `hearth/${k}.json`), keyFileJSON);
    const began = Date.now();
    const { code, out } = await hearth(["status", "--node", `http://127.0.0.1:${silent.address().port}`, "--token-file", token, "--key", join(root, "hearth/seller.json")]);
    assert.equal(code, 2, out);
    assert.match(out, /no answer from the node within 15 s/);
    assert.ok(Date.now() - began < 30_000);
  } finally { silent.closeAllConnections(); silent.close(); }
});
