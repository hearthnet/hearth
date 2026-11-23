# Hearth

A home for your chain.

Launch a Lattice chain without running a node. You buy coin, pay a host by
the period, and the host runs your chain: it builds the genesis from your
spec, stores it and serves it at a public URL. Anyone can check which hosts
serve what they sold.

Hosts also make their chains' blocks. Every host paces the market and each
chain it sells: one block per target block time, about one hash each, paid to
its sponsor's key. Anyone else may mine a chain too, for its block reward.

There is no server. The market is a Lattice chain with a policy; the page
reads it from any node that hosts it, checks every record against its CID,
and probes each host from your browser.

## Sell hosting in one command

Why host: to earn Hearth coin (the market's coin), which pays for hosting
and storage from any seller. Buyers' orders pay the seller's key; the
blocks it makes pay its sponsor's key, 1,000 coin a market block.

You need a running Lattice node, **4.0.1 or newer** (`lattice up`),
lattice-sponsor on your `PATH` (see <https://lattice.build/docs/> for where
to get it, or give `--sponsor-bin`), and Node.js 22 or later. In the node's root (or with `--root`):

```
npx @hearthnet/hearth sell                  # 10000 Hearth coin a day per chain; --price to choose
```

**The first sync of testnet takes about 1–2 hours and ~1.5 GB.** Until the
node has synced the market, the seller prints `syncing market: h / H` (its
tip against the best header its peers showed) and reads, funds, writes and
burns nothing.

It finds the node: `--root`, else the current directory (as `lattice`
does), else `~/.lattice` (where a bare `lattice-node` keeps its storage),
whichever holds a running node's `chains/Nexus/.cookie`. It checks that the
node has what it needs (`GET /config` saying which layer lists each chain,
`status.chains[].from`, which Lattice 4.0.1 brought) and stops with "Hearth
needs Lattice 4.0.1 or newer (you have X: ...)" beside an older one, X as
`GET /status` reports it. It makes the seller's key at
`<root>/hearth/seller.json` (mode 0600; it prints the address, never the
key, and refuses a key file others can read) unless there is one, has the
node host the market (`Nexus/testnet/lodger-3129cc`) and the offer's parent
(`--parent`, default `Nexus/testnet`), writes the offer (10,000 market coin
per day unless `--price` says, converted to market blocks at the market's block time; `--chains 10`
and small chains' limits unless given: see *Default limits*), then sells in
the foreground. A bad flag, or a `--root` where no Lattice node lives ("no
Lattice node at <root>"), stops it before it writes anything. Every verb
takes `--help`. `--price` takes `<coin>/<blocks>` or `/hour`, `/day`, `/week`;
`--offer offer.json` still works instead.

**Default price.** 10,000 coin per chain per day. The market pays 1,000
coin a block, a block a minute: 1,440,000 a day, shared by the sellers
pacing it. With 10 sellers each mints about 144,000 a day, and a full
default offer (10 chains) earns 100,000 a day, so orders count beside the
blocks. `--price` sets another.

**Default limits.** `--price` alone sells chains with blocks at least 30 s
apart (`minTargetBlockTime 30000`), of at most 20 kB (`maxBlockSize`), each
adding at most 10 kB of state (`maxStateGrowth`), 100 transactions a block,
10 chains. A buyer's chain may fill every block, the host keeps them all,
and its own sponsor pays the fees, so at worst each chain sold adds about
86 MB a day to the node's disk, 864 MB a day for all 10. The offer format
has no cap on a chain's total state, so this rate is the bound. The seller
prints the worst case for the terms it sells; an offer file (`--offer`) sells
other limits.

**Funding.** Before it writes, the key needs market coin for its writes (the
offer, url and storage offer: three fees). The pacer pays the sponsor's key
the market's blocks, so beside the node the seller moves the fees of its
first writes (four, for a close too) from the sponsor's key to its own
before it starts lattice-sponsor, so nothing else signs with that key. It
waits until that key holds five fees (the four it moves and the move's own
fee); until then it says it waits for block rewards, or that you may send
the coin or earn it with `hearth earn` (below), and checks again each
`--interval`. It moves nothing if any lattice-sponsor already answers on
`--sponsor-port` (it could sign with the same key), and says so. With
`--node`, or once an offer is out, it only says what to send, earn or
sweep.

**Status.** Each pass prints both keys' balances on the market, the
seller's orders (by verdict) and renewals, the coin other buyers paid for
hosting it owes or owed (`earned`: settled orders judged owed, and settled
renewals of those chains that bought time; void, full and taken orders and
the seller's own count in neither; `settling`: not settled yet), the
chains it owes hosting to and until which market block, and the storage its
sponsor has pinned against its budget (its `GET /terms`; not read with
`--node`, whose sponsor runs beside the remote node). `hearth status`
prints the same once, with a deadline on every read: it never waits for a
sync, and says `market not synced (height X of Y)` instead.

**Blocks.** The seller makes the blocks of the market and of every chain it
hosts for its orders (`host/pace.mjs`), always: there is no flag. A chain is
due once its tip is one target block time old, from anyone's block: the
pacer starts no round for a chain before then (blocks faster than that
harden it), and a chain others keep moving needs nothing from it. When one
is due it asks the node for a template that leaves out (the template
request's `exclude`) every chain the node hosts that is neither due nor
above a due chain, searches nonces up to that chain's target, and submits
the hit: about one hash a block. A due chain's parents are carried with it,
and the hash that clears it also clears any parent with an easier target,
so that parent can get a block early, and its difficulty adjusts. A node
from before `exclude` carries every chain: then the pacer skips a hash that
would also clear a harder chain not yet due, but an easier one can get an
early block. A chain the node is still syncing is never paced, and after a
miss a chain waits its whole target block time. Every block pays the
sponsor's key (below), never the seller's.

**Rewards.** The block rewards accumulate in the sponsor's key, on every
chain the pacer makes blocks of (each level of the template pays it), and
fund the fees its clients pay with work. `hearth sweep [--float 100]
[--chain <path>]` moves what it holds on one chain (the market by default)
to the seller's address, leaving the float, the fees it holds for
transactions it signed and any fund deposits (lattice-sponsor's
`lattice-sponsor-holds.json` and `lattice-sponsor-funds.json`). It signs
with the sponsor's key, so it refuses while the seller or any
lattice-sponsor on `--sponsor-port` runs, and while a transaction the
sponsor signed there has yet to land; it says how to pause the seller (its
service, or the process) without `hearth stop`, which would close the
offers.

**Sponsor.** Beside the node the seller runs lattice-sponsor, and starts it
again, with backoff, whenever it exits. Its key is
`<root>/hearth/sponsor.json` (mode 0600), never the seller's: a co-signature
lends the key's authority to a draft, so it must own nothing but its float,
which the pacer's blocks pay. It pays fees for clients who pay with
proof-of-work shares, and sells pins for work at `--storage-rate`
bytes per market coin (default 10240, what testnet's own storage sponsor
charges on the market: pins are kept until the operator takes them down, so a megabyte costs about a
tenth of a market block's reward), up to `--storage-budget` bytes pinned at once
(`256M` by default; `K`, `M`, `G`, `T` are binary), on `--sponsor-port`
(default 8650). Pins are served from the node's IP. `hearth unpin <cid>`
takes a file down: the sponsor's `POST /takedown`, with the node's cookie,
unpins it, frees its bytes and refuses the CID from then on; its buyer loses
the rest of its time, with no refund (it needs a lattice-sponsor with the
takedown route).
Without `--sponsor-url` it listens on loopback only and the offer names no
sponsor, which the app shows buyers. With
`--sponsor-url https://host.example/sponsor` it listens on every interface
(put TLS in front of the port) and the offer names that URL. With `--node`
(a remote node) it runs no sponsor: lattice-sponsor reaches a node only on
its loopback, so run it there.

**Offers sell for 30 days.** An offer's `until` is 30 days of market blocks
after it is written (or its file's `duration`, in market blocks). Before it
writes a version the seller prints what it sells, until when, and "an offer
stays on sale until then; close it with `hearth stop`". Running `hearth
sell` writes a version from the offer's file (on sale again for 30 days);
after that the seller writes a new version only when the address its blocks
pay or its sponsor changes. It never renews by itself, and never reopens a
closed offer: an offer that ran out or was closed stays off sale until you
run `hearth sell` again. The installed service runs it with `--resume`, so a
restart writes none; `hearth sell --install` itself counts as running it
again: it clears the closing mark and leaves a `reopen` mark, and the
service's next start reads it once and writes a version from the file
(`hearth stop` before then cancels it). An order goes by the version in force at its height (see
*Records*). Each set of flags names its own offer, kept
in `<root>/hearth/<offer id>.json`: the same flags find it again, and other
flags write a new offer beside the old one (the seller says the old one
stays on sale). It keeps hosting the parents of all its offers still on
sale, so chains owed on an old one stay hosted.

**Key only or verified.** Without `--url` the host writes no url record:
it claims no domain, so the app lists its offers under its key, marked
*Key only*, for buyers to judge by its record. With
`--url https://host.example` (and `--proof`, see *Verified hosts*) and
`{"sellers": ["<address>"]}` at the domain's `/.well-known/lattice.json`, its
offers carry the domain's name and *Verified*. A url whose domain does not
list the address is hidden: anyone could name someone else's URL.

**Keep it running.** `--install` writes units for both the node
(`lattice up --root <root>`) and the seller, the seller after the node:
systemd user units on Linux (`~/.config/systemd/user/hearth-node.service`,
and `hearth.service` with `After=` and `Requires=` on it), or two launchd
agents on macOS (`~/Library/LaunchAgents/net.hearth.node.plist` and
`net.hearth.seller.plist`; launchd has no ordering, so the seller waits for
the node itself). The node is started again after a failure exit, which
`lattice restart` is, but stays down after `lattice down` and after exit 78
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

closes every offer of the key still on sale, once the market is synced: a
newer version whose `until` is now, which takes effect 10 market blocks
later (orders placed before then are owed). It waits until those orders
have settled (another 16 blocks) and says which chains have paid time left
and when the last ends. The seller keeps running, closing: it writes no
offer, and keeps hosting, pacing and sponsoring each chain with paid time
until that ends; then it deletes its fragment and exits. The pid and the
`closing` mark live in `<root>/hearth`, so `hearth stop` finds the seller
whatever key it runs with. With no seller running it rewrites the seller's
fragment to the paid chains and says to start the seller with `--resume` to
serve them. `--now` stops the seller (its installed service, else the
process), and its pacer and sponsor with it, and stops hosting at once; it
says what buyers lose: the rest of the time they paid for, with no refund,
and their chains get no more blocks or sponsored writes from this host.
`hearth sell` opens the offer again.

## Earning market coin

```
npx @hearthnet/hearth earn [--until <coins>] [--workers 1] [--sponsor <url>]
```

earns market coin for the seller's address with this machine's processor,
through a fee sponsor's payouts (lattice-sponsor's *Payouts*): `POST /work`
naming the address as `payTo`, each share back through `POST /shares`, and
the sponsor pays the address in coin once its earnings reach its payout
(`GET /earnings`). It stops once the address holds `--until` coins on the
market (by default enough for the seller's first writes and a close: four
fees), which it reads from the node once the node has synced the market;
until then it prints the sponsor's book. The default sponsor is
`https://lattice-testnet-apps-iad.fly.dev:8650/sponsor`. Each of the
`--workers` threads waits out an answer of 429 for its `Retry-After`, else
for a backoff.

## Checking a host

Every hosting offer names the address its blocks pay (`blocks <address>`)
and, with a public sponsor, its URL (`sponsor <https url>`), so a buyer can
check a host itself (`client/service.mjs`):

- **listed**: the offer is open, and its sponsor (an https URL) answers
  `GET /terms` bound to this host: the terms' `address` (the sponsor's own
  key; `fundTo` from an older lattice-sponsor) is the offer's `blocks`
  address, and their `payTo` is the host (lattice-sponsor runs with
  `--pay-to <seller>`). This checks that the host is up and consistent, not
  that it hosts anything: a host answers for its own address;
- **serving** a chain: the offer's `blocks` address is credited on the
  chain within the last max(24 hours, 10 target block times). The read is
  capped at 1000 blocks: on a chain fast enough to have more in that window,
  a check that finds no credit before the cap says *unknown*, not that the
  host is not serving;
- **live**, separately: the chain has a block, from anyone, within its last
  three target block times.

Blocks are read by the reader's `recentBlocks`: from the tip the node names,
each block by its CID and then its parent link, at most 1000, stopping at
the host's first. Every clock comparison allows two minutes of slack.
Offers written before `blocks` name no address, and pass none. An old
offer's `mines <hashes per second>` claim still parses (`offer.mines`);
nothing writes it any more. `creditedHashrate` in `client/mining.mjs` still
sums the work a chain's blocks credit each address.

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
chain from Nexus down to the market (`Nexus`, `Nexus/testnet`, the market),
each in its own coin: the Hosts page shows them per chain and never adds them
up. Anyone can burn for a host: it is a plain transfer to its burn address. A
burn costs whoever made it; it says nothing about how a host serves.

```
npx @hearthnet/hearth burn 300 --chain Nexus/testnet      # burns 300 now, from the seller's key
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
Spend it on hosting or storage, or sell it on Lattice's own exchange, where
buyers find it on the app's Buy coin page.

```
npx @hearthnet/hearth sell-coin 300000 --price 3000 [--float 100]
```

`hearth sell-coin <coin> --price <parent coin>` locks `<coin>` of the seller
key's market coin as a Lattice deposit demanding `<parent coin>` on the
market's parent (Nexus/testnet for the default market), for all of it. It
checks every amount, and refuses to leave the key less than `--float` for its
fees, before it signs. The deposit's nonce is the key's account nonce, so its
identity is new and sending it again is the same transaction. A buyer's
payment on the parent credits the seller's own address there directly:
nothing to claim. `hearth status` lists the key's deposits (and who paid for
each, until they take the coin), the market's cheapest coin on sale, and the
key's parent-chain balance. Lattice has no cancel or refund: an unsold
deposit comes back only the way any buyer takes it, the seller paying its
price to its own address on the parent (a fee on each chain).

## How it works

**Buying coin.** Hosts are paid in the market chain's own coin. Sellers lock
coin on the market chain for a price in the parent chain's coin (a Lattice
*deposit*). A buyer pays that price on the parent (a *receipt*) and takes the
coin on the market chain (a *withdrawal*). Lattice checks both sides, so
nobody holds the payment in between, and there is no exchange to trust.
On testnet, the parent's coin can also be earned with the device's
processor through the fee sponsor's payouts.

**Records.** The policy (`policy/src/lib.rs`) is only filters on keys and
coin; it never reads a record's value. Each filter is yes or no for one
transaction: the key has an allowed shape, the address in it signed, the
record is written once, the height in it is within the last 10 blocks, and an
order's host is credited the amount its key names.

| Key | Written by | Value (read off chain) |
|---|---|---|
| `offer/<host>/<id>/<height>` | the host, once per height: each is a version of the offer | price per period, the parent its chains go under, how many chains it sells, the spec limits it takes, the policy modules it runs, when it ends; then `blocks <address>` (where its blocks pay) and, if it runs a public sponsor, `sponsor <https url>` |
| `url/<host>` | the host | its public read URL |
| `order/<host>/<id>/<payer>/<height>/<paid>/<path>` | anyone, once; pays the host `<paid>` in the same transaction | the chain's payload (spec, premine account, policy modules, genesis transactions), or `renew` to pay for more time |

A chain's paid time is worked out from its orders and renewals: oldest
first, each adds `floor(paid / price)` periods (at the price and period in
force at the payment's own height) from where paid time ends, or from its
own height if it had run out.

An offer's versions: a version takes effect 10 market blocks after the
height it is written at. A key may name any of the last 10 heights, so a
host that sees an order could still write a version keyed below it, but
never one in force at it. An order goes by the newest version in force at
its own height, so a host can change its terms only for orders yet to come;
an order where no version is in force yet is void. A version whose `until`
is its own height closes the offer (`hearth stop`). An offer ends at the
latest `until` any version names, so a close never cuts short time paid
before it.

`chain/spec.json` and `chain/policy.wasm` (this repo's build of
`policy/src`) make a devnet market, the spec naming the module by its own
CID. The testnet market's facts are in `chain/market.json`: its path,
genesis and module CID, whose bytes were built from `policy/src` before a
path remap and are not committed.

**Storage.** A host that runs a storage sponsor (lattice-sponsor
`--sell-storage`, paid to the host's address with `--pay-to`, at a
`--storage-rate` on the market chain) can also offer storage: an `offer/`
record whose value is `kind storage`, the sponsor's URL, `bytesPerCoin`, the
`capacity` in bytes, and when it ends. A buyer uploads the file to each
sponsor (`POST /store`), then orders it at every host in one transaction: one
`order/<host>/<id>/<payer>/<height>/<paid>/<root CID>` each, valued
`bytes <n>` (the size the sponsor counted), paying each host. It claims the
payment at each sponsor (`POST /pay`, naming the root), which pins the file
until the host takes it down. A storage order is owed once settled if it paid for its bytes and
fits in what the offer has left; `judgeStorage` in `client/verdict.mjs`.
Storing at several hosts is how a file outlives any one of them.
`tools/store.mjs` does all of this for one file.

**Verified hosts.** Anyone can write an offer naming another host's URL and
take buyers' coin for hosting nobody sold. So readers trust an offer only when
the host's domain lists its address, as Nostr's NIP-05 does for names: the
`url/<host>` record is the read URL, optionally followed by a line
`proof <url>` on the same hostname (default
`<read URL's origin>/.well-known/lattice.json`), and that file is
`{"sellers": [address, ...]}`. For a storage offer the sponsor's
`GET /terms` must also be paid to the address (`payTo`) at the offer's rate
(`client/vouch.mjs`). The page offers hosting from verified hosts and from
hosts with no url record at all (*Key only*: they name no one), never from a
host whose url record fails; storage only from verified hosts. The seller
takes `--proof` to write where its list is.

**Verdicts** (`client/verdict.mjs`, the same module in the host and the
page). Once an order is 16 market blocks old it is judged from its own bytes
and the offer:

- **void**: the buyer broke the offer's terms (a spec over its limits, a
  module it does not run, the wrong parent, a payload that does not parse),
  ordered where no version was in force yet, or where a close was (a renewal
  there buys nothing);
- **full**: the offer had already sold its chains;
- **taken**: the path holds another genesis, or an earlier order at this host
  named the path with another payload;
- **owed**: the host serves the chain until its paid time or the offer ends,
  whichever is first.

Full and taken are counted against the host as *paid, not served*. The
Hosts page probes each owed chain at the host's URL and checks its genesis
is the one the buyer paid for.

**Hosts** run `host/sell-hosting.mjs` (what `hearth sell` runs) as a client
of a node's operator API. Its own fragment of the node's configuration,
`hostmarket` (`config.d/hostmarket.json`), lists the market and the parents
its offers still on sale sell under, so a fresh node hosts them. Each pass it reads its orders
and judges them. It creates each owed chain not yet on its parent from its
payload, once (`POST /chains`, which answers the same for the same payload
again), and lists every chain it owes under those parents (or a parent another
layer hosts) in the fragment, with one `PUT /config/fragments/hostmarket`
sent with the version it read. A lapsed chain is left out of the fragment:
the node stops it unless another layer (the operator's, the deploy's) lists
it, and what it stored stays. The node never restarts for it. The seller
paces the market and every chain it lists for an order (*Blocks*, above).

Beside the node (loopback and its cookie):

```
node host/sell-hosting.mjs --root /var/lib/lattice --market Nexus/testnet/lodger-3129cc \
  --key host.json --offer offer.json --url https://host.example --lattice /usr/local/bin/lattice \
  [--sponsor-bin lattice-sponsor] [--sponsor-port 8650] [--sponsor-url https://host.example/sponsor] [--storage-rate 10240]
```

From anywhere else, through the node's operator listener (`operatorListen`
in its configuration) with a token made for it:

```
node host/sell-hosting.mjs --node http://10.0.0.5:8090 --token-file seller.token \
  --market Nexus/testnet/lodger-3129cc --key host.json --offer offer.json
```

Of the node's configuration, the seller uses these routes, and no other:
`GET /config`, `GET /config/fragments/hostmarket`,
`PUT /config/fragments/hostmarket` and `POST /chains` (`hearth stop` also
`DELETE /config/fragments/hostmarket`). It also reads the node's version and
sync (`GET /status`), the market and the chains it hosts (`GET /api/...`),
submits its offer (`POST /transactions`) and paces (`POST /mining/templates`,
`POST /mining/work`); a token for all of it is simplest made `admin`
(`lattice tokens create seller --role admin --out seller.token --root /var/lib/lattice`).
A token that may write a fragment may set any key in it, so it controls the
node nearly as fully as `admin` does anyway.

`offer.json` (`period` in market blocks, or `"hour"`, `"day"`, `"week"`;
`duration` in market blocks, 30 days when absent):

```json
{ "id": "small", "parent": "Nexus/testnet", "price": 10000, "period": 1440, "duration": 43200,
  "capacity": 10, "maxBlockSize": 20000, "maxStateGrowth": 10000, "minTargetBlockTime": 30000,
  "maxNumberOfTransactionsPerBlock": 100, "modules": "any" }
```

Sellers keep coin on sale with `tools/sell.mjs`.

## What a buyer does not get

The chain's mining rewards (they go to whoever makes its blocks: the host's
sponsor, or other miners);
blocks after `hearth stop --now` (`hearth stop` keeps paid chains hosted
and paced until their time ends);
protection from a heavier rival chain at the same path; a refund; proof the
host stores rather than relays; a record of past uptime.

## Tests

```
cd policy && RUSTFLAGS="--remap-path-prefix=$HOME=/home --remap-path-prefix=$PWD=/hearth/policy" \
  cargo build --release --target wasm32-unknown-unknown && node --test test/policy.test.mjs
npm test                                                               # verdicts, storage, hearth sell, the pacer, stop, earn, burns, sell-coin
LATTICE=<lattice-node>/.build/debug/lattice node test/e2e.mjs          # sell-coin, buy coin, order, launch, void, lapse
LATTICE=<lattice-node>/.build/debug/lattice node test/e2e-commit.mjs   # a buyer commits its own chain's blocks
LATTICE=<lattice-node>/.build/debug/lattice SPONSOR=<lattice-sponsor>/.build/debug/lattice-sponsor \
  node test/e2e-seller.mjs                                             # hearth sell paces and sponsors; hearth stop
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

`test/devnet.mjs` runs a local market to work on the page against. The
devnet scripts (`test/devnet.mjs`, `test/e2e.mjs`, `test/e2e-commit.mjs`)
run the seller with lattice-sponsor from `PATH`, or from `SPONSOR=<path>`
when it is set; `test/e2e-seller.mjs` needs `SPONSOR` (a lattice-sponsor
with `POST /takedown` and `storage` in `/terms`), and a lattice-node
whose template requests take `exclude` (its check that no paced chain gets
a block before its tip is a target block time old fails without it).
