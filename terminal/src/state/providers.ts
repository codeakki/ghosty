import type { ExecutionMarkets, ProviderStatus, Track, X402Status, ZeroGStatus } from '../api/types';

/**
 * Until GET /providers/status ships, build what we honestly can from the status routes that exist today
 * (/zerog/status, /x402/status, /execution/markets). Env var names come from server/src/config.ts.
 * Data and audio providers have no status route yet, so they are left out rather than guessed.
 */
export function deriveProviders(input: {
  zeroG: ZeroGStatus | null;
  x402: X402Status | null;
  execution: ExecutionMarkets | null;
}): ProviderStatus[] {
  const out: ProviderStatus[] = [];
  const { zeroG, x402, execution } = input;

  if (zeroG) {
    const real = zeroG.computeMode === '0g';
    out.push({
      id: '0g-compute',
      label: '0G Compute',
      track: '0g',
      state: !zeroG.computeOnline ? 'offline' : real ? 'live' : 'not_configured',
      detail: !zeroG.computeOnline
        ? 'Unreachable: safe-stop engaged'
        : real
          ? `Model ${zeroG.model ?? 'unknown'}`
          : 'Stub decider (keyword rules)',
      missingEnv: real ? [] : ['OG_API_KEY'],
    });
    const storageReal = zeroG.storageMode === '0g';
    out.push({
      id: '0g-storage',
      label: '0G Storage',
      track: '0g',
      state: storageReal ? (zeroG.lastStorageError ? 'degraded' : 'live') : 'not_configured',
      detail: storageReal
        ? zeroG.lastStorageError ?? `${zeroG.episodeCount} episodes · ${zeroG.pendingEpisodes} pending`
        : 'In-memory episode log',
      missingEnv: storageReal ? [] : ['OG_PRIVATE_KEY'],
    });
  }

  if (x402) {
    const real = x402.mode === 'real';
    out.push({
      id: 'hedera-x402',
      label: 'x402 payer',
      track: 'hedera',
      state: real ? 'live' : 'not_configured',
      detail: real ? `${x402.network} · payer ${x402.payer ?? '—'}` : 'Simulated payments',
      missingEnv: real ? [] : ['HEDERA_ACCOUNT_ID', 'HEDERA_PRIVATE_KEY'],
    });
  }

  if (execution) {
    const perp = execution.perpMode === 'real';
    const unresolved = execution.resolved.filter((r) => r.error).map((r) => r.alias);
    out.push({
      id: 'hyperliquid',
      label: `Hyperliquid ${execution.testnet ? 'testnet' : 'mainnet'}`,
      track: 'hyperliquid',
      state: !perp ? 'not_configured' : unresolved.length > 0 ? 'degraded' : 'live',
      detail: !perp
        ? 'Simulated orders'
        : unresolved.length > 0
          ? `Unresolved: ${unresolved.join(', ')}`
          : `Markets: ${execution.resolved.map((r) => r.coin ?? r.alias).join(', ')}`,
      missingEnv: perp ? [] : ['HL_AGENT_PRIVATE_KEY', 'HL_MASTER_ADDRESS'],
    });
    const spot = execution.spotMode === 'real';
    out.push({
      id: 'uniswap',
      label: 'Uniswap Trading API',
      track: 'uniswap',
      state: spot ? 'live' : 'not_configured',
      detail: spot ? (execution.spotLeg ? 'Spot leg enabled' : 'Configured, spot leg off (UNISWAP_SPOT_LEG)') : 'Simulated swaps',
      missingEnv: spot ? [] : ['UNISWAP_API_KEY', 'EVM_PRIVATE_KEY'],
    });
  }

  return out;
}

export const TRACK_ORDER: Track[] = ['0g', 'hedera', 'uniswap', 'hyperliquid', 'data', 'audio'];

export const TRACK_LABEL: Record<Track, string> = {
  '0g': '0G',
  hedera: 'Hedera',
  uniswap: 'Uniswap',
  hyperliquid: 'Hyperliquid',
  data: 'Data',
  audio: 'Audio',
};
