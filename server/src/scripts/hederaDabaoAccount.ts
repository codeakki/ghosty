import 'dotenv/config';
import { AccountCreateTransaction, AccountId, Client, Hbar, PublicKey, TokenId, TransferTransaction } from '@hiero-ledger/sdk';
import { loadConfig } from '../config.js';
import { hashscanAccountUrl, parseHederaKey } from '../payments/hedera.js';

/**
 * `npm run hedera:dabao-account -- <dabao pubkey hex>` — Hedera TESTNET only.
 *
 * Creates the account the Dabao pays x402 from: its key is the Dabao's own secp256k1 public key (GET_INFO v2,
 * printed by firmware/dabao/dabao_check.py), so only the Dabao can sign for it. The treasury pays 5 HBAR into it,
 * and the agent account sends 1 USDC (unlimited auto-association, so no association transaction is needed).
 * Then set X402_SIGNER=dabao, HEDERA_DABAO_ACCOUNT_ID and HEDERA_DABAO_PUBLIC_KEY.
 */

const pubHex = (process.argv[2] ?? '').replace(/^0x/i, '');
if (!/^0[23][0-9a-fA-F]{64}$/.test(pubHex)) {
  console.error('usage: npm run hedera:dabao-account -- <33-byte compressed public key hex>');
  process.exit(2);
}

const config = loadConfig();
if (config.HEDERA_NETWORK !== 'testnet') throw new Error('testnet only');
const { HEDERA_TREASURY_ACCOUNT_ID, HEDERA_TREASURY_PRIVATE_KEY, HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY } = config;
if (!HEDERA_TREASURY_ACCOUNT_ID || !HEDERA_TREASURY_PRIVATE_KEY) throw new Error('needs HEDERA_TREASURY_ACCOUNT_ID and HEDERA_TREASURY_PRIVATE_KEY');

const treasuryKey = parseHederaKey(HEDERA_TREASURY_PRIVATE_KEY, config.HEDERA_KEY_TYPE);
const client = Client.forTestnet().setOperator(AccountId.fromString(HEDERA_TREASURY_ACCOUNT_ID), treasuryKey);

try {
  const created = await new AccountCreateTransaction()
    .setKeyWithoutAlias(PublicKey.fromStringECDSA(pubHex))
    .setInitialBalance(new Hbar(5))
    .setMaxAutomaticTokenAssociations(-1)
    .setAccountMemo('ghosty dabao x402 payer')
    .execute(client);
  const accountId = (await created.getReceipt(client)).accountId!.toString();
  console.log(`created ${accountId} with 5 HBAR  ${hashscanAccountUrl(accountId)}`);

  if (HEDERA_ACCOUNT_ID && HEDERA_PRIVATE_KEY) {
    const agentKey = parseHederaKey(HEDERA_PRIVATE_KEY, config.HEDERA_KEY_TYPE);
    const usdc = TokenId.fromString(config.HEDERA_USDC_TOKEN_ID);
    const tx = await new TransferTransaction()
      .addTokenTransfer(usdc, AccountId.fromString(HEDERA_ACCOUNT_ID), -1_000_000)
      .addTokenTransfer(usdc, AccountId.fromString(accountId), 1_000_000)
      .freezeWith(client)
      .sign(agentKey);
    await (await tx.execute(client)).getReceipt(client);
    console.log(`sent 1 USDC from ${HEDERA_ACCOUNT_ID}`);
  }
  console.log(`\nset: X402_SIGNER=dabao HEDERA_DABAO_ACCOUNT_ID=${accountId} HEDERA_DABAO_PUBLIC_KEY=${pubHex}`);
} finally {
  client.close();
}
