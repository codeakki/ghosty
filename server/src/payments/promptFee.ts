import { AccountId, Client, Hbar, TransferTransaction } from '@hiero-ledger/sdk';
import type { Config } from '../config.js';
import { hashscanTxUrl, parseHederaKey } from './hedera.js';

/**
 * PROMPT_FEE_HBAR per Ghosty prompt: treasury → agent account on Hedera, sent right before the prompt is handled.
 * The transfer is submitted and pre-checked before the turn goes on; consensus is confirmed in the background.
 */
export function createPromptFee(
  config: Config,
  log: (msg: string, data: Record<string, unknown>) => void,
): ((transcript: string) => Promise<void>) | undefined {
  const { PROMPT_FEE_HBAR, HEDERA_TREASURY_ACCOUNT_ID, HEDERA_TREASURY_PRIVATE_KEY, HEDERA_ACCOUNT_ID, HEDERA_NETWORK } = config;
  if (!PROMPT_FEE_HBAR || !HEDERA_TREASURY_ACCOUNT_ID || !HEDERA_TREASURY_PRIVATE_KEY || !HEDERA_ACCOUNT_ID) return undefined;
  const from = AccountId.fromString(HEDERA_TREASURY_ACCOUNT_ID);
  const to = AccountId.fromString(HEDERA_ACCOUNT_ID);
  const client = (HEDERA_NETWORK === 'mainnet' ? Client.forMainnet() : Client.forTestnet()).setOperator(
    from,
    parseHederaKey(HEDERA_TREASURY_PRIVATE_KEY, config.HEDERA_KEY_TYPE),
  );
  const amount = new Hbar(PROMPT_FEE_HBAR);
  return async (transcript) => {
    try {
      const res = await new TransferTransaction()
        .addHbarTransfer(from, amount.negated())
        .addHbarTransfer(to, amount)
        .setTransactionMemo('ghosty prompt fee')
        .execute(client);
      const txId = res.transactionId.toString();
      log('prompt fee sent', { hbar: PROMPT_FEE_HBAR, from: from.toString(), to: to.toString(), txId, transcript: transcript.slice(0, 80) });
      res
        .getReceipt(client)
        .then((r) => log('prompt fee confirmed', { txId, status: r.status.toString(), url: hashscanTxUrl(txId, HEDERA_NETWORK) }))
        .catch((err) => log('prompt fee failed', { txId, err: String(err) }));
    } catch (err) {
      log('prompt fee failed', { err: String(err) });
    }
  };
}
