import { z } from 'zod';

/** Parse "true"/"1"/"yes"/"on" (case-insensitive) as true; anything else as false; missing → default. */
const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v.trim())));

const optional = z.string().optional();

/** Positive integer with a fallback for missing or malformed values. */
const posInt = (fallback: number) => z.coerce.number().int().positive().default(fallback).catch(fallback);

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000).catch(3000),
  HOST: z.string().default('0.0.0.0'),
  DEVICE_TOKEN: optional,

  GROQ_API_KEY: optional,
  GROQ_STT_MODEL: z.string().default('whisper-large-v3-turbo'),
  ELEVENLABS_API_KEY: optional,
  // "George", the voice used throughout the ElevenLabs API reference examples.
  ELEVENLABS_VOICE_ID: z.string().default('JBFqnCBsd6RMkjVDRZzb'),
  ELEVENLABS_MODEL_ID: z.string().default('eleven_flash_v2_5'),
  // TTS fallback only (gpt-4o-mini-tts, 24 kHz PCM resampled to 16 kHz). Used when ELEVENLABS_API_KEY is unset.
  OPENAI_API_KEY: optional,

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
  /** Builder-deployed (HIP-3) dexes to load besides the main dex. Testnet lists 250+ dexes, so never load all. */
  HL_DEXES: z.string().default('xyz'),
  /** Alias fallbacks when a HIP-3 market is missing on the network, e.g. "GOLD=BTC,WTI=ETH". Orders get `fallback: true`. */
  HL_FALLBACK_COINS: optional,

  UNISWAP_API_KEY: optional,
  UNISWAP_API_URL: z.string().default('https://trade-api.gateway.uniswap.org/v1'),
  /** Run the Uniswap spot leg before the perp legs. */
  UNISWAP_SPOT_LEG: bool(false),
  // Demo pair on Base Sepolia (84532). VERIFY before the event: pool liquidity is thin and addresses are per chain.
  // WETH: OP-stack predeploy 0x4200…0006. USDC: Circle's Base Sepolia USDC.
  UNISWAP_DEMO_TOKEN_IN: z.string().default('0x4200000000000000000000000000000000000006'),
  UNISWAP_DEMO_TOKEN_OUT: z.string().default('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
  /** tokenIn amount in base units. Default 0.0001 WETH (18 decimals). */
  UNISWAP_DEMO_AMOUNT: z.string().regex(/^[1-9][0-9]*$/).default('100000000000000').catch('100000000000000'),
  /** Max slippage in percent for the Trading API quote. Testnet pools are thin. */
  UNISWAP_SLIPPAGE_PCT: z.coerce.number().positive().max(50).default(1).catch(1),
  EVM_PRIVATE_KEY: optional,
  /** Watch-only address shown when no EVM_PRIVATE_KEY is set. With a key, the address is derived from it. */
  EVM_ADDRESS: optional,
  EVM_RPC_URL: optional,
  EVM_CHAIN_ID: z.coerce.number().int().positive().default(84532).catch(84532),

  CRYPTOPANIC_TOKEN: optional,
  // v1 is gone; valid paths are /api/{growth|growth_weekly|enterprise}/v2/posts/ (probed 2026-11-06).
  CRYPTOPANIC_API_URL: z.string().default('https://cryptopanic.com/api/growth/v2'),
  ETHOS_CLIENT: z.string().default('ghosty@0.1.0'),
  // Ethos needs no key; off by default so local dev and tests stay offline and deterministic.
  ETHOS_ENABLED: bool(false),
  ETHOS_API_URL: z.string().default('https://api.ethos.network/api/v2'),
  XAI_API_KEY: optional,
  XAI_MODEL: z.string().default('grok-4.7'),
  /** Comma-separated X handles (no @, max 20) passed as allowed_x_handles. Empty = built-in list. */
  XAI_X_HANDLES: optional,
  /** Minimum seconds between paid x_search calls; the poller reuses the cached result in between. */
  XAI_MIN_INTERVAL_SECONDS: posInt(300),

  /** true = use the keyless real providers (RSS, Polymarket). CryptoPanic/Grok switch on with their keys. */
  NEWS_LIVE: bool(false),
  /** Comma-separated feeds, each `name=url` or a bare url. Empty = CoinDesk, Cointelegraph, The Block, Decrypt. */
  NEWS_RSS_FEEDS: optional,
  NEWS_POLYMARKET_KEYWORDS: z.string().default('war,strike,ceasefire,invasion,sanction,missile,nuclear'),
  /** Optional Gamma tag_slug to narrow /events (e.g. geopolitics). */
  NEWS_POLYMARKET_TAG: optional,
  NEWS_WINDOW_MINUTES: posInt(120),
  NEWS_POLL_SECONDS: posInt(60),
  NEWS_PROVIDER_TIMEOUT_MS: posInt(8000),
  /** Where the aggregator persists last-seen ids, relative to the server's working directory. */
  NEWS_SEEN_PATH: z.string().default('.ghosty/news-seen.json'),

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
