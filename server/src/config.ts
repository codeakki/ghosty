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
  X402_FACILITATOR_URL: z.string().default('https://x402.org/facilitator'),

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
