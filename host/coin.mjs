// Selling the market coin a seller earns, on Lattice's own exchange: the
// seller locks it on the market chain as a deposit demanding a price in the
// parent chain's coin; a buyer pays that price on the parent, where Lattice
// credits it straight to the seller's address (nothing to claim); the buyer
// then takes the coin on the market. Lattice has no cancel or refund: a
// deposit stays locked until someone buys it, the seller included (paying
// its price to itself).
import { depositBody, submit } from "../client/tx.mjs";
import { reader } from "../client/market.mjs";

/** Where a buyer pays for the market's coin: its parent chain, and the market's name under it. */
export function exchangeOf(market) {
  const parts = market.split("/");
  return { parent: parts.slice(0, -1).join("/"), directory: parts.at(-1) };
}

/**
 * The deposit that locks `amount` of the seller's market coin for `price`
 * parent coin, from the key's `balance` and `nonce` on `market`. Its deposit
 * nonce is the account's nonce, which no other transaction of the key uses,
 * so the deposit's identity is new, and a resend is the same transaction.
 * An error, before anything is signed, when it would leave the key less
 * than `float` for its fees.
 */
export function sellCoinBody({ seller, balance, nonce, market, amount, price, float, fee }) {
  if (amount <= 0n || price <= 0n) throw new Error("the amount and the price are each at least 1");
  if (balance < amount + fee + float) {
    const most = balance - fee - float;
    throw new Error(`the seller's key holds ${balance} on ${market}: locking ${amount} (and the fee ${fee}) would leave it less than the ${float} it keeps for fees (--float). `
      + (most > 0n ? `It can sell at most ${most} now.` : "It has nothing to sell now."));
  }
  return depositBody({ seller, nonce, chainPath: market.split("/"), depositNonce: nonce, amountDemanded: price, amountDeposited: amount, fee });
}

/** The most of one seller's own deposit entries a read walks. */
export const OWN_LIMIT = 200;

/**
 * Locks `amount` market coin for `price` parent coin: `{ deposit, tx, parent }`.
 * A deposit can't be cancelled, so unless `again`, a seller's open deposit
 * of the same amount and price (a retry after the first landed) stops it
 * before signing: `{ existing, parent }`.
 */
export async function sellCoin({ sdk, node, fetchImpl, privateKey, market, amount, price, float, fee, again = false, r = reader(sdk, node, { fetchImpl }) }) {
  const seller = sdk.accountFromPrivateKey(privateKey).address;
  const { parent } = exchangeOf(market);
  if (!again) {
    const own = await r.deposits(market, { prefix: `${seller}/`, limit: OWN_LIMIT });
    const existing = own.find((d) => d.amountDeposited === amount && d.amountDemanded === price);
    if (existing) return { existing, parent };
    if (!own.complete) throw new Error(`the seller's key has more than ${OWN_LIMIT} deposits on ${market}: not all were read to check this one is not already on sale; give --again to lock it anyway`);
  }
  const [{ balance, nonce }, info] = await Promise.all([r.account(market, seller), r.api("/api/chain/info", market)]);
  const body = sellCoinBody({ seller, balance, nonce, market, amount, price, float, fee: BigInt(fee ?? info.minRelayFee ?? 1) });
  const tx = await submit(sdk, node, body, privateKey, fetchImpl);
  const [d] = body.depositActions;
  return { deposit: { demander: d.demander, amountDemanded: d.amountDemanded, nonce: d.nonce, amountDeposited: d.amountDeposited }, tx, parent };
}

/** The deposit asking the least parent coin per market coin, or undefined when none is open. */
export function cheapest(deposits) {
  return deposits.reduce((best, d) => (best === undefined || d.amountDemanded * best.amountDeposited < best.amountDemanded * d.amountDeposited ? d : best), undefined);
}

/**
 * Parent coin per market coin as a decimal, from BigInt: exact when it ends
 * within `places` decimals, else cut there and marked `~` (or `<` below
 * the last place, never a misleading 0).
 */
export function each(d, places = 8) {
  const scale = 10n ** BigInt(places);
  const scaled = (d.amountDemanded * scale) / d.amountDeposited;
  const exact = scaled * d.amountDeposited === d.amountDemanded * scale;
  if (scaled === 0n && !exact) return `<0.${"0".repeat(places - 1)}1`;
  const whole = scaled / scale, frac = (scaled % scale).toString().padStart(places, "0").replace(/0+$/, "");
  return `${exact ? "" : "~"}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Who paid on the parent for each of `deposits` (the seller's own): a map
 * from deposit key to buyer, of at most `cap` deposits, `concurrency` reads
 * at a time, each given up after `timeout` ms (then unread, as if unsold).
 */
export async function receiptsOf({ n, parent, directory, deposits, cap = 20, concurrency = 4, timeout = 15_000 }) {
  const paidBy = new Map(), queue = deposits.slice(0, cap);
  const one = (d) => Promise.race([n.receipt(parent, directory, d), new Promise((ok) => setTimeout(ok, timeout).unref?.())]).catch(() => undefined);
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let d; (d = queue.shift()); ) { const buyer = await one(d); if (buyer) paidBy.set(d.key, buyer); }
  }));
  return paidBy;
}

/**
 * `hearth status`'s exchange lines: the cheapest of `deposits` (a bounded
 * read of the market's; `complete` false when it stopped short), and each
 * of the seller's own (`mine`), with the buyer whose payment the parent
 * records for it (`paidBy`, a map from its key; absent while unsold, or
 * unread).
 */
export function coinLines({ market, deposits, mine, paidBy = new Map() }) {
  const { parent } = exchangeOf(market);
  const best = cheapest(deposits);
  const of = `${deposits.length} open deposit${deposits.length === 1 ? "" : "s"}${deposits.complete === false ? " in the first part of the market's deposits read" : ""}`;
  return [
    best ? `exchange: the cheapest market coin on sale is ${best.amountDeposited} for ${best.amountDemanded} ${parent} coin (${each(best)} each), of ${of}`
      : `exchange: no market coin is on sale${deposits.complete === false ? " in the first part of the market's deposits read" : ""}`,
    ...(mine.length === 0 ? ["the seller's key has no coin on sale (hearth sell-coin)"] : mine.map((d) => {
      const buyer = paidBy.get(d.key);
      return `on sale: ${d.amountDeposited} for ${d.amountDemanded} ${parent} coin (${each(d)} each), deposit ${d.key}`
        + (buyer ? `: bought by ${buyer}, who paid you on ${parent}; it closes when they take the coin` : "");
    })),
    ...(mine.complete === false ? ["(the seller's key has more deposits than one read takes: some may not be listed)"] : []),
  ];
}
