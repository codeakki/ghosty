import { join } from 'node:path';
import { AccountId, Client, TopicCreateTransaction, TopicMessageSubmitTransaction, type PrivateKey } from '@hiero-ledger/sdk';
import type { Config } from '../config.js';
import {
  DEFAULT_STATE_DIR,
  hashscanTopicUrl,
  parseHederaKey,
  readJsonFile,
  writeJsonFile,
  type HederaNetworkName,
} from './hedera.js';

/**
 * HCS audit topic (Hedera track extra credit). One Hedera Consensus Service topic, created on
 * first use and cached in server/.ghosty/hcs.json, gets one message per x402 payment and per
 * trade decision. Anyone can read it on HashScan; the topic's submit key is the agent's key so
 * only the agent can write to it.
 */

export type AuditKind = 'payment' | 'decision';

export interface AuditEntry {
  kind: AuditKind;
  /** Hedera tx id of the payment (payments) or of the trade/venue receipt (decisions), if any. */
  txId?: string;
  /** 0G Compute request id of the decision behind it, if any. */
  requestId?: string;
  /** Short human-readable line. Truncated to 512 chars. */
  summary: string;
}

export interface AuditReceipt {
  topicId: string;
  sequenceNumber: string;
  /** Hedera tx id of the TopicMessageSubmitTransaction. */
  txId: string;
}

export interface AuditLog {
  readonly enabled: boolean;
  record(entry: AuditEntry): Promise<AuditReceipt | undefined>;
  /** HashScan URL of the topic, once it exists. */
  topicUrl(): string | undefined;
}

/** Network operations, separated so tests (and a future mirror-node reader) can swap them. */
export interface HcsTransport {
  createTopic(memo: string): Promise<string>;
  submit(topicId: string, message: string): Promise<{ sequenceNumber: string; txId: string }>;
  close?(): void;
}

/** Real transport: Hiero SDK client with the agent account as operator (pays the HCS fees). */
export class SdkHcsTransport implements HcsTransport {
  private readonly client: Client;
  private readonly submitKey: PrivateKey;

  constructor(accountId: string, privateKey: PrivateKey, network: HederaNetworkName = 'testnet') {
    this.client = network === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
    this.client.setOperator(AccountId.fromString(accountId), privateKey);
    this.submitKey = privateKey;
  }

  async createTopic(memo: string): Promise<string> {
    const res = await new TopicCreateTransaction().setTopicMemo(memo).setSubmitKey(this.submitKey.publicKey).execute(this.client);
    const receipt = await res.getReceipt(this.client);
    if (!receipt.topicId) throw new Error('TopicCreateTransaction receipt has no topicId');
    return receipt.topicId.toString();
  }

  async submit(topicId: string, message: string): Promise<{ sequenceNumber: string; txId: string }> {
    const res = await new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(message).execute(this.client);
    const receipt = await res.getReceipt(this.client);
    return { sequenceNumber: receipt.topicSequenceNumber?.toString() ?? '', txId: res.transactionId.toString() };
  }

  close(): void {
    this.client.close();
  }
}

interface HcsState {
  network: HederaNetworkName;
  topicId: string;
  createdAt: string;
}

export interface HcsAuditLogOptions {
  transport: HcsTransport;
  network?: HederaNetworkName;
  /** Use this topic instead of creating one (HEDERA_HCS_TOPIC_ID). */
  topicId?: string;
  /** Cache file; default server/.ghosty/hcs.json. `null` disables caching. */
  stateFile?: string | null;
  now?: () => Date;
}

export class HcsAuditLog implements AuditLog {
  readonly enabled = true;
  private readonly network: HederaNetworkName;
  private readonly stateFile: string | null;
  private readonly now: () => Date;
  private topicId: string | undefined;
  private creating: Promise<string> | undefined;

  constructor(private readonly opts: HcsAuditLogOptions) {
    this.network = opts.network ?? 'testnet';
    this.stateFile = opts.stateFile === undefined ? join(DEFAULT_STATE_DIR, 'hcs.json') : opts.stateFile;
    this.now = opts.now ?? (() => new Date());
    const cached = this.stateFile ? readJsonFile<HcsState>(this.stateFile) : undefined;
    this.topicId = opts.topicId ?? (cached?.network === this.network ? cached.topicId : undefined);
  }

  /** Real log when HEDERA_ACCOUNT_ID + HEDERA_PRIVATE_KEY are set, otherwise a no-op. */
  static fromConfig(config: Config, overrides: Partial<HcsAuditLogOptions> = {}): AuditLog {
    if (!config.HEDERA_ACCOUNT_ID || !config.HEDERA_PRIVATE_KEY) return new NoopAuditLog();
    const transport =
      overrides.transport ??
      new SdkHcsTransport(config.HEDERA_ACCOUNT_ID, parseHederaKey(config.HEDERA_PRIVATE_KEY, config.HEDERA_KEY_TYPE), config.HEDERA_NETWORK);
    return new HcsAuditLog({ network: config.HEDERA_NETWORK, topicId: config.HEDERA_HCS_TOPIC_ID, ...overrides, transport });
  }

  /** Create the topic once (concurrent callers share the same creation) and cache its id. */
  async ensureTopic(): Promise<string> {
    if (this.topicId) return this.topicId;
    this.creating ??= this.opts.transport
      .createTopic('ghosty: x402 payments and trade decisions')
      .then((id) => {
        this.topicId = id;
        if (this.stateFile) writeJsonFile(this.stateFile, { network: this.network, topicId: id, createdAt: this.now().toISOString() });
        return id;
      })
      .finally(() => {
        this.creating = undefined;
      });
    return this.creating;
  }

  async record(entry: AuditEntry): Promise<AuditReceipt> {
    const topicId = await this.ensureTopic();
    const message = JSON.stringify(auditMessage(entry, this.now()));
    const { sequenceNumber, txId } = await this.opts.transport.submit(topicId, message);
    return { topicId, sequenceNumber, txId };
  }

  topicUrl(): string | undefined {
    return this.topicId ? hashscanTopicUrl(this.topicId, this.network) : undefined;
  }

  close(): void {
    this.opts.transport.close?.();
  }
}

/** Message body written to HCS: {ts, kind, txId, requestId, summary}. Well under the 1024-byte single-chunk limit. */
export function auditMessage(entry: AuditEntry, now: Date = new Date()) {
  return {
    ts: now.toISOString(),
    kind: entry.kind,
    txId: entry.txId ?? null,
    requestId: entry.requestId ?? null,
    summary: entry.summary.slice(0, 512),
  };
}

export class NoopAuditLog implements AuditLog {
  readonly enabled = false;
  async record(): Promise<undefined> {
    return undefined;
  }
  topicUrl(): undefined {
    return undefined;
  }
}
