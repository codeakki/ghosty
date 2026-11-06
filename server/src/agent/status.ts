/**
 * Process-wide 0G status, updated by the real implementations and read by `zeroGStatus()`.
 * Kept in one place so the HTTP layer can expose it without holding references to the instances.
 */
export interface ZeroGRuntimeState {
  computeMode: '0g' | 'fake' | 'not_configured';
  storageMode: '0g' | 'memory' | 'not_configured';
  lastRequestId: string | null;
  lastDecisionAt: string | null;
  memoryRootHash: string | null;
  memoryTxHash: string | null;
  /** Episodes confirmed on 0G Storage (from the local index). */
  episodeCount: number;
  lastEpisodeRoot: string | null;
  /** Episodes waiting in the batch buffer or the upload queue. */
  pendingEpisodes: number;
  lastStorageError: string | null;
}

function initial(): ZeroGRuntimeState {
  return {
    computeMode: 'fake',
    storageMode: 'memory',
    lastRequestId: null,
    lastDecisionAt: null,
    memoryRootHash: null,
    memoryTxHash: null,
    episodeCount: 0,
    lastEpisodeRoot: null,
    pendingEpisodes: 0,
    lastStorageError: null,
  };
}

export const zeroGState: ZeroGRuntimeState = initial();

export function updateZeroGState(patch: Partial<ZeroGRuntimeState>): void {
  Object.assign(zeroGState, patch);
}

/** Tests only. */
export function resetZeroGState(): void {
  Object.assign(zeroGState, initial());
}
