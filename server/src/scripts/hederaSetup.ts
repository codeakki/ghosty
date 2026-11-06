import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  HbarUnit,
  PrivateKey,
  TokenAssociateTransaction,
  TopicCreateTransaction,
  TransferTransaction,
} from '@hiero-ledger/sdk';
import { loadConfig } from '../config.js';
import { hashscanAccountUrl, hashscanTopicUrl, parseHederaKey } from '../payments/hedera.js';
import { accountTinybar, tokenBalance } from '../payments/mirror.js';
import { runSetup, type SetupOps } from '../payments/setup.js';

/**
 * `npm run hedera:setup` — idempotent custody split on Hedera TESTNET (refuses mainnet).
 *
 * First run on an old .env (one account did everything): the old HEDERA_ACCOUNT_ID/HEDERA_PRIVATE_KEY become
 * HEDERA_TREASURY_ACCOUNT_ID/HEDERA_TREASURY_PRIVATE_KEY, then a fresh AGENT account is created and funded.
 * Every run after that only fills gaps (association, top-ups, HCS key, topic). New keys go straight into
 * server/.env; this script prints key NAMES and public ids only, never secret values.
 */

const ENV_FILE = process.env.GHOSTY_ENV_FILE ?? fileURLToPath(new URL('../../.env', import.meta.url));

/** Set KEY=value lines in the env file (replace in place or append), and in process.env. */
function upsertEnv(updates: Record<string, string>): void {
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
    process.env[key] = value;
  }
  writeFileSync(ENV_FILE, text);
  console.log(`  .env updated: ${Object.keys(updates).join(', ')}`);
}

// One-time migration: the old single account becomes the treasury.
if (!process.env.HEDERA_TREASURY_ACCOUNT_ID && process.env.HEDERA_ACCOUNT_ID && process.env.HEDERA_PRIVATE_KEY) {
  console.log(`migrating: ${process.env.HEDERA_ACCOUNT_ID} becomes the TREASURY; a new AGENT account will be created`);
  upsertEnv({
    HEDERA_TREASURY_ACCOUNT_ID: process.env.HEDERA_ACCOUNT_ID,
    HEDERA_TREASURY_PRIVATE_KEY: process.env.HEDERA_PRIVATE_KEY,
    HEDERA_ACCOUNT_ID: '',
    HEDERA_PRIVATE_KEY: '',
  });
}

const config = loadConfig();
if (config.HEDERA_NETWORK !== 'testnet') {
  console.error('hedera:setup only runs on testnet (HEDERA_NETWORK=testnet).');
  process.exit(1);
}
const treasuryId = config.HEDERA_TREASURY_ACCOUNT_ID;
const treasuryRaw = config.HEDERA_TREASURY_PRIVATE_KEY;
const merchantId = config.X402_PAY_TO;
const merchantRaw = config.HEDERA_MERCHANT_PRIVATE_KEY;
if (!treasuryId || !treasuryRaw || !merchantId || !merchantRaw) {
  console.error('hedera:setup needs HEDERA_TREASURY_ACCOUNT_ID, HEDERA_TREASURY_PRIVATE_KEY, X402_PAY_TO and HEDERA_MERCHANT_PRIVATE_KEY in server/.env');
  process.exit(1);
}

const usdc = config.HEDERA_USDC_TOKEN_ID;
const mirror = { mirrorUrl: config.HEDERA_MIRROR_URL };
const treasuryKey = parseHederaKey(treasuryRaw, config.HEDERA_KEY_TYPE);
const merchantKey = parseHederaKey(merchantRaw, config.HEDERA_KEY_TYPE);
// The treasury is the operator: it pays every setup fee.
const client = Client.forTestnet().setOperator(AccountId.fromString(treasuryId), treasuryKey);

const agentKey = (): PrivateKey => parseHederaKey(process.env.HEDERA_PRIVATE_KEY ?? '', config.HEDERA_KEY_TYPE);

async function receiptTx(tx: { execute(c: Client): Promise<{ transactionId: { toString(): string }; getReceipt(c: Client): Promise<unknown> }> }): Promise<string> {
  const res = await tx.execute(client);
  await res.getReceipt(client); // throws on any non-SUCCESS status
  return res.transactionId.toString();
}

const ops: SetupOps = {
  async agent() {
    const id = process.env.HEDERA_ACCOUNT_ID;
    if (!id || !process.env.HEDERA_PRIVATE_KEY) return undefined;
    const tinybar = await accountTinybar(id, mirror);
    if (tinybar === undefined) throw new Error(`HEDERA_ACCOUNT_ID ${id} not found on testnet; clear it to create a new agent`);
    return { id, tinybar, usdcMicros: await tokenBalance(id, usdc, mirror) };
  },
  async createAgent(initialTinybar) {
    const key = PrivateKey.generateECDSA();
    const res = await new AccountCreateTransaction()
      .setKeyWithoutAlias(key.publicKey)
      .setInitialBalance(Hbar.from(initialTinybar.toString(), HbarUnit.Tinybar))
      .setAccountMemo('ghosty agent hot wallet (x402)')
      .execute(client);
    const receipt = await res.getReceipt(client);
    const id = receipt.accountId?.toString();
    if (!id) throw new Error('AccountCreateTransaction returned no account id');
    upsertEnv({ HEDERA_ACCOUNT_ID: id, HEDERA_PRIVATE_KEY: key.toStringDer(), HEDERA_KEY_TYPE: 'ecdsa' });
    console.log(`  agent: ${hashscanAccountUrl(id)}`);
    return id;
  },
  async associateUsdc(who) {
    const accountId = who === 'agent' ? (process.env.HEDERA_ACCOUNT_ID as string) : merchantId;
    const key = who === 'agent' ? agentKey() : merchantKey;
    const tx = await new TokenAssociateTransaction().setAccountId(accountId).setTokenIds([usdc]).freezeWith(client).sign(key);
    return receiptTx(tx);
  },
  async merchantUsdcAssociated() {
    return (await tokenBalance(merchantId, usdc, mirror)) !== undefined;
  },
  async transferHbar(to, tinybar) {
    const amount = Hbar.from(tinybar.toString(), HbarUnit.Tinybar);
    return receiptTx(new TransferTransaction().addHbarTransfer(treasuryId, amount.negated()).addHbarTransfer(to, amount));
  },
  async transferUsdc(to, micros) {
    const n = Number(micros);
    return receiptTx(new TransferTransaction().addTokenTransfer(usdc, treasuryId, -n).addTokenTransfer(usdc, to, n));
  },
  hasHcsSubmitKey: () => Boolean(process.env.HEDERA_HCS_SUBMIT_KEY),
  createHcsSubmitKey() {
    upsertEnv({ HEDERA_HCS_SUBMIT_KEY: PrivateKey.generateECDSA().toStringDer() });
  },
  topicId: () => process.env.HEDERA_HCS_TOPIC_ID || undefined,
  async createTopic() {
    const submitKey = parseHederaKey(process.env.HEDERA_HCS_SUBMIT_KEY as string);
    const res = await new TopicCreateTransaction()
      .setTopicMemo('ghosty audit: x402 payments, 0G decisions, trades (JSON v1)')
      .setAdminKey(treasuryKey.publicKey)
      .setSubmitKey(submitKey.publicKey)
      .execute(client);
    const topicId = (await res.getReceipt(client)).topicId?.toString();
    if (!topicId) throw new Error('TopicCreateTransaction returned no topic id');
    upsertEnv({ HEDERA_HCS_TOPIC_ID: topicId });
    console.log(`  topic: ${hashscanTopicUrl(topicId)}`);
    return topicId;
  },
};

try {
  console.log(`hedera:setup on testnet. treasury ${treasuryId}, merchant ${merchantId}, USDC ${usdc}`);
  const steps = await runSetup(ops, (s) => console.log(`${s.changed ? 'DID ' : 'ok  '} ${s.step}: ${s.result}`));
  const changed = steps.filter((s) => s.changed).length;
  console.log(changed === 0 ? 'nothing to do: already set up' : `${changed} change(s) made`);
} catch (err) {
  console.error(`hedera:setup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  client.close();
}
