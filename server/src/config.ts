import { z } from 'zod';

/** Parse "true"/"1"/"yes"/"on" (case-insensitive) as true; anything else as false; missing → default. */
const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v.trim())));

const optional = z.string().optional();

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000).catch(3000),
  HOST: z.string().default('0.0.0.0'),
  DEVICE_TOKEN: optional,

  GROQ_API_KEY: optional,
  ELEVENLABS_API_KEY: optional,

  OG_ROUTER_URL: z.string().default('https://router-api-testnet.integratenetwork.work/v1'),
  OG_API_KEY: optional,
  OG_PRIVATE_KEY: optional,
  OG_INDEXER_URL: z.string().default('https://indexer-storage-testnet-turbo.0g.ai'),
  /** Router model id (catalog: GET <OG_ROUTER_URL>/models). glm-4.7 supports response_format on mainnet. */
  OG_MODEL: z.string().default('glm-4.7'),
  /** Ask the router for `response_format: json_object`. Turn off for models without structured-output support. */
  OG_JSON_MODE: bool(true),
  /** 0G Galileo EVM RPC used to submit storage transactions. */
  OG_RPC_URL: z.string().default('https://evmrpc-testnet.0g.ai'),
  /** 32-byte hex AES-256-GCM key for user memory. Unset → sha256-derived from OG_PRIVATE_KEY. */
  OG_MEMORY_KEY: optional,
  /** Buffer episodes and upload them OG_EPISODE_BATCH_SIZE at a time to save faucet gas. */
  OG_EPISODE_BATCH: bool(false),
  OG_EPISODE_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(5).catch(5),
  /** Local cache dir for root-hash pointers (default: server/.ghosty). */
  OG_DATA_DIR: optional,

  HEDERA_ACCOUNT_ID: optional,
  HEDERA_PRIVATE_KEY: optional,
  X402_FACILITATOR_URL: z.string().default('https://x402.org/facilitator'),

  HL_MASTER_ADDRESS: optional,
  HL_AGENT_PRIVATE_KEY: optional,
  HL_TESTNET: bool(true),

  UNISWAP_API_KEY: optional,
  EVM_PRIVATE_KEY: optional,
  EVM_ADDRESS: optional,
  EVM_RPC_URL: optional,

  CRYPTOPANIC_TOKEN: optional,
  ETHOS_CLIENT: z.string().default('ghosty@0.1.0'),
  XAI_API_KEY: optional,

  SAFE_STOP_ENABLED: bool(true),
  SIMULATE_BRAIN_OFFLINE: bool(false),
  MAX_TRADE_USD: z.coerce.number().positive().default(25).catch(25),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Build config from an env-like object. Empty strings count as missing.
 * Never throws: optional keys stay undefined, malformed numbers fall back to defaults.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') cleaned[key] = value;
  }
  return ConfigSchema.parse(cleaned);
}
