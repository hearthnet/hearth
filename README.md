# Hearth

A home for your chain.

Launch a chain without running a node. You buy coin, mint your chain's
genesis in your browser (with its proof of work, trivial at a genesis's
easiest target), and pay a host by the period to run it: the order carries
the genesis, and the host stores it and every block after it, and mines it. Anyone can check
what each host's blocks did.

Hosts mine every chain they host, all the time, with all their hash rate,
paid to their sponsor's key. Anyone else may mine a chain too, for its block
reward.

There is no server. The market is a chain with a policy; the page reads it
from any node that hosts it and checks every record against its CID.

The v3 market runs on testnet at `Nexus/testnet/hearth`
(`chain/market-v3-testnet.json`). The mainnet market `Nexus/hearth`
(`chain/market.json`) is the old one until it is launched again; this
version of `hearth` does not sell on it.

## Sell hosting in one command

Why host: to earn Hearth coin (the market's coin), which pays for hosting
and storage from any seller. Buyers' orders pay the seller's key; the
blocks it makes pay its sponsor's key, 1,000 coin a market block.

You need Node.js 22 or later, on macOS (Apple silicon) or Linux (x86-64):

```
npx @hearthnet/hearth sell        # [--throughput 60] [--storage 6] [--period 1d] [--hashrate <hashes/s>] [--id 1]
```

Hearth runs the node it sells from. The first time, it downloads a pinned
node and sponsor into `~/.hearth/bin` (each checked against the SHA-256 in
`host/runtime.mjs`), makes the node in `~/.hearth/node`, and runs it
while `hearth sell` sells (its log is `~/.hearth/node/node.log`); stop the
seller and the node stops with it. Other `hearth` verbs use that node while
it runs, or start it for as long as they take. It listens on port 4001 for peers and serves
its operator API on 127.0.0.1:8080. To use a node you run yourself instead,
give `--root` (its root) or `--node` with `--token-file`.

**The first sync of Nexus and the market takes a few minutes.** Until the
node has synced the market, the seller prints `syncing market: h / H` (its
tip against the best header its peers showed) and reads, funds, writes and
burns nothing.

It finds the node: `--root`, else the current directory, else `~/.lattice`,
whichever holds a running node's `chains/Nexus/.cookie`; with none, Hearth's
own (above). A node of your own there that is not running stops it ("the node
at <dir> is not running"); only `hearth sell` makes Hearth's node, and the
other verbs, on a machine that sold nothing, say so. Beside a node
of your own it checks that the node has what it needs (`GET /config` saying
which layer lists each chain) and stops with "Hearth needs node 5.1.0 or
newer (you have X: ...)" beside an older one, X as `GET /status` reports it. It makes the seller's key at
`<root>/hearth/seller.json` (mode 0600; it prints the address, never the
key, and refuses a key file others can read) unless there is one, has the
node host the market (`Nexus/testnet/hearth` unless `--market` says, and
the chains above it), then sells in the foreground. A bad flag, or a
`--root` where no node lives ("no node at <root>"), stops it before it
writes anything. Every verb takes `--help`.

**The offer.** `offer/<seller>/<id>` (`--id`, default `1`) is five lines,
which the seller writes and changes in place:

```
hashrate 5000000      hashes per second it mines with, over every chain it hosts
throughput 60         coin per kB/s of block capacity (maxBlockSize / targetBlockTime), per period
storage 6             coin per kB of maxStateGrowth, per period
period 1440           market blocks a period lasts
blocks bafyrei...     the address its blocks pay: its sponsor's key
```

`--throughput` and `--storage` are whole market coin; `--period` is market
blocks, or hours, days or weeks (`12h`, `1d`, `2w`) at the market's block
time. The hash rate is `--hashrate`, else what its miner measured over its
first minute: the offer waits for it. A buyer pays for every chain on its
chain's path, Nexus included, each by its own spec: at the defaults a
small chain (20 kB blocks every 30 s, 10 kB of state growth) costs 40 + 60
= 100 a day itself, and its parents far more: under `Nexus/testnet` the
whole path comes to about 25,000 a day. The seller rewrites the offer whenever the flags'
terms or the address its blocks pay differ from what the market says (a
measured hash rate is written once, not again as it wanders). An order
asserts the offer's text unchanged, so an order priced at the old terms
does not land after a change.

**Funding.** The key needs market coin for its offer and its close (two
fees). The miner pays the sponsor's key the blocks it makes, so beside the
node the seller moves those fees from the sponsor's key to its own before it
starts the sponsor, so nothing else signs with that key. It waits until
that key holds three fees (the two it moves and the move's own fee); until
then it says it waits for block rewards, or that you may send the coin or
earn it with `hearth earn` (below), and checks again each `--interval`. It
moves nothing if any sponsor already answers on `--sponsor-port` (it could
sign with the same key), and says so. With `--node`, or once its offer is
out, it only says what to send, earn or sweep.

**Orders.** Each pass, at the market's tip, the seller reads its orders and
judges them as every reader does (`client/verdict.mjs`): an order is owed at
once, from the block it landed in, for the periods it paid for, or void. A
seller hosts any path: for each owed chain it lists the chain and every
chain above it (but Nexus) in its fragment of the node's configuration
(below), then launches the chain from the genesis the order carries
(`host/launch.mjs`): it pins the genesis's Volumes and policy modules on the
node (`POST /pins`) and submits the genesis block with the child-only proofs
the buyer mined (`POST /child-blocks`), each pass until the node weighs it.

**Status.** Each pass prints both keys' balances on the market, the
seller's orders and renewals by verdict, the coin other buyers paid for
hosting it owes (`earned`: owed orders and their renewals; void orders and
the seller's own count for nothing), the chains it owes hosting to and
until which market block, and the storage its sponsor has pinned against
its budget (its `GET /terms`; not read with `--node`, whose sponsor runs
beside the remote node). `hearth status` prints the same once, with a
deadline on every read: it never waits for a sync, and says `market not
synced (height X of Y)` instead.

**Blocks.** The seller mines every chain the node hosts, all the time
(`host/pace.mjs`): each batch asks the node for a template paying every
level to the sponsor's key, searches it, and submits each hit. One hash
makes a block on every carried chain whose target it clears, so each chain
gets all of the seller's hash rate, and its difficulty settles where that
rate makes its blocks on time. It logs the hash rate it measures each
minute.

**Rewards.** The block rewards accumulate in the sponsor's key, on every
chain the miner makes blocks of (each level of the template pays it), and
fund the fees its clients pay with work. `hearth sweep [--float 100]
[--chain <path>]` moves what it holds on one chain (the market by default)
to the seller's address, leaving the float, the fees it holds for
transactions it signed and any fund deposits (the sponsor's
`lattice-sponsor-holds.json` and `lattice-sponsor-funds.json`). It signs
with the sponsor's key, so it refuses while the seller or a
sponsor on `--sponsor-port` runs, and while a transaction the
sponsor signed there has yet to land; it says how to pause the seller (its
service, or the process) without `hearth stop`, which would close the
offer.

**Sponsor.** Beside the node the seller runs the sponsor, and starts it
again, with backoff, whenever it exits. Its key is
`<root>/hearth/sponsor.json` (mode 0600), never the seller's: a co-signature
lends the key's authority to a draft, so it must own nothing but its float,
which the miner's blocks pay. It pays fees for clients who pay with
proof-of-work shares, and sells pins for work at `--storage-rate`
bytes per market coin (default 10240: pins are kept until the operator takes them down, so a megabyte costs about a
tenth of a market block's reward), up to `--storage-budget` bytes pinned at once
(`256M` by default; `K`, `M`, `G`, `T` are binary), on `--sponsor-port`
(default 8650). Pins are served from the node's IP. `hearth unpin <cid>`
takes a file down: the sponsor's `POST /takedown`, with the node's cookie,
unpins it, frees its bytes and refuses the CID from then on; its buyer loses
the rest of its time, with no refund (it needs a sponsor with the
takedown route).
Without `--sponsor-url` it listens on loopback only. With
`--sponsor-url https://host.example/sponsor` it listens on every interface
(put TLS in front of the port). The offer never names the sponsor:
sponsorship is a service of its own beside the market. With `--node`
(a remote node) it runs no sponsor: a sponsor reaches a node only on
its loopback, so run it there.

**Reachable.** When Hearth runs the node and the seller gives neither
`--key-only` nor `--sponsor-url`, `hearth sell` makes the node reachable: it
sets the node's public read port (`publicRead` 8082, taking writes), runs a
local proxy that serves that port and the sponsor under `/sponsor`, and opens
a Cloudflare quick tunnel to it (cloudflared, pinned and checked like the
node; no account). It prints the tunnel's `https://….trycloudflare.com` URL,
which changes each time it starts; nothing on the market names it. With a
node of your own (`--root`, or one found beside), the tunnel is `--public`,
and the node must already have `publicRead` and `publicSubmit` set; Hearth
says how.

**Keep it running.** `--install` writes units for both the node
(Hearth's own, or the one at `--root`) and the seller, the seller after the node:
systemd user units on Linux (`~/.config/systemd/user/hearth-node.service`,
and `hearth.service` with `After=` and `Requires=` on it), or two launchd
agents on macOS (`~/Library/LaunchAgents/net.hearth.node.plist` and
`net.hearth.seller.plist`; launchd has no ordering, so the seller waits for
the node itself). The node is started again after a failure exit, which
a restart is, but stays down after a clean stop and after exit 78
(an invalid configuration; launchd cannot exempt one exit status, so the
node's agent runs it under `/bin/sh`, which exits 0 for 78). The seller is
started again after a failure, not after it exits 0 (when `hearth stop` has
nothing paid left to serve). The units name no `network-online.target`,
which a user's service manager does not have. It loads nothing itself and prints the exact commands that do. On
Linux they start with `loginctl enable-linger $USER`, which keeps them
running without a login. A launch agent runs while you are logged in; for
boot, it says how to make them LaunchDaemons. If your node already runs
under another service, load only the seller's.

**Stopping.**

```
npx @hearthnet/hearth stop [--now]
```

deletes every offer of the key, once the market is synced, so no order
lands on it again; orders already in a block are owed. It waits (up to ten
market blocks) for the deletion to land, and says which chains have paid
time left and when the last ends. The seller keeps running, closing: it
writes no offer, and keeps hosting, mining and sponsoring each chain with
paid time until that ends; then it deletes its fragment and exits. The pid
and the `closing` mark live in `<root>/hearth`, so `hearth stop` finds the
seller whatever key it runs with; the installed service (`--resume`) stays
closing across restarts, and `hearth sell` (or `--install`) sells again.
With no seller running it rewrites the seller's fragment to the paid chains
and says to start the seller with `--resume` to serve them. `--now` stops
the seller (its installed service, else the process), and its miner and
sponsor with it, and stops hosting at once; it says what buyers lose: the
rest of the time they paid for, with no refund, and their chains get no more
blocks or sponsored writes from this host.

## Earning market coin

```
npx @hearthnet/hearth earn [--until <coins>] [--workers 1] --sponsor <url>
```

earns market coin for the seller's address with this machine's processor,
through a fee sponsor's payouts (the sponsor's *Payouts*): `POST /work`
naming the address as `payTo`, each share back through `POST /shares`, and
the sponsor pays the address in coin once its earnings reach its payout
(`GET /earnings`). It stops once the address holds `--until` coins on the
market (by default enough for the seller's offer and its close: two
fees), which it reads from the node once the node has synced the market;
until then it prints the sponsor's book. `--sponsor` names the sponsor (its
`/sponsor` URL); there is no default. Each of the
`--workers` threads waits out an answer of 429 for its `Retry-After`, else
for a backoff.

## Checking a host

An offer's `hashrate` is only a claim. Its `blocks` line names the address
its blocks pay, so a buyer reads what a host's blocks did on its own node:
`creditedHashrate` in `client/mining.mjs` sums the work (2^256 / (target + 1)
a block) each address is credited on a chain.

## Burns

A new host has no record. It can show it has something at stake by burning
coin: sending it to an address nobody can spend from, named for the host,

```
burnAddress(host) = CID(DAG-CBOR { domain: "lattice burn v1", host })
```

(`burnAddress` in `client/records.mjs`). No key has that address (an
account's address is the CID of `{ key }`), so the coin there is gone. The
burned total is that address's balance (`GET /api/state/account/<burn
address>?chainPath=<path>`), 0 if it has never been used. Burns count on each
chain from Nexus down to the market (`Nexus`, then the market),
each in its own coin: the Hosts page shows them per chain and never adds them
up. Anyone can burn for a host: it is a plain transfer to its burn address. A
burn costs whoever made it; it says nothing about how a host serves.

```
npx @hearthnet/hearth burn 300 --chain Nexus              # burns 300 now, from the seller's key
npx @hearthnet/hearth sell --burn 5000                     # burns once, up to 5000 burned on the market
```

`hearth burn <coin> --chain <path>` sends a transfer from the seller's key to
its burn address on that chain (refused off the path from Nexus to the
market) and prints the transaction and the burned total. `hearth sell --burn
<coin> [--burn-chain <path>]` (default the market) burns once, up to a burned
total of `<coin>`: it sends only what the total is missing, and nothing once
the total is reached, whoever burned it, so running it again never burns
again. It reads the key's nonce and the burned total at the same block. Until the burn is in a block,
each pass sends the same transaction (same nonce, same amount), which can
land only once.

### Selling the coin you earn

Hosting earns the market's coin (Hearth coin): orders pay the seller's key,
and blocks pay its sponsor's key (`hearth sweep` moves that to the seller's).
Spend it on hosting or storage, or sell it on the chains' own exchange, where
buyers find it on the app's Buy coin page.

```
npx @hearthnet/hearth sell-coin 300000 --price 3000 [--float 100]
```

`hearth sell-coin <coin> --price <parent coin>` locks `<coin>` of the seller
key's market coin as a deposit demanding `<parent coin>` on the
market's parent (Nexus/testnet for the default market), for all of it. It
checks every amount, and refuses to leave the key less than `--float` for its
fees, before it signs. Like `hearth sweep`, it refuses while the seller or
a sponsor on `--sponsor-port` runs. A retry that finds an open
deposit of the same amount and price prints it and sends nothing (`--again`
locks another). The deposit's nonce is the key's account nonce, so its
identity is new and sending it again is the same transaction. A buyer's
payment on the parent credits the seller's own address there directly:
nothing to claim. `hearth status` lists, in bounded reads, the key's deposits (and who paid for
each, until they take the coin), the market's cheapest coin on sale, and the
key's parent-chain balance. There is no cancel or refund: an unsold
deposit comes back only the way any buyer takes it, the seller paying its
price to its own address on the parent (a fee on each chain).

## How it works

**Buying coin.** Hosts are paid in the market chain's own coin. Sellers lock
coin on the market chain for a price in the parent chain's coin (a
*deposit*). A buyer pays that price on the parent (a *receipt*) and takes the
coin on the market chain (a *withdrawal*). The chains check both sides, so
nobody holds the payment in between, and there is no exchange to trust.
Where a fee sponsor pays out the parent's coin, it can
also be earned with the device's processor.

**Records.** The policy (`policy/src/lib.rs`) filters only keys and coin;
it never reads a record's value.

| Key | Written by | Value (read off chain) |
|---|---|---|
| `offer/<host>/<id>` | the host: written, changed in place, deleted to close | the five lines above |
| `order/<host>/<id>/<payer>/<n>/<paid>/<path>` | the payer, once; pays the host `<paid>` and asserts the offer unchanged in the same transaction | the genesis as the buyer minted it (its CID, its Volumes and policy modules, and its child-only proofs), or `renew` to pay for more time |

**Verdicts** (`client/verdict.mjs`, the same module in the host and the
page), final once the order is in a block, at the offer's terms in that
block:

- **void**: a path that is not under Nexus or is the market or a chain
  above it; a genesis that does not check out (its Volumes not exactly its
  own, a spec out of range, or proofs that do not prove this block at this
  path); another genesis landing at that offer and path while the genesis
  holding it there is still paid for; or less than one period paid for the whole path (a
  renewal too); an order that cannot be judged is void, never the rest;
- **owed**: from the block it landed in, for `floor(paid / price)` periods,
  the price summed over every chain on its path by each chain's spec;
  renewals add time from where it ends.

The specs above a path are read from the reader's node, else from the
nodes it lists for the chain (`client/chains.mjs`), by the page and the
seller alike. The prices of chains above a path that the seller's or the
page's own node does not host are read from nodes the network lists, and
trusted (read again every ten minutes).

The market records only what each seller is paid to run. Which genesis
holds a path is the chains' to decide (its work), not the market's. A buyer
may also commit the genesis to the parent chain to secure the name; the app
does not build that commitment yet.

`chain/spec-v3-testnet.json` and `chain/policy-v3.wasm` (this repo's build
of `policy/src`) make the v3 market, the spec naming the module by its own
CID; `chain/market-v3-testnet.json` holds its path, genesis and module CID.

**Hosts** run `host/sell-hosting.mjs` (what `hearth sell` runs) as a client
of a node's operator API. Its own fragment of the node's configuration,
`hostmarket` (`config.d/hostmarket.json`), lists the market and every chain
it owes, with the chains above each, written with one
`PUT /config/fragments/hostmarket` sent with the version it read. A lapsed
chain is left out: the node stops it unless another layer (the operator's,
the deploy's) lists it, and what it stored stays, but for the genesis pins
no owed chain needs, which the seller unpins (`DELETE /pins/<cid>`). The node never restarts
for it.

Beside the node (loopback and its cookie):

```
node host/sell-hosting.mjs --root /var/lib/lattice --market Nexus/testnet/hearth \
  --key host.json [--throughput 60] [--storage 6] [--period 1d] [--hashrate <n>] --lattice /usr/local/bin/lattice \
  [--sponsor-bin lattice-sponsor] [--sponsor-port 8650] [--sponsor-url https://host.example/sponsor] [--storage-rate 10240]
```

From anywhere else, through the node's operator listener (`operatorListen`
in its configuration) with a token made for it:

```
node host/sell-hosting.mjs --node http://10.0.0.5:8090 --token-file seller.token \
  --market Nexus/testnet/hearth --key host.json
```

Of the node's operator API, the seller uses `GET /config`,
`GET`/`PUT /config/fragments/hostmarket` (`hearth stop` also `DELETE`),
`POST /pins` and `POST /child-blocks` (with `proofs`: node 5.1.0 or
newer). It also reads the node's version and sync
(`GET /status`), the market and the chains it hosts (`GET /api/...`),
submits its writes (`POST /transactions`) and mines (`POST /mining/templates`,
`POST /mining/work`); a token for all of it is simplest made `admin`
(`lattice tokens create seller --role admin --out seller.token --root /var/lib/lattice`).
A token that may write a fragment may set any key in it, so it controls the
node nearly as fully as `admin` does anyway.

## What a buyer does not get

The chain's mining rewards (they go to whoever makes its blocks: the host's
sponsor, or other miners);
blocks after `hearth stop --now` (`hearth stop` keeps paid chains hosted
and mined until their time ends);
protection from a heavier rival chain at the same path; a refund; proof the
host stores rather than relays; a record of past uptime.

## Tests

```
cd policy && RUSTFLAGS="--remap-path-prefix=$HOME=/home --remap-path-prefix=$PWD=/hearth/policy" \
  cargo build --release --target wasm32-unknown-unknown && node --test test/policy.test.mjs
npm test                                                               # verdicts, hearth sell, the miner, launch, earn, burns, sell-coin
LATTICE=<lattice-node>/.build/debug/lattice SPONSOR=<lattice-sponsor>/.build/debug/lattice-sponsor \
  node test/e2e-seller.mjs                                             # hearth sell mines, writes its offer and sponsors; hearth stop
```

`vendor/` holds two builds of lattice-sdk at commit `258dc92`.
From a clean clone, run `npm ci && npx tsc -b`. Then build each file with esbuild:

```
# vendor/lattice-sdk.js: Node and the app, from the clone's root
echo "export * from './packages/core/dist/index.js'; export * from './packages/client/dist/index.js'; export * from './packages/relay/dist/index.js'; export * from './packages/volumes/dist/index.js';" \
  | npx esbuild --bundle --format=esm --target=es2022 --platform=node --outfile=lattice-sdk.js
# vendor/lattice-browser.js: connect, from packages/sdk
cd packages/sdk && npx esbuild dist/index.js --bundle --format=esm --target=es2022 --outfile=lattice-browser.js \
  "--banner:js=/*! Lattice SDK, browser build | MIT License | Copyright (c) 2026 The Lattice Authors | Includes @noble/hashes and @noble/ed25519, MIT License, Copyright (c) Paul Miller */"
```

Two builds of a commit are byte-identical.

