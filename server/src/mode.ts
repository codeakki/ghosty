/**
 * Run modes.
 *  - live (default): every provider slot is the real implementation when its keys are set, otherwise a
 *    NotConfigured implementation that throws ProviderNotConfiguredError. No fake data, ever.
 *  - test: `node --test` runs (npm test sets GHOSTY_MODE=test). Fakes stay offline and deterministic.
 */
export type GhostyMode = 'live' | 'test';

export const GHOSTY_MODES = ['live', 'test'] as const;

/** Mode when GHOSTY_MODE is not given: the process env, then "test" under `node --test`, else "live". */
export function defaultMode(env: NodeJS.ProcessEnv = process.env): GhostyMode {
  const raw = env.GHOSTY_MODE?.trim().toLowerCase();
  if (raw === 'live' || raw === 'test') return raw;
  return env.NODE_TEST_CONTEXT ? 'test' : 'live';
}

/** Factories read the mode from config; a config built without it falls back to defaultMode(). */
export function modeOf(config: { GHOSTY_MODE?: GhostyMode }): GhostyMode {
  return config.GHOSTY_MODE ?? defaultMode();
}

export const isTestMode = (config: { GHOSTY_MODE?: GhostyMode }): boolean => modeOf(config) === 'test';

export interface NotConfiguredInfo {
  /** Provider id, matching GET /providers/status (e.g. "groq", "0g-router", "hyperliquid"). */
  provider: string;
  /** Env keys that would switch the real implementation on. */
  missingEnv: string[];
}

/**
 * A provider slot was used in live mode without its keys. app.ts maps it to
 * `503 {"error":"not_configured", provider, missingEnv}`.
 */
export class ProviderNotConfiguredError extends Error {
  override readonly name = 'ProviderNotConfiguredError';
  readonly provider: string;
  readonly missingEnv: string[];

  constructor(info: NotConfiguredInfo, message?: string) {
    super(message ?? `${info.provider} is not configured: set ${info.missingEnv.join(', ')}`);
    this.provider = info.provider;
    this.missingEnv = [...info.missingEnv];
  }

  /** The 503 body. */
  body(): { error: 'not_configured'; provider: string; missingEnv: string[]; message: string } {
    return { error: 'not_configured', provider: this.provider, missingEnv: this.missingEnv, message: this.message };
  }
}

/** Marker carried by every NotConfigured implementation (see notConfigured.ts). */
export interface NotConfiguredSlot {
  readonly notConfigured: NotConfiguredInfo;
}

/** The slot's NotConfigured info, or undefined for a real (or test fake) implementation. */
export function notConfiguredInfo(value: unknown): NotConfiguredInfo | undefined {
  if (typeof value !== 'object' || value === null || !('notConfigured' in value)) return undefined;
  const info = (value as NotConfiguredSlot).notConfigured;
  return info && typeof info.provider === 'string' ? info : undefined;
}
