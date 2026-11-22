// What `hearth sell` (bin/hearth.mjs) works out before it runs the seller
// (host/sell-hosting.mjs): which node, which key, and the offer from flags.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reader } from "../client/market.mjs";
import { burnAddress, parentOf, parseOffer, pathFromNexus } from "../client/records.mjs";
import { submit } from "../client/tx.mjs";

export const DEFAULT_MARKET = "Nexus/testnet/lodger-3129cc";
export const DEFAULT_PARENT = "Nexus/testnet";
/** README's example offer, less its price: what `--price` alone sells. */
export const DEFAULT_TERMS = { capacity: 50, maxBlockSize: 1000000, maxStateGrowth: 1000000, minTargetBlockTime: 5000,
  maxNumberOfTransactionsPerBlock: 1000, modules: "any" };
/** How long an offer sells unless its file says (`duration`, in market blocks): 30 days. */
export const DEFAULT_DURATION_MS = 30 * 86400 * 1000;
/**
 * What the seller's sponsor charges for storage unless `--storage-rate`
 * says: bytes per market coin. Pins are kept for good, so it is the rate the
 * testnet's own storage sponsor charges on the market (10 KiB a coin: a
 * megabyte costs about a tenth of a market block's reward).
 */
export const DEFAULT_STORAGE_RATE = 10240;
/** The oldest node Hearth runs beside (`nodeVersion` checks what it brought, not this string). */
export const MIN_NODE = "4.0.1";
const depth = (path) => path.split("/").length;
/** Paths without repeats, parents first. */
export const ordered = (paths) => [...new Set(paths)].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1));

/**
 * The chains the seller's fragment lists: the market, the parents its offers
 * sell under (the operator chose them by running the seller), and each owed
 * chain under one of those, Nexus, or a parent the node hosts for another
 * layer (`others`); never a parent nobody chose.
 */
export function sellerChains({ market, parents = [], owed = [], others = new Set() }) {
  const chosen = new Set(parents);
  const under = (path) => { const up = parentOf(path); return up === "Nexus" || chosen.has(up) || others.has(up); };
  return ordered([market, ...parents.filter((p) => p !== "Nexus"), ...owed.filter(under)]);
}

/**
 * This key's hosting offers still on sale at `height` (`offers`: each
 * offer's newest version, `newestOffers(market().versions)`), each
 * `{ id, parent, until }`. An offer sells until its `until`, or until a
 * version closes it (`hearth stop`).
 */
export function liveOffers(offers, self, height) {
  return [...offers].flatMap(([k, text]) => {
    const [host, id] = k.split("/");
    const o = host === self ? parseOffer(text) : undefined;
    return o && o.until > height ? [{ id, parent: o.parent, until: o.until }] : [];
  });
}

/**
 * The terms its hosting goes by for offer `id`: the offer as written on
 * the market (`offers`) once it is there, else its `file`.
 */
export function currentOffer({ offers, self, id, file }) {
  const o = parseOffer(offers?.get(`${self}/${id}`));
  return o ? { parent: o.parent } : file && { parent: file.parent };
}

/**
 * What to tell the operator while the key holds less than it needs, or
 * undefined: `need` is `{ chain, amount, balance }`, the market coin its
 * writes cost.
 */
export function fundingMessage({ address, need, interval }) {
  if (BigInt(need.balance) >= BigInt(need.amount)) return undefined;
  return `Send at least ${need.amount} coin on ${need.chain} to ${address}, `
    + `from any account that holds some, or earn it with this machine: hearth earn; this seller waits and checks again every ${interval} s.`;
}

const UNITS = { hour: 3600, day: 86400, week: 604800 };

/**
 * The node beside this process, as `lattice` finds it: `--root`, else the
 * current directory; and, since a bare `lattice-node` keeps its storage in
 * ~/.lattice/chains/Nexus, ~/.lattice. The first that holds a running node's
 * cookie (`chains/Nexus/.cookie`, there only while it runs).
 */
export function findRoot({ cwd, home }) {
  const tried = [cwd, join(home, ".lattice")];
  const root = tried.find((dir) => existsSync(join(dir, "chains/Nexus/.cookie")));
  if (!root) throw new Error(`no running Lattice node under ${tried.join(" or ")}: start one (lattice up), or give --root, or --node with --token-file`);
  return root;
}

/** `<coin>/<period>`: the period in market blocks, or `hour`, `day`, `week`. */
export function parsePrice(text) {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*|hour|day|week)$/.exec(text ?? "");
  if (match && [match[1], match[2]].some((n) => /^[0-9]/.test(n) && BigInt(n) > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error(`--price ${text} is past ${Number.MAX_SAFE_INTEGER}`);
  if (!match) throw new Error(`--price is <coin>/<period>, the period in market blocks or hour, day or week (e.g. 100/day), not ${text}`);
  return { price: BigInt(match[1]), period: /^[0-9]/.test(match[2]) ? BigInt(match[2]) : match[2] };
}

/** An offer's `period` in market blocks: blocks as given, or a unit at the market's target block time (ms). */
export function periodBlocks(period, targetBlockTime) {
  if (typeof period === "bigint" || typeof period === "number" || /^[0-9]+$/.test(period)) return BigInt(period);
  if (!(period in UNITS)) throw new Error(`a period is market blocks, or hour, day or week, not ${period}`);
  const blocks = BigInt(Math.round((UNITS[period] * 1000) / Number(targetBlockTime)));
  return blocks > 0n ? blocks : 1n;
}

/** An offer's `duration` in market blocks: as its file gives it, else 30 days at the market's target block time (ms). */
export const durationBlocks = (duration, targetBlockTime) => (duration !== undefined ? BigInt(duration)
  : BigInt(Math.max(1, Math.round(DEFAULT_DURATION_MS / Number(targetBlockTime)))));

/** A whole amount of coin, 1 to the largest exact one. */
export function parseAmount(text, flag) {
  if (!/^[1-9][0-9]*$/.test(text ?? "") || BigInt(text) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${flag} is a whole amount of coin, 1 to ${Number.MAX_SAFE_INTEGER}, not ${text}`);
  return BigInt(text);
}

/**
 * The offer `--price`, `--parent` and `--chains` make, as an offer file
 * holds it. Its id comes from its terms, so the same flags name the same
 * offer, which the seller writes only once.
 */
export function offerFromFlags({ price, parent = DEFAULT_PARENT, chains, id }) {
  const { price: coin, period } = parsePrice(price);
  if (chains !== undefined && (!/^[1-9][0-9]*$/.test(chains) || BigInt(chains) > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error(`--chains is how many chains the offer sells, 1 to ${Number.MAX_SAFE_INTEGER}`);
  const offer = { ...DEFAULT_TERMS, parent, price: Number(coin), period: typeof period === "bigint" ? Number(period) : period,
    ...(chains ? { capacity: Number(chains) } : {}) };
  const terms = JSON.stringify(Object.keys(offer).sort().map((k) => [k, offer[k]]));
  return { id: id ?? `o-${createHash("sha256").update(terms).digest("hex").slice(0, 10)}`, ...offer };
}

// ---- burns ----

/** `chain`, if it is on the path from Nexus down to `market` (where a host's burns are read); else an error. */
export function burnChain(chain, market) {
  const path = pathFromNexus(market);
  if (!path.includes(chain)) throw new Error(`${chain} is not on the path from Nexus to the market (${path.join(", ")}): burns are read only there`);
  return chain;
}

/** `--burn`'s rule: burn what the host's burned total on the chain lacks of `amount`; nothing once it holds that much. */
export const burnShortfall = ({ burned, amount }) => (burned < amount ? amount - burned : 0n);

/**
 * Burns `amount` (or with `atLeast`, only `--burn`'s shortfall) of `chain`'s
 * coin for the key's own address: a plain transfer to its burn address, from
 * the key's confirmed nonce. Until it is in a block, a pass sends the same
 * transaction again (same nonce, same amount), which can land only once.
 * `{ to, burned, amount, tx }`, `burned` the total before it; undefined when
 * nothing is short.
 */
export async function burn({ sdk, node, fetchImpl, privateKey, chain, amount, atLeast = false, fee }) {
  const self = sdk.accountFromPrivateKey(privateKey).address, to = burnAddress(sdk, self);
  const r = reader(sdk, node, { fetchImpl });
  // The nonce and the burned total at one block, so a burn landing between
  // two reads cannot pair the old total with the new nonce.
  const { hash } = await r.api("/api/block/latest", chain);
  const at = async (owner) => { const a = await r.api(`/accounts/${owner}?block=${hash}`, chain); return { balance: BigInt(a.balance), nonce: BigInt(a.nonce) }; };
  const [{ nonce }, { balance: burned }, info] = await Promise.all([at(self), at(to), r.api("/api/chain/info", chain)]);
  const send = atLeast ? burnShortfall({ burned, amount }) : amount;
  if (send === 0n) return undefined;
  const body = sdk.buildTransfer({ from: self, to, amount: send, fee: BigInt(fee ?? info.minRelayFee ?? 1), nonce, chainPath: chain.split("/") });
  try {
    return { to, burned, amount: send, tx: await submit(sdk, node, body, privateKey, fetchImpl) };
  } catch (e) {
    throw /invalidState/.test(e.message) ? new Error(`${chain} isn't synced yet on this node, or the key has no coin there (${e.message})`) : e;
  }
}

// ---- the node ----

/**
 * The node's loopback port beside `root`: the configuration's `rpc` as the
 * node merges it (`lattice config get rpc`, which Lattice 4.0.1 brought).
 * When that fails, lattice.json's port is read only to check the node
 * (`nodeVersion`): a node too old fails with what it is, any other
 * with why `lattice config` failed.
 */
export function rpcPort(root, lattice = "lattice", fetchImpl = (...a) => fetch(...a)) {
  return new Promise((ok, fail) => execFile(lattice, ["config", "get", "rpc", "--root", root], { timeout: 120_000 }, (error, stdout, stderr) => {
    if (!error) { try { return ok(Number(JSON.parse(stdout))); } catch (e) { return fail(new Error(`${lattice} config get rpc: ${e.message}`)); } }
    const why = new Error(error.code === "ENOENT" ? `${lattice} is not on PATH: give --lattice <path>` : `${lattice} config get rpc: ${error.message}\n${stderr}`);
    let port;
    try { port = JSON.parse(readFileSync(join(root, "lattice.json"), "utf8")).rpc ?? 8080; } catch { return fail(why); }
    nodeVersion(`http://127.0.0.1:${port}`, fetchImpl).then(() => fail(why), fail);
  }));
}

/**
 * The node's version (as its operator `GET /status` reports it, for the
 * operator to read), once it has what Hearth needs: `GET /config` saying
 * which layer lists each chain it hosts (`status.chains[].from`), which
 * came with Lattice 4.0.1 beside `lattice config` fragments and `POST
 * /chains`. An error naming the version when it has not.
 */
export async function nodeVersion(url, fetchImpl = (...a) => fetch(...a)) {
  const [config, status] = await Promise.all(["/config", "/status"].map(async (route) => {
    const response = await fetchImpl(new URL(route, url));
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GET ${route}: HTTP ${response.status}`);
    return response.json();
  }));
  const chains = config?.status?.chains;
  if (!Array.isArray(chains) || !chains.length || !chains.every((c) => Array.isArray(c.from))) {
    throw Object.assign(new Error(`Hearth needs Lattice ${MIN_NODE} or newer (you have ${status?.version ?? "an older one"}: its GET /config does not say which layer lists each chain)`), { tooOld: true });
  }
  return status?.version ?? "unknown";
}

/**
 * How far the node's sync of a chain is, from its operator
 * `GET /status?chainPath=`: `{ synced, height, best, line }`. Synced once
 * its tip is at the best header it knows from its peers; not before it knows
 * one.
 */
export function syncProgress(status, label = "market") {
  const height = status?.height === undefined || status?.height === null ? undefined : BigInt(status.height);
  const best = status?.bestHeaderHeight === undefined || status?.bestHeaderHeight === null ? undefined : BigInt(status.bestHeaderHeight);
  const synced = height !== undefined && best !== undefined && height >= best;
  return { synced, height, best, line: `syncing ${label}: ${height ?? 0} / ${best ?? "?"}` };
}

/** `syncProgress` of `chain` on the node at `url`; a chain the node does not host yet is not synced. */
export async function chainSync(url, chain, fetchImpl = (...a) => fetch(...a), label = chain) {
  const u = new URL("/status", url);
  u.searchParams.set("chainPath", chain);
  const response = await fetchImpl(u);
  if (response.status === 404) return { synced: false, line: `waiting for the node to host ${chain}` };
  if (!response.ok) throw new Error(`GET /status?chainPath=${chain}: HTTP ${response.status}`);
  return syncProgress(await response.json(), label);
}

/** Waits until the node has synced `chain`, printing its progress as it changes. */
export async function waitSynced(url, chain, { fetchImpl, log = console.log, every = 5000, label } = {}) {
  let last;
  for (;;) {
    const s = await chainSync(url, chain, fetchImpl, label);
    if (s.synced) return s;
    if (s.line !== last) log((last = s.line));
    await new Promise((r) => setTimeout(r, every));
  }
}

/** The node's secret: an operator token from `tokenFile`, else the cookie beside `root`. */
export const nodeSecret = ({ root, tokenFile }) => tokenFile
  ? readFileSync(tokenFile, "utf8").trim()
  : readFileSync(join(root, "chains/Nexus/.cookie"), "utf8").trim().replace(/^[^:]*:/, "");

/**
 * The node's operator API at `url` (a string, or a function giving it):
 * `rpc(path, body?, method?, headers?)` → `{ body, etag }`, an error with
 * the `status` when the answer is not ok.
 */
export const operatorRPC = (url, fetchImpl) => async (path, body, method = body === undefined ? "GET" : "POST", headers = {}) => {
  const init = { method, headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  const response = await fetchImpl(new URL(path, typeof url === "function" ? url() : url), init);
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`), { status: response.status });
  return { body: text ? JSON.parse(text) : {}, etag: response.headers.get("ETag") };
};

/** `fetch` with the node's secret, read again for each request. */
export const authedFetch = (secret) => (input, init = {}) => fetch(input, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${secret()}` } });

/**
 * The key at `path`, created with mode 0600 if there is none, in the
 * format `lattice key generate` writes (address, privateKey, publicKey).
 */
export function ensureKey(sdk, path, keyFileJSON) {
  let created = false;
  if (existsSync(path) && (statSync(path).mode & 0o077)) throw new Error(`the key ${path} is readable by others: chmod 600 ${path}`);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, keyFileJSON(sdk, sdk.generatePrivateKey()), { mode: 0o600, flag: "wx" });
    created = true;
  }
  const privateKey = sdk.hexToBytes(JSON.parse(readFileSync(path, "utf8")).privateKey);
  return { address: sdk.accountFromPrivateKey(privateKey).address, created };
}

/** `name` as a shell finds it on `PATH` (`command -v`), without resolving links, or undefined. */
export function onPath(name, PATH = process.env.PATH ?? "") {
  return PATH.split(":").filter(Boolean).map((dir) => join(dir, name)).find((p) => { try { return statSync(p).isFile() && (statSync(p).mode & 0o111); } catch { return false; } });
}

// Runs "$@", passing launchd's TERM on, and exits as it did, but 0 for 78.
const EXIT_78_IS_0 = '"$@" & p=$!; trap \'kill -TERM "$p"\' TERM INT; while :; do wait "$p"; s=$?; kill -0 "$p" 2>/dev/null || break; done; [ "$s" -eq 78 ] && exit 0; exit "$s"';
const ONLY_ON_FAILURE = "<dict><key>SuccessfulExit</key><false/></dict>";
const xml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
// systemd expands `%` specifiers and `$` variables in every word, quoted or not.
const systemdWord = (s) => {
  const w = s.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /^[A-Za-z0-9_@%$+=:,./-]+$/.test(w) ? w : `"${w.replace(/(["\\])/g, "\\$1")}"`;
};

/**
 * Units that keep the node (`nodeCommand`, `lattice up --root <root>`) and
 * the seller (`command`) running, the seller after the node, for `platform`
 * (`linux`: systemd user units; `darwin`: two launchd agents, labels
 * `net.hearth.node` and `net.hearth.seller`), the one command that loads
 * them, and when they run. Nothing is written or loaded here.
 *
 * The node is restarted as `lattice up` asks: on a failure exit, which
 * includes 75 (`lattice restart`), but not 0 (`lattice down`) nor 78 (an
 * invalid configuration). launchd cannot exempt one exit status, so its
 * agent runs the node under `/bin/sh`, which exits 0 for 78. The seller is
 * restarted on a failure, not when it exits 0 (after `hearth stop`, once
 * nothing paid is left).
 */
export function serviceUnits({ platform, home, command, nodeCommand, path }) {
  if (platform === "linux") {
    const dir = join(home, ".config/systemd/user");
    return {
      units: [
        ...(nodeCommand ? [{ file: join(dir, "hearth-node.service"), content: `[Unit]
Description=Lattice node for Hearth

[Service]
ExecStart=${nodeCommand.map(systemdWord).join(" ")}
Environment=${systemdWord(`PATH=${path}`)}
Restart=on-failure
RestartPreventExitStatus=78
TimeoutStopSec=90

[Install]
WantedBy=default.target
` }] : []),
        { file: join(dir, "hearth.service"), content: `[Unit]
Description=Hearth seller: sells hosting from this Lattice node${nodeCommand ? `
After=hearth-node.service
Requires=hearth-node.service` : ""}

[Service]
ExecStart=${command.map(systemdWord).join(" ")}
Environment=${systemdWord(`PATH=${path}`)}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
` },
      ],
      load: `loginctl enable-linger $USER && systemctl --user daemon-reload && systemctl --user enable --now ${nodeCommand ? "hearth-node.service " : ""}hearth.service`,
      note: "enable-linger keeps your user's services running without a login, and starts them at boot. "
        + "If your node already runs under another service, enable only hearth.service and drop its Requires= line: two nodes cannot share a root.",
    };
  }
  if (platform === "darwin") {
    const agent = (label, argv, log, keepAlive) => ({ file: join(home, `Library/LaunchAgents/${label}.plist`), content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>${keepAlive}
  <key>StandardOutPath</key><string>${xml(join(home, `Library/Logs/${log}`))}</string>
  <key>StandardErrorPath</key><string>${xml(join(home, `Library/Logs/${log}`))}</string>
</dict>
</plist>
` });
    const units = [
      ...(nodeCommand ? [agent("net.hearth.node", ["/bin/sh", "-c", EXIT_78_IS_0, "lattice-up", ...nodeCommand],
        "hearth-node.log", ONLY_ON_FAILURE)] : []),
      agent("net.hearth.seller", command, "hearth.log", ONLY_ON_FAILURE),
    ];
    return {
      units,
      load: units.map((u) => `launchctl bootstrap gui/$(id -u) ${u.file}`).join(" && "),
      note: "launchd has no ordering between agents: the seller waits for the node itself. Launch agents run while you are logged in. "
        + "To run them from boot instead, copy them to /Library/LaunchDaemons, add <key>UserName</key><string>$USER</string> to each, "
        + "and load each with: sudo launchctl bootstrap system /Library/LaunchDaemons/<label>.plist. "
        + "If your node already runs under another service, load only net.hearth.seller: two nodes cannot share a root.",
    };
  }
  throw new Error(`--install knows systemd (Linux) and launchd (macOS), not ${platform}`);
}

/** The installed seller service in `home`, if there is one, and the command that stops it for good. */
export function installedSeller({ platform, home }) {
  if (platform === "linux") {
    const file = join(home, ".config/systemd/user/hearth.service");
    return existsSync(file) ? { file, stop: ["systemctl", "--user", "disable", "--now", "hearth.service"] } : undefined;
  }
  if (platform === "darwin") {
    const file = join(home, "Library/LaunchAgents/net.hearth.seller.plist");
    return existsSync(file) ? { file, stop: ["launchctl", "bootout", `gui/${process.getuid()}/net.hearth.seller`] } : undefined;
  }
  return undefined;
}

/**
 * Where the seller beside a node keeps its pid; once `hearth stop` has
 * closed its offers, its `closing` mark; and after `hearth sell --install`,
 * its `reopen` mark: `<root>/hearth` (beside the node, whatever key it runs
 * with), or with a remote node beside the key.
 */
export const sellerFiles = ({ root, key }) => {
  const dir = root ? join(root, "hearth") : dirname(key);
  return { dir, pid: join(dir, "seller.pid"), closing: join(dir, "closing"), reopen: join(dir, "reopen") };
};

/**
 * The operator put the offer on sale again (`hearth sell`, or `--install`
 * for the service's next start): the seller stops closing and writes a
 * version from its file once.
 */
export function markReopen(files) {
  mkdirSync(files.dir, { recursive: true });
  rmSync(files.closing, { force: true });
  writeFileSync(files.reopen, `${new Date().toISOString()}\n`);
}

/** `hearth stop`: the seller is closing, and an `--install` not yet acted on is void. */
export function markClosing(files) {
  mkdirSync(files.dir, { recursive: true });
  rmSync(files.reopen, { force: true });
  writeFileSync(files.closing, `${new Date().toISOString()}\n`);
}

/**
 * Whether this seller writes a version from its file once: started by the
 * operator (not `--resume`), or by a service after `--install`'s `reopen`
 * mark, which this reads once and deletes. Either way it is no longer
 * closing.
 */
export function startsReopened({ resume, files }) {
  const reopen = !resume || existsSync(files.reopen);
  rmSync(files.reopen, { force: true });
  if (reopen) rmSync(files.closing, { force: true });
  return reopen;
}

/**
 * What lattice-sponsor keeps beside its storage file (`dir`), as sweeping
 * must leave it: `holds`, the fees of sponsored transactions signed and not
 * yet landed (`lattice-sponsor-holds.json`), and `funds`, coin others
 * deposited to the sponsor's account (`lattice-sponsor-funds.json`). Each
 * absent file is none.
 */
export function sponsorBooks(dir) {
  const read = (name) => { const f = join(dir, name); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : []; };
  return {
    holds: read("lattice-sponsor-holds.json").map((h) => ({ chain: h.chain, signer: h.signer, nonce: BigInt(h.nonce), fee: BigInt(h.fee) })),
    funds: read("lattice-sponsor-funds.json").map((f) => ({ chain: f.chain, deposit: BigInt(f.deposit) })),
  };
}

/**
 * What a sweep of `chain` leaves the sponsor's key `self`: the float, the
 * fees it holds for transactions it signed, and every fund deposit there.
 */
export const sweepReserve = ({ chain, self, float, holds = [], funds = [] }) => float
  + holds.filter((h) => h.chain === chain && h.signer === self).reduce((sum, h) => sum + h.fee, 0n)
  + funds.filter((f) => f.chain === chain).reduce((sum, f) => sum + f.deposit, 0n);

/**
 * Moves what the sponsor's key holds on `chain` above `sweepReserve` to
 * `to` (the seller's address), less the fee: the blocks the pacer makes pay
 * the sponsor's key, which spends a float on its clients' fees. Run it only
 * while lattice-sponsor is stopped (it signs with the same key). Refuses
 * while a sponsored transaction it signed may still take a nonce. Undefined
 * when nothing is above the reserve; else `{ amount, balance, reserve, tx }`.
 */
export async function sweep({ sdk, node, fetchImpl, privateKey, to, chain, float, fee, holds = [], funds = [] }) {
  const self = sdk.accountFromPrivateKey(privateKey).address;
  const r = reader(sdk, node, { fetchImpl });
  const [{ balance, nonce }, info] = await Promise.all([r.account(chain, self), r.api("/api/chain/info", chain)]);
  if (holds.some((h) => h.chain === chain && h.signer === self && h.nonce >= nonce)) {
    throw new Error(`the sponsor signed transactions on ${chain} that have not landed yet: sweep once they have`);
  }
  const cost = BigInt(fee ?? info.minRelayFee ?? 1);
  const reserve = sweepReserve({ chain, self, float, holds, funds });
  const amount = balance - reserve - cost;
  if (amount <= 0n) return undefined;
  const body = sdk.buildTransfer({ from: self, to, amount, fee: cost, nonce, chainPath: chain.split("/") });
  return { amount, balance, reserve, tx: await submit(sdk, node, body, privateKey, fetchImpl) };
}
