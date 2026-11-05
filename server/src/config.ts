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

  HEDERA_ACCOUNT_ID: optional,
  HEDERA_PRIVATE_KEY: optional,
  /** Only used when HEDERA_PRIVATE_KEY is raw hex; DER keys carry their own type. */
  HEDERA_KEY_TYPE: z.enum(['ecdsa', 'ed25519']).default('ecdsa').catch('ecdsa'),
  HEDERA_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet').catch('testnet'),
  /** Pin an existing HCS audit topic instead of creating one (cached in server/.ghosty/hcs.json). */
  HEDERA_HCS_TOPIC_ID: optional,
  X402_FACILITATOR_URL: z.string().default('https://x402.org/facilitator'),
  /** Merchant account that receives /signal payments. Defaults to HEDERA_ACCOUNT_ID; must differ from the payer. */
  X402_PAY_TO: optional,
  /** Price of one GET /signal in tinybars (1 HBAR = 100,000,000). Default 0.01 HBAR. */
  X402_SIGNAL_PRICE_TINYBAR: z.coerce.number().int().positive().default(1_000_000).catch(1_000_000),
  /** Agent-side cap on a single payment, in tinybars. Default 0.1 HBAR. */
  X402_MAX_PER_CALL_TINYBAR: z.coerce.number().int().positive().default(10_000_000).catch(10_000_000),
  /** Agent-side cap on total spend per UTC day, in tinybars. Default 1 HBAR. */
  X402_MAX_SPEND_TINYBAR: z.coerce.number().int().positive().default(100_000_000).catch(100_000_000),
  /** Comma-separated hosts (optionally host:port) the agent may pay. */
  X402_ALLOWED_HOSTS: z
    .string()
    .default('localhost,127.0.0.1')
    .transform((v) =>
      v
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0),
    ),

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
