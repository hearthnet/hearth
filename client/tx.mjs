// Transactions for the market, built as the SDK's bodies, signed with one
// key, and sent to a node. The bodies follow the policy: an order's payment
// credits come in the order hosts are first owed.
import { CREATED_WINDOW, RENEW, formatOffer, formatPayload, offerKey, orderKey, pathPrice, storageOrderValue, urlKey } from "./records.mjs";

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

/** The writes for a new offer made at `height`, the market's current height, and, if given, the host's url. */
export function offerActions({ host, id, offer, height, url, oldURL }) {
  return [
    { key: offerKey(host, id, height), newValue: formatOffer(offer) },
    ...(url === undefined || url === oldURL ? [] : [{ key: urlKey(host), ...(oldURL === undefined ? {} : { oldValue: oldURL }), newValue: url }]),
  ];
}

/**
 * The write and payment for a new order: `periods` periods of `offer` from
 * `height`, the market's current height, for `path`, built from `payload`.
 */
export function orderWrite({ host, id, offer, buyer, path, payload, periods = 1n, height }) {
  const paid = pathPrice(offer, path) * periods;
  return {
    actions: [{ key: orderKey({ host, id, payer: buyer, height, paid, path }), newValue: formatPayload(payload) }],
    payments: [{ to: host, amount: paid }],
    order: { created: height, paid },
  };
}

/** The write and payment for `periods` more periods of `offer` on `path`, paid by `payer` at `height`. */
export function renewWrite({ host, id, offer, payer, path, periods = 1n, height }) {
  const paid = pathPrice(offer, path) * periods;
  return {
    actions: [{ key: orderKey({ host, id, payer, height, paid, path }), newValue: RENEW }],
    payments: [{ to: host, amount: paid }],
    order: { created: height, paid },
  };
}

/**
 * The write and payment for keeping `bytes` (as the host's sponsor counted
 * them) of the file `root` at a storage offer, ordered by `payer` at `height`.
 * Orders at several hosts go in one transaction: their actions and payments
 * concatenated.
 */
export function storageOrderWrite({ host, id, offer, payer, root, bytes, height }) {
  const paid = (bytes + offer.bytesPerCoin - 1n) / offer.bytesPerCoin;
  return {
    actions: [{ key: orderKey({ host, id, payer, height, paid, path: root }), newValue: storageOrderValue(bytes) }],
    payments: [{ to: host, amount: paid }],
    order: { created: height, paid },
  };
}

/** The message a payer signs (`signPreimage`) to claim a payment at a storage sponsor for `root`. */
export const storageClaim = (chain, txCID, root) => `lattice-sponsor-pay:v1:${chain}:${txCID}:${root}`;

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

export { CREATED_WINDOW };

/** A key file as `lattice key generate` writes it, so `lattice` commands take it. */
export const keyFileJSON = (sdk, privateKey) => JSON.stringify({
  address: sdk.accountFromPrivateKey(privateKey).address,
  privateKey: sdk.bytesToHex(privateKey),
  publicKey: sdk.encodeEd25519Multikey(sdk.publicKeyFromPrivate(privateKey)),
}, null, 2);
