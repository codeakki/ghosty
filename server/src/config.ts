import { z } from 'zod';
import { defaultMode, GHOSTY_MODES } from './mode.js';

/** Parse "true"/"1"/"yes"/"on" (case-insensitive) as true; anything else as false; missing → default. */
const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v.trim())));

/** Like bool, but missing stays undefined so loadConfig can pick a per-mode default. */
const boolOrUnset = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? undefined : /^(1|true|yes|on)$/i.test(v.trim())));

const optional = z.string().optional();

/** Positive integer with a fallback for missing or malformed values. */
const posInt = (fallback: number) => z.coerce.number().int().positive().default(fallback).catch(fallback);

/** Comma-separated list, trimmed, empties dropped. */
const list = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );

export const DEFAULT_MARKET_WATCHLIST = 'BTC,ETH,SOL,xyz:GOLD,xyz:CL,xyz:TSLA,xyz:NVDA,xyz:SP500';

const ConfigSchema = z.object({
  /** live (default): real providers or 503 not_configured, never fakes. test: offline fakes (npm test). */
  GHOSTY_MODE: z.enum(GHOSTY_MODES).optional().catch(undefined),

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

  /** Claude (Anthropic API): voice answers to questions and the news scout. Never decides trades (that is 0G). */
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  /** Answer questions and chit-chat on /voice and /voice/text with Claude. Default: on when ANTHROPIC_API_KEY is set. */
  CLAUDE_VOICE_ENABLED: boolOrUnset,
  /** Claude web-search news scout feeding the aggregator. Default: on when ANTHROPIC_API_KEY is set. */
  CLAUDE_SCOUT_ENABLED: boolOrUnset,
  CLAUDE_SCOUT_MINUTES: posInt(5),
  CLAUDE_SCOUT_QUERY: z
    .string()
    .default(
      'breaking geopolitical, regulatory, exchange-hack and macro news that could move BTC, ETH, gold, oil or US stocks in the last hour',
    ),
  /** Cost guard: at most this many scout cycles (Messages API calls) per UTC day. */
  CLAUDE_SCOUT_MAX_PER_DAY: posInt(200),

  OG_ROUTER_URL: z.string().default('https://router-api-testnet.integratenetwork.work/v1'),
  OG_API_KEY: optional,
  OG_PRIVATE_KEY: optional,
  OG_INDEXER_URL: z.string().default('https://indexer-storage-testnet-turbo.0g.ai'),
  /** Router model id (catalog: GET <OG_ROUTER_URL>/models). glm-4.7 supports response_format on mainnet. */
  OG_MODEL: z.string().default('glm-4.7'),
  /** Ask the router for `response_format: json_object`. Turn off for models without structured-output support. */
  OG_JSON_MODE: bool(true),
  /** Safe-stop reachability probe (GET <OG_ROUTER_URL>/models) timeout. Slow networks need more than a few seconds. */
  OG_HEALTH_TIMEOUT_MS: posInt(15_000),
  /** Per-attempt 0G decide() timeout; one retry on timeout or ECONNRESET only. */
  OG_DECIDE_TIMEOUT_MS: posInt(45_000),
  /** 0G Galileo EVM RPC used to submit storage transactions. */
  OG_RPC_URL: z.string().default('https://evmrpc-testnet.0g.ai'),
  /** 32-byte hex AES-256-GCM key for user memory. Unset → sha256-derived from OG_PRIVATE_KEY. */
  OG_MEMORY_KEY: optional,
  /** Buffer episodes and upload them OG_EPISODE_BATCH_SIZE at a time to save faucet gas. */
  OG_EPISODE_BATCH: bool(false),
  OG_EPISODE_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(5).catch(5),
  /** Local cache dir for root-hash pointers (default: server/.ghosty). */
  OG_DATA_DIR: optional,
  /** Where the newest memory root hash per account is kept: `file` (OG_DATA_DIR) or `ssm` (survives container restarts). */
  OG_POINTER_STORE: z.enum(['file', 'ssm']).default('file').catch('file'),
  OG_POINTER_PREFIX: z.string().default('/ghosty/memory'),

  // ---------- Hedera (accounts and keys: docs/hedera.md) ----------
  /** AGENT hot wallet: pays for intel via x402. Holds a small balance only (~20 HBAR + ~5 USDC). */
  HEDERA_ACCOUNT_ID: optional,
  HEDERA_PRIVATE_KEY: optional,
  /** Only used when a private key is raw hex; DER keys carry their own type. */
  HEDERA_KEY_TYPE: z.enum(['ecdsa', 'ed25519']).default('ecdsa').catch('ecdsa'),
  HEDERA_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet').catch('testnet'),
  /** TREASURY: tops up the agent and is the HCS topic admin. Read only by `npm run hedera:setup`, never by the server. */
  HEDERA_TREASURY_ACCOUNT_ID: optional,
  HEDERA_TREASURY_PRIVATE_KEY: optional,
  /** Signal Desk merchant key (account X402_PAY_TO). Read only by `npm run hedera:setup`, to associate it with USDC. */
  HEDERA_MERCHANT_PRIVATE_KEY: optional,
  /** HCS audit topic, created by `npm run hedera:setup`. Unset = no audit messages (the server never creates topics). */
  HEDERA_HCS_TOPIC_ID: optional,
  /** The topic's submit key: the only key that can write audit messages. Holds no funds. */
  HEDERA_HCS_SUBMIT_KEY: optional,
  /** Safety cap on audit messages per UTC day (each submit costs ~0.0008 HBAR, paid by the agent account). */
  HEDERA_HCS_MAX_MESSAGES_PER_DAY: posInt(500),
  /** Mirror node REST base. Default: the public Hedera mirror node for HEDERA_NETWORK. */
  HEDERA_MIRROR_URL: optional,
  /** HTS USDC token id. Default: Circle's USDC, 0.0.429274 on testnet (0.0.456858 on mainnet). */
  HEDERA_USDC_TOKEN_ID: optional,

  // ---------- x402 ----------
  /** Facilitator that verifies and settles payments. Default: Blocky402 for HEDERA_NETWORK (see defaultFacilitatorUrl). */
  X402_FACILITATOR_URL: optional,
  /** Before deciding on a shock headline, the agent buys the Signal Desk intel bundle itself, with no human approval. */
  X402_AUTOPAY: bool(true),
  /** Max time a decision waits for the intel purchase (402, sign, facilitator settle) before deciding without it. */
  X402_AUTOPAY_WAIT_MS: posInt(8000),
  /** Signal Desk merchant account that receives intel payments. Must differ from the agent account. */
  X402_PAY_TO: optional,
  /** Signal Desk runs as its own process on its own port (`npm run signal-desk`). */
  SIGNAL_DESK_PORT: z.coerce.number().int().min(1).max(65535).default(3101).catch(3101),
  /** Where the agent buys intel. Default http://127.0.0.1:$SIGNAL_DESK_PORT; in production, another host. */
  SIGNAL_DESK_URL: optional,
  /** Price of one intel bundle in tinybars (1 HBAR = 100,000,000). Default 0.01 HBAR. */
  X402_INTEL_PRICE_TINYBAR: posInt(1_000_000),
  /** Price of one intel bundle in USDC micro-units (6 decimals). Default 0.01 USDC. */
  X402_INTEL_PRICE_USDC_MICROS: posInt(10_000),
  /** Which asset the agent pays with when the desk accepts both. */
  X402_PREFERRED_ASSET: z.enum(['usdc', 'hbar']).default('usdc').catch('usdc'),
  /** Agent-side cap on a single payment. Default 0.1 HBAR / 0.1 USDC. */
  X402_MAX_PER_CALL_TINYBAR: posInt(10_000_000),
  X402_MAX_PER_CALL_USDC_MICROS: posInt(100_000),
  /** Agent-side cap on total spend per UTC day. Default 5 HBAR (500 buys) / 2 USDC (200 buys). */
  X402_MAX_SPEND_TINYBAR: posInt(500_000_000),
  X402_MAX_SPEND_USDC_MICROS: posInt(2_000_000),
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
  /** Who signs orders: `key` = HL_AGENT_PRIVATE_KEY on this server; `dabao` = the Dabao in the pod (key never here). */
  HL_SIGNER: z.enum(['key', 'dabao']).default('key').catch('key'),
  /** The Dabao's address (its GET_INFO reply), approved by the master as an API wallet. Required for HL_SIGNER=dabao. */
  HL_DABAO_ADDRESS: optional,
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
  // Ethos needs no key. Default: on in live mode, off in test mode (offline, deterministic).
  ETHOS_ENABLED: boolOrUnset,
  ETHOS_API_URL: z.string().default('https://api.ethos.network/api/v2'),
  XAI_API_KEY: optional,
  XAI_MODEL: z.string().default('grok-4.7'),
  /** Comma-separated X handles (no @, max 20) passed as allowed_x_handles. Empty = built-in list. */
  XAI_X_HANDLES: optional,
  /** Minimum seconds between paid x_search calls; the poller reuses the cached result in between. */
  XAI_MIN_INTERVAL_SECONDS: posInt(300),

  /**
   * true = use the keyless real providers (RSS, Polymarket). CryptoPanic/Grok switch on with their keys.
   * Default: true in live mode, false in test mode.
   */
  NEWS_LIVE: boolOrUnset,
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
  /** Claude hears every voice turn and places explicit spoken orders on Hyperliquid, capped at MAX_TRADE_USD. */
  VOICE_ORDERS_ENABLED: bool(false),
  /**
   * Let a simulation run also place REAL orders on Hyperliquid MAINNET when a sim trade is confirmed (opt-in per run
   * too). Always mainnet, whatever HL_TESTNET says. Off by default.
   */
  SIM_LIVE_ORDERS: bool(false),
  /** Notional of each real sim leg. Hyperliquid's minimum is $10, so anything lower is raised to 10. */
  SIM_LIVE_ORDER_USD: z.coerce.number().positive().default(11).catch(11),
  /** Most real notional one simulation run may place in total; later legs are refused. */
  SIM_LIVE_MAX_RUN_USD: z.coerce.number().positive().default(50).catch(50),
  /** A presented decision (spoken reply or alert) can be confirmed for this long; later presses answer 409 alert_expired. */
  PENDING_DECISION_TTL_SEC: posInt(120),

  /** Read-only Hyperliquid prices for the terminal. Independent of HL_TESTNET (which only drives execution). */
  MARKET_DATA_NETWORK: z.enum(['mainnet', 'testnet']).default('mainnet').catch('mainnet'),
  /** Coins shown in the terminal. HIP-3 coins carry their dex prefix (xyz:GOLD). Missing ones are reported, not faked. */
  MARKET_WATCHLIST: list(DEFAULT_MARKET_WATCHLIST),
  /** Built terminal (Vite dist) served at `/` when its index.html exists. Relative paths resolve from the working directory. */
  TERMINAL_DIST: optional,
  /** Origins allowed by CORS in live mode (the Vite dev server). */
  CORS_ORIGINS: list('http://localhost:5173,http://127.0.0.1:5173'),
});

type ParsedConfig = z.infer<typeof ConfigSchema>;

export type Config = Omit<
  ParsedConfig,
  | 'GHOSTY_MODE'
  | 'NEWS_LIVE'
  | 'ETHOS_ENABLED'
  | 'X402_FACILITATOR_URL'
  | 'HEDERA_MIRROR_URL'
  | 'HEDERA_USDC_TOKEN_ID'
  | 'SIGNAL_DESK_URL'
  | 'CLAUDE_VOICE_ENABLED'
  | 'CLAUDE_SCOUT_ENABLED'
> & {
  GHOSTY_MODE: 'live' | 'test';
  X402_FACILITATOR_URL: string;
  HEDERA_MIRROR_URL: string;
  HEDERA_USDC_TOKEN_ID: string;
  SIGNAL_DESK_URL: string;
  NEWS_LIVE: boolean;
  ETHOS_ENABLED: boolean;
  CLAUDE_VOICE_ENABLED: boolean;
  CLAUDE_SCOUT_ENABLED: boolean;
};

/**
 * Build config from an env-like object. Empty strings count as missing.
 * Never throws: optional keys stay undefined, malformed numbers fall back to defaults.
 * GHOSTY_MODE missing from `env` falls back to defaultMode() (process env, then "test" under node --test, else "live").
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') cleaned[key] = value;
  }
  const parsed = ConfigSchema.parse(cleaned);
  const mode = parsed.GHOSTY_MODE ?? defaultMode();
  const live = mode === 'live';
  return {
    ...parsed,
    GHOSTY_MODE: mode,
    NEWS_LIVE: parsed.NEWS_LIVE ?? live,
    ETHOS_ENABLED: parsed.ETHOS_ENABLED ?? live,
    X402_FACILITATOR_URL: parsed.X402_FACILITATOR_URL ?? defaultFacilitatorUrl(parsed.HEDERA_NETWORK),
    HEDERA_MIRROR_URL: (parsed.HEDERA_MIRROR_URL ?? defaultMirrorUrl(parsed.HEDERA_NETWORK)).replace(/\/+$/, ''),
    HEDERA_USDC_TOKEN_ID: parsed.HEDERA_USDC_TOKEN_ID ?? (parsed.HEDERA_NETWORK === 'mainnet' ? '0.0.456858' : '0.0.429274'),
    SIGNAL_DESK_URL: (parsed.SIGNAL_DESK_URL ?? `http://127.0.0.1:${parsed.SIGNAL_DESK_PORT}`).replace(/\/+$/, ''),
    CLAUDE_VOICE_ENABLED: Boolean(parsed.ANTHROPIC_API_KEY) && (parsed.CLAUDE_VOICE_ENABLED ?? true),
    CLAUDE_SCOUT_ENABLED: Boolean(parsed.ANTHROPIC_API_KEY) && (parsed.CLAUDE_SCOUT_ENABLED ?? true),
  };
}

/** Public Hedera mirror node (REST): verifies settled payments and reads the HCS audit topic. */
export function defaultMirrorUrl(network: 'testnet' | 'mainnet'): string {
  return network === 'mainnet' ? 'https://mainnet.mirrornode.hedera.com' : 'https://testnet.mirrornode.hedera.com';
}

/**
 * Blocky402: open (no API key) and lists hedera:testnet / hedera:mainnet in /supported (checked 2026-11-06).
 * https://x402.org/facilitator, the old default, reset connections on the bare host; only www.x402.org answered.
 */
export function defaultFacilitatorUrl(network: 'testnet' | 'mainnet'): string {
  return network === 'mainnet' ? 'https://api.blocky402.com' : 'https://api.testnet.blocky402.com';
}
