import type { PlannedAction } from '../execution/playbook.js';
import type { Decision } from './decide.js';

/**
 * Per-decision episode log. The 0G Physical AI track asks for one record per decision,
 * tied to the 0G inference request id, stored on 0G Storage.
 */

export type EpisodeOutcome = 'proposed' | 'executed' | 'cancelled' | 'blocked_safe_stop' | 'failed';

export interface EpisodeInput {
  decision: Decision;
  requestId: string;
  actions: PlannedAction[];
  outcome: EpisodeOutcome;
  /** Venue order ids / tx hashes, when something was executed. */
  receipts?: string[];
}

export interface EpisodeRecord extends EpisodeInput {
  seq: number;
  at: string;
}

export interface EpisodeLog {
  append(entry: EpisodeInput): Promise<EpisodeRecord>;
  list(limit?: number): Promise<EpisodeRecord[]>;
}

export class InMemoryEpisodeLog implements EpisodeLog {
  private readonly records: EpisodeRecord[] = [];

  async append(entry: EpisodeInput): Promise<EpisodeRecord> {
    const record: EpisodeRecord = { ...entry, seq: this.records.length + 1, at: new Date().toISOString() };
    this.records.push(record);
    return record;
  }

  async list(limit = 50): Promise<EpisodeRecord[]> {
    return this.records.slice(-limit);
  }
}

// TODO(0g): ZeroGEpisodeLog. One encrypted JSON blob per episode on 0G Storage.
// Package: @0gfoundation/0g-storage-ts-sdk. Same upload path as memory.ts; store rootHash per seq.
// Optional: append rootHash + requestId to a Hedera HCS topic for a public audit trail (Hedera extra credit),
// or to an Arkiv entity as a public market-event index (stretch track).
