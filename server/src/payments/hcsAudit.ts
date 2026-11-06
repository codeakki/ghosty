import { AccountId, Client, TopicMessageSubmitTransaction, type PrivateKey } from '@hiero-ledger/sdk';
import type { Config } from '../config.js';
import { hashscanTopicUrl, parseHederaKey, type HederaNetworkName } from './hedera.js';
import { readTopicMessages, type MirrorOptions } from './mirror.js';

/**
 * HCS AUDIT LOG: one Hedera Consensus Service topic gets a small JSON message for every intel payment, every
 * 0G decision and every executed trade. Anyone can read it on HashScan or via GET /hedera/audit.
 *
 * - The topic is created once by `npm run hedera:setup` and pinned in HEDERA_HCS_TOPIC_ID. The server never
 *   creates topics, so nothing slow sits in the decision path.
 * - Only HEDERA_HCS_SUBMIT_KEY can write (topic submit key). It holds no funds. The agent account pays the fee
 *   (~0.0008 HBAR per message), capped at HEDERA_HCS_MAX_MESSAGES_PER_DAY.
 * - Messages are versioned JSON (v:1), always under the 1024-byte single-chunk limit.
 */

export type AuditKind = 'payment' | 'decision' | 'trade';

/** What goes on chain. Optional fields are omitted when unknown. */
export interface AuditMessage {
  v: 1;
  kind: AuditKind;
  ts: string;
  /** payment: settlement tx id; decision: tx id of the intel it used; trade: first venue receipt. */
  txId?: string;
  asset?: string;
  amount?: string;
  payTo?: string;
  /** 0G request id of the decision. */
  requestId?: string;
  signal?: string;
  /** payment: confirmed on the mirror node. */
  verified?: boolean;
}

export type AuditEntry = Omit<AuditMessage, 'v' | 'ts'>;

export const HCS_MAX_MESSAGE_BYTES = 1024;

/** Encode one message; throws if it would need more than one chunk. */
export function encodeAuditMessage(entry: AuditEntry, now: Date = new Date()): string {
  const msg: AuditMessage = { v: 1, kind: entry.kind, ts: now.toISOString() };
  for (const key of ['txId', 'asset', 'amount', 'payTo', 'requestId', 'signal', 'verified'] as const) {
    const value = entry[key];
    if (value !== undefined) (msg as unknown as Record<string, unknown>)[key] = typeof value === 'string' ? value.slice(0, 200) : value;
  }
  const text = JSON.stringify(msg);
  if (Buffer.byteLength(text) > HCS_MAX_MESSAGE_BYTES) throw new RangeError(`audit message is ${Buffer.byteLength(text)} bytes, over ${HCS_MAX_MESSAGE_BYTES}`);
  return text;
}

/** Decode one topic message. Non-JSON or non-v1 messages come back as `{ raw }` instead of being dropped. */
export function decodeAuditMessage(text: string): AuditMessage | { raw: string } {
  try {
    const parsed = JSON.parse(text) as Partial<AuditMessage>;
    if (parsed && parsed.v === 1 && typeof parsed.kind === 'string' && typeof parsed.ts === 'string') return parsed as AuditMessage;
  } catch {
    // fall through
  }
  return { raw: text.slice(0, 500) };
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
  /** HashScan URL of the topic. */
  topicUrl(): string | undefined;
  close(): void;
}

/** Network writes, separated so tests can swap them. */
export interface HcsTransport {
  submit(topicId: string, message: string): Promise<{ sequenceNumber: string; txId: string }>;
  close?(): void;
}

/** Real transport: the agent account is the operator (pays the fee); the submit key co-signs (authorizes). */
export class SdkHcsTransport implements HcsTransport {
  private readonly client: Client;

  constructor(
    payerId: string,
    payerKey: PrivateKey,
    private readonly submitKey: PrivateKey,
    network: HederaNetworkName = 'testnet',
  ) {
    this.client = network === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
    this.client.setOperator(AccountId.fromString(payerId), payerKey);
  }

  async submit(topicId: string, message: string): Promise<{ sequenceNumber: string; txId: string }> {
    const tx = await new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(message).freezeWith(this.client).sign(this.submitKey);
    const res = await tx.execute(this.client);
    const receipt = await res.getReceipt(this.client);
    return { sequenceNumber: receipt.topicSequenceNumber?.toString() ?? '', txId: res.transactionId.toString() };
  }

  close(): void {
    this.client.close();
  }
}

export interface HcsAuditLogOptions {
  transport: HcsTransport;
  topicId: string;
  network?: HederaNetworkName;
  maxMessagesPerDay?: number;
  now?: () => Date;
}

export class HcsAuditLog implements AuditLog {
  readonly enabled = true;
  readonly topicId: string;
  private readonly network: HederaNetworkName;
  private readonly now: () => Date;
  private day = '';
  private sentToday = 0;

  constructor(private readonly opts: HcsAuditLogOptions) {
    this.topicId = opts.topicId;
    this.network = opts.network ?? 'testnet';
    this.now = opts.now ?? (() => new Date());
  }

  /** Real log when the agent account, the topic and its submit key are configured; otherwise a no-op. */
  static fromConfig(config: Config, overrides: Partial<HcsAuditLogOptions> = {}): AuditLog {
    const { HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY, HEDERA_HCS_TOPIC_ID, HEDERA_HCS_SUBMIT_KEY } = config;
    if (!HEDERA_ACCOUNT_ID || !HEDERA_PRIVATE_KEY || !HEDERA_HCS_TOPIC_ID || (!HEDERA_HCS_SUBMIT_KEY && !overrides.transport)) {
      return new NoopAuditLog();
    }
    const transport =
      overrides.transport ??
      new SdkHcsTransport(
        HEDERA_ACCOUNT_ID,
        parseHederaKey(HEDERA_PRIVATE_KEY, config.HEDERA_KEY_TYPE),
        parseHederaKey(HEDERA_HCS_SUBMIT_KEY as string, config.HEDERA_KEY_TYPE),
        config.HEDERA_NETWORK,
      );
    return new HcsAuditLog({
      network: config.HEDERA_NETWORK,
      topicId: HEDERA_HCS_TOPIC_ID,
      maxMessagesPerDay: config.HEDERA_HCS_MAX_MESSAGES_PER_DAY,
      ...overrides,
      transport,
    });
  }

  /** Submit one message. Returns undefined (and writes nothing) once today's message budget is used up. */
  async record(entry: AuditEntry): Promise<AuditReceipt | undefined> {
    const now = this.now();
    const day = now.toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.sentToday = 0;
    }
    if (this.sentToday >= (this.opts.maxMessagesPerDay ?? 500)) return undefined;
    this.sentToday++;
    const { sequenceNumber, txId } = await this.opts.transport.submit(this.topicId, encodeAuditMessage(entry, now));
    return { topicId: this.topicId, sequenceNumber, txId };
  }

  topicUrl(): string {
    return hashscanTopicUrl(this.topicId, this.network);
  }

  close(): void {
    this.opts.transport.close?.();
  }
}

export class NoopAuditLog implements AuditLog {
  readonly enabled = false;
  async record(): Promise<undefined> {
    return undefined;
  }
  topicUrl(): undefined {
    return undefined;
  }
  close(): void {}
}

export interface AuditRow {
  sequenceNumber: number;
  consensusTimestamp: string;
  message: AuditMessage | { raw: string };
}

/** Read the newest `limit` audit messages back from the mirror node and decode them (GET /hedera/audit). */
export async function readAuditLog(topicId: string, limit: number, opts: MirrorOptions): Promise<AuditRow[]> {
  const rows = await readTopicMessages(topicId, limit, opts);
  return rows.map((r) => ({ sequenceNumber: r.sequenceNumber, consensusTimestamp: r.consensusTimestamp, message: decodeAuditMessage(r.text) }));
}
