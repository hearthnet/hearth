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

/** Locks `amount` market coin for `price` parent coin: `{ deposit, tx, parent }`. */
export async function sellCoin({ sdk, node, fetchImpl, privateKey, market, amount, price, float, fee }) {
  const seller = sdk.accountFromPrivateKey(privateKey).address;
  const r = reader(sdk, node, { fetchImpl });
  const [{ balance, nonce }, info] = await Promise.all([r.account(market, seller), r.api("/api/chain/info", market)]);
  const body = sellCoinBody({ seller, balance, nonce, market, amount, price, float, fee: BigInt(fee ?? info.minRelayFee ?? 1) });
  const tx = await submit(sdk, node, body, privateKey, fetchImpl);
  const [d] = body.depositActions;
  return { deposit: { demander: d.demander, amountDemanded: d.amountDemanded, nonce: d.nonce, amountDeposited: d.amountDeposited }, tx, parent: exchangeOf(market).parent };
}

/** The deposit asking the least parent coin per market coin, or undefined when none is open. */
export function cheapest(deposits) {
  return deposits.reduce((best, d) => (best === undefined || d.amountDemanded * best.amountDeposited < best.amountDemanded * d.amountDeposited ? d : best), undefined);
}

/** Parent coin per market coin, to three figures. */
const each = (d) => (Number(d.amountDemanded) / Number(d.amountDeposited)).toPrecision(3);

/**
 * `hearth status`'s exchange lines: the market's cheapest open deposit, and
 * each of the seller's own, with the buyer whose payment the parent records
 * for it (`paidBy`, a map from its key; absent while unsold, or unread).
 */
export function coinLines({ market, self, deposits, paidBy = new Map() }) {
  const { parent } = exchangeOf(market);
  const best = cheapest(deposits);
  const mine = deposits.filter((d) => d.demander === self);
  return [
    best ? `exchange: the cheapest market coin on sale is ${best.amountDeposited} for ${best.amountDemanded} ${parent} coin (${each(best)} each), of ${deposits.length} open deposit${deposits.length === 1 ? "" : "s"}`
      : "exchange: no market coin is on sale",
    ...(mine.length === 0 ? ["the seller's key has no coin on sale (hearth sell-coin)"] : mine.map((d) => {
      const buyer = paidBy.get(d.key);
      return `on sale: ${d.amountDeposited} for ${d.amountDemanded} ${parent} coin (${each(d)} each), deposit ${d.key}`
        + (buyer ? `: bought by ${buyer}, who paid you on ${parent}; it closes when they take the coin` : "");
    })),
  ];
}
