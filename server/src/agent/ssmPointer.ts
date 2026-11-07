import { GetParameterCommand, ParameterNotFound, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { z } from 'zod';
import type { MemoryPointer, PointerStore } from './memory.js';

/**
 * Memory pointers in AWS SSM Parameter Store (OG_POINTER_STORE=ssm), so a restarted container finds the newest
 * 0G memory blob. Only the 0G address is stored here ({rootHash, txHash, savedAt}); the memory stays on 0G, encrypted.
 * The ECS task role needs ssm:GetParameter and ssm:PutParameter on `<prefix>/*`.
 */

const PointerSchema = z.object({ rootHash: z.string(), txHash: z.string(), savedAt: z.string() });

export class SsmPointerStore implements PointerStore {
  private readonly client: Pick<SSMClient, 'send'>;

  constructor(
    private readonly prefix = '/ghosty/memory',
    client?: Pick<SSMClient, 'send'>,
  ) {
    this.client = client ?? new SSMClient({});
  }

  private name(userId: string): string {
    return `${this.prefix}/${userId.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
  }

  async get(userId: string): Promise<MemoryPointer | undefined> {
    try {
      const out = await this.client.send(new GetParameterCommand({ Name: this.name(userId) }));
      return out.Parameter?.Value ? PointerSchema.parse(JSON.parse(out.Parameter.Value)) : undefined;
    } catch (err) {
      if (err instanceof ParameterNotFound) return undefined;
      throw err;
    }
  }

  async set(userId: string, pointer: MemoryPointer): Promise<void> {
    const value = JSON.stringify({ rootHash: pointer.rootHash, txHash: pointer.txHash, savedAt: pointer.savedAt });
    await this.client.send(new PutParameterCommand({ Name: this.name(userId), Value: value, Type: 'String', Overwrite: true }));
  }
}
