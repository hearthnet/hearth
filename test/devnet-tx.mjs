export { depositBody, submit } from "../client/tx.mjs";
export const buildTransferBody = ({ from, to, amount, nonce, chainPath, fee }) => ({
  accountActions: [{ owner: from, delta: -(amount + fee) }, { owner: to, delta: amount }],
  actions: [], depositActions: [], receiptActions: [], withdrawalActions: [], signers: [from], nonce, chainPath,
});
