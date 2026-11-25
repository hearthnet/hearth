// Transactions for the market, built as the SDK's bodies, signed with one
// key, and sent to a node. The bodies follow the policy: an order's payment
// credits come in the order hosts are first owed.
import { renewValue, formatOffer, offerKey, orderKey, parseOffer } from "./records.mjs";

const empty = { actions: [], depositActions: [], receiptActions: [], withdrawalActions: [] };

/** A body that writes `actions`, paying each of `payments` in order, plus `fee`. */
export function recordsBody({ signer, nonce, chainPath, actions, payments = [], fee }) {
  const debit = payments.reduce((sum, p) => sum + p.amount, fee);
  // One credit per payee, in the order they are first paid.
  const credits = new Map();
  for (const { to, amount } of payments) credits.set(to, (credits.get(to) ?? 0n) + amount);
  return {
    ...empty,
    accountActions: [...(debit > 0n ? [{ owner: signer, delta: -debit }] : []), ...[...credits].map(([owner, delta]) => ({ owner, delta }))],
    actions,
    signers: [signer],
    nonce,
    chainPath,
  };
}

/**
 * The write that sets the host's offer `id` to `offer`: a new one, or a
 * change of `old` (its text now). Every order that asserted `old` and has
 * not landed is then refused.
 */
export const offerWrite = ({ host, id, offer, old }) => ({ key: offerKey(host, id), ...(old === undefined ? {} : { oldValue: old }), newValue: formatOffer(offer) });

/** The write that closes the host's offer `id`, whose text is `old`. */
export const closeWrite = ({ host, id, old }) => ({ key: offerKey(host, id), oldValue: old });

/**
 * The writes and payment for an order: `periods` periods at the offer whose
 * text is `terms` (asserted unchanged, so the order lands only on these
 * terms), for `path`, carrying `value` (`formatOrderValue`, or `renewValue` to
 * pay for more time on a genesis already ordered): the offer's price for each
 * period. `n` tells the payer's orders apart: its nonce on the market chain
 * will do.
 */
export function orderWrite({ host, id, terms, payer, n, path, value, periods = 1n }) {
  const paid = parseOffer(terms).price * periods;
  return {
    actions: [
      { key: offerKey(host, id), oldValue: terms, newValue: terms },
      { key: orderKey({ host, id, payer, n, paid, path }), newValue: value },
    ],
    payments: [{ to: host, amount: paid }],
    paid,
  };
}

/** The writes and payment for `periods` more periods of the chain at `path` run from `genesis` (its CID). */
export const renewWrite = ({ genesis, ...o }) => orderWrite({ ...o, value: renewValue(genesis) });

/** A seller locks `amountDeposited` market coin for `amountDemanded` parent coin. */
export function depositBody({ seller, nonce, chainPath, depositNonce, amountDemanded, amountDeposited, fee }) {
  return { ...empty, accountActions: [{ owner: seller, delta: -(amountDeposited + fee) }], depositActions: [{ nonce: depositNonce, demander: seller, amountDemanded, amountDeposited }], signers: [seller], nonce, chainPath };
}

/** The buyer pays a deposit's seller on the parent chain; `directory` is the market chain's name under it. */
export function receiptBody({ buyer, nonce, parentPath, directory, deposit, fee }) {
  return {
    ...empty, accountActions: [{ owner: buyer, delta: -fee }],
    receiptActions: [{ withdrawer: buyer, nonce: deposit.nonce, demander: deposit.demander, amountDemanded: deposit.amountDemanded, directory }],
    signers: [buyer], nonce, chainPath: parentPath,
  };
}

/** The buyer takes the deposit's coin on the market chain, paying the fee out of it. */
export function withdrawalBody({ buyer, nonce, chainPath, deposit, fee }) {
  return {
    ...empty, accountActions: [{ owner: buyer, delta: deposit.amountDeposited - fee }],
    withdrawalActions: [{ withdrawer: buyer, nonce: deposit.nonce, demander: deposit.demander, amountDemanded: deposit.amountDemanded, amountWithdrawn: deposit.amountDeposited }],
    signers: [buyer], nonce, chainPath,
  };
}

/** Sign `body` with `privateKey` and send it to `node`; the transaction's CID, or an error naming the refusal. */
export async function submit(sdk, node, body, privateKey, fetchImpl = (...a) => fetch(...a)) {
  const { publicKey, signature } = sdk.signTransactionBody(body, privateKey);
  const response = await fetchImpl(new URL("/transactions", node), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
  });
  const text = await response.text();
  if (!response.ok) {
    let reason = text;
    try { const parsed = JSON.parse(text); reason = parsed.error?.message ?? parsed.reason ?? parsed.error ?? text; } catch {}
    throw Object.assign(new Error(`${response.status}: ${typeof reason === "string" ? reason : JSON.stringify(reason)}`), { status: response.status, body: text });
  }
  try { return JSON.parse(text).transactionCID ?? sdk.signedTransactionCID({ [publicKey]: signature }, body); } catch { return sdk.signedTransactionCID({ [publicKey]: signature }, body); }
}

/** A key file as `lattice key generate` writes it, so `lattice` commands take it. */
export const keyFileJSON = (sdk, privateKey) => JSON.stringify({
  address: sdk.accountFromPrivateKey(privateKey).address,
  privateKey: sdk.bytesToHex(privateKey),
  publicKey: sdk.encodeEd25519Multikey(sdk.publicKeyFromPrivate(privateKey)),
}, null, 2);
