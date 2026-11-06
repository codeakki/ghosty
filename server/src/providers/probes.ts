/**
 * Real health probes for every provider, used by GET /providers/status and `npm run doctor`.
 * Each probe makes at most a few cheap read-only calls. Secrets go in headers or query strings only and never
 * appear in `detail`: network errors are reduced to their code ("timed out", "ENOTFOUND"), never the URL.
 */
import Anthropic from '@anthropic-ai/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { xUserkey } from '../credibility/ethos.js';
import { parseFeedList } from '../news/rss.js';
import { POLYMARKET_GAMMA } from '../news/polymarket.js';
import { DEFAULT_STATE_DIR, readJsonFile } from '../payments/hedera.js';
import { chainFor, isAddress, normalizePrivateKey } from '../wallet/account.js';
import { HL_INFO_URL } from '../market/service.js';

export type ProviderState = 'live' | 'degraded' | 'offline' | 'not_configured';
export type ProviderTrack = '0g' | 'hedera' | 'uniswap' | 'hyperliquid' | 'data' | 'audio';

export interface ProbeResult {
  state: ProviderState;
  detail: string;
  missingEnv?: string[];
  /** What to do next, with the exact URL (doctor prints it). */
  nextAction?: string;
}

export interface ProbeContext {
  config: Config;
  fetch: typeof fetch;
  /** Aborts when the probe's budget (5 s, or the probe's own timeoutMs) runs out. */
  signal: AbortSignal;
  /** Per-request timeout inside the budget. Default ATTEMPT_TIMEOUT_MS. */
  attemptTimeoutMs?: number;
}

export interface ProviderProbe {
  id: string;
  label: string;
  track: ProviderTrack;
  /** Whole-probe budget when it needs more than the registry default (slow upstreams). */
  timeoutMs?: number;
  run(ctx: ProbeContext): Promise<ProbeResult>;
}

// ---------------------------------------------------------------------------
// helpers

/** A probe failure message without URLs or secrets. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error';
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'timed out';
  const cause = (err as { cause?: { code?: unknown; name?: unknown } }).cause;
  if (cause && typeof cause.code === 'string') return `network error (${cause.code})`;
  if (cause && typeof cause.name === 'string' && /Timeout|Abort/.test(cause.name)) return 'timed out';
  if (err.name === 'TypeError') return 'network error';
  return err.name;
}

interface HttpResult {
  status: number;
  ok: boolean;
  body: unknown;
}

/** One request attempt may use this much of the probe's 5 s budget, so the probe sees its own timeout. */
export const ATTEMPT_TIMEOUT_MS = 4_500;

const isTimeout = (err: unknown) => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

/** fetch with a per-attempt timeout; a fast connection error (reset, refused) is retried once. */
async function http(ctx: ProbeContext, url: string, init: RequestInit = {}): Promise<HttpResult> {
  try {
    return await attempt(ctx, url, init);
  } catch (err) {
    if (isTimeout(err) || ctx.signal.aborted) throw err;
    return attempt(ctx, url, init);
  }
}

async function attempt(ctx: ProbeContext, url: string, init: RequestInit): Promise<HttpResult> {
  const res = await ctx.fetch(url, { ...init, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS)]) });
  const text = await res.text().catch(() => '');
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON (RSS) */
  }
  return { status: res.status, ok: res.ok, body };
}

async function postJson(ctx: ProbeContext, url: string, payload: unknown): Promise<HttpResult> {
  return http(ctx, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}

/** eth_getBalance in wei, via raw JSON-RPC (so tests can mock fetch). */
async function evmBalance(ctx: ProbeContext, rpcUrl: string, address: string): Promise<bigint> {
  const res = await postJson(ctx, rpcUrl, { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] });
  const result = (res.body as { result?: unknown; error?: { message?: string } } | null)?.result;
  if (!res.ok || typeof result !== 'string') throw new Error(`rpc ${res.status}`);
  return BigInt(result);
}

/** wei → "1.2345" with 4 decimals. */
export function formatUnits18(wei: bigint, decimals = 4): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, decimals);
  return `${whole}.${frac}`;
}

const notConfigured = (missingEnv: string[], detail: string, nextAction?: string): ProbeResult => ({
  state: 'not_configured',
  detail,
  missingEnv,
  nextAction,
});

const missing = (config: Config, keys: Array<keyof Config>): string[] =>
  keys.filter((k) => {
    const v = config[k];
    return v === undefined || (typeof v === 'string' && v.trim() === '');
  }) as string[];

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Where to get an account / funds for the configured network (faucets and portal.hedera.com are testnet-only). */
function hederaAccountHint(config: Config, what: string): string {
  return config.HEDERA_NETWORK === 'mainnet'
    ? `Create a Hedera mainnet account (any Hedera wallet, e.g. HashPack) funded with real HBAR and set ${what}`
    : `Create a ${config.HEDERA_NETWORK} account at https://portal.hedera.com and set ${what}`;
}

function zeroGFundHint(config: Config, address?: string): string {
  const who = address ?? 'it';
  return /testnet|galileo/i.test(config.OG_RPC_URL)
    ? `Fund ${who} at https://faucet.0g.ai`
    : `Fund ${who} with a little mainnet 0G (storage uploads pay gas in 0G)`;
}

function mirrorBase(config: Config): string {
  return config.HEDERA_NETWORK === 'mainnet' ? 'https://mainnet-public.mirrornode.hedera.com' : 'https://testnet.mirrornode.hedera.com';
}

function httpFailure(name: string, res: HttpResult, nextAction?: string): ProbeResult {
  if (res.status === 401 || res.status === 403) return { state: 'offline', detail: `${name} rejected the key (${res.status})`, nextAction };
  return { state: 'offline', detail: `${name} answered ${res.status}`, nextAction };
}

// ---------------------------------------------------------------------------
// audio

const groq: ProviderProbe = {
  id: 'groq',
  label: 'Groq Whisper (speech-to-text)',
  track: 'audio',
  async run(ctx) {
    const key = ctx.config.GROQ_API_KEY;
    const next = 'Create a key at https://console.groq.com/keys and set GROQ_API_KEY';
    if (!key) return notConfigured(['GROQ_API_KEY'], '/voice answers 503 not_configured until a key is set', next);
    const res = await http(ctx, 'https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) return httpFailure('Groq', res, next);
    const ids = ((res.body as { data?: Array<{ id?: string }> })?.data ?? []).map((m) => m.id);
    const model = ctx.config.GROQ_STT_MODEL;
    if (!ids.includes(model)) return { state: 'degraded', detail: `key valid, but model ${model} is not listed (${ids.length} models)` };
    return { state: 'live', detail: `key valid, ${model} available` };
  },
};

const elevenlabs: ProviderProbe = {
  id: 'elevenlabs',
  label: 'ElevenLabs (text-to-speech)',
  track: 'audio',
  async run(ctx) {
    const key = ctx.config.ELEVENLABS_API_KEY;
    const next = 'Create a key at https://elevenlabs.io/app/settings/api-keys and set ELEVENLABS_API_KEY';
    if (!key) {
      const fallback = ctx.config.OPENAI_API_KEY ? 'OpenAI TTS fallback is used instead' : '/voice answers 503 not_configured';
      return notConfigured(['ELEVENLABS_API_KEY'], fallback, next);
    }
    const headers = { 'xi-api-key': key };
    const user = await http(ctx, 'https://api.elevenlabs.io/v1/user', { headers });
    if (user.ok) {
      const sub = (user.body as { subscription?: { tier?: string; character_count?: number; character_limit?: number } })?.subscription;
      const used = sub?.character_count !== undefined && sub.character_limit ? `, ${sub.character_count}/${sub.character_limit} chars used` : '';
      return { state: 'live', detail: `key valid, tier ${sub?.tier ?? 'unknown'}${used}` };
    }
    // Restricted keys may lack user_read; a voices call still proves the key works.
    const voices = await http(ctx, 'https://api.elevenlabs.io/v1/voices', { headers });
    if (voices.ok) return { state: 'live', detail: 'key valid (no user_read permission, tier unknown)' };
    return httpFailure('ElevenLabs', voices, next);
  },
};

const openaiTts: ProviderProbe = {
  id: 'openai-tts',
  label: 'OpenAI TTS (optional fallback)',
  track: 'audio',
  async run(ctx) {
    const key = ctx.config.OPENAI_API_KEY;
    const next = 'Optional: create a key at https://platform.openai.com/api-keys and set OPENAI_API_KEY';
    if (!key) return notConfigured(['OPENAI_API_KEY'], 'optional fallback when ELEVENLABS_API_KEY is unset', next);
    const res = await http(ctx, 'https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) return httpFailure('OpenAI', res, next);
    return { state: 'live', detail: ctx.config.ELEVENLABS_API_KEY ? 'key valid (standby: ElevenLabs is primary)' : 'key valid, used for TTS' };
  },
};

// ---------------------------------------------------------------------------
// 0G

/** The 0G Router is often slow from far-away networks: give its probe 12 s instead of 5. */
export const ZERO_G_ROUTER_PROBE_TIMEOUT_MS = 12_000;

const zeroGRouter: ProviderProbe = {
  id: '0g-router',
  label: '0G Compute Router (decisions)',
  track: '0g',
  timeoutMs: ZERO_G_ROUTER_PROBE_TIMEOUT_MS,
  async run(ctx) {
    const base = ctx.config.OG_ROUTER_URL.replace(/\/+$/, '');
    const testnet = /testnet/i.test(base);
    const keyUrl = testnet ? 'https://pc.testnet.0g.ai' : 'https://pc.0g.ai';
    let res: HttpResult;
    try {
      res = await http(ctx, `${base}/models`);
    } catch (err) {
      const detail = `router unreachable: ${describeError(err)}`;
      const nextAction = testnet
        ? 'Testnet router TLS is flaky: try OG_ROUTER_URL=https://router-api.0g.ai/v1 with a key from https://pc.0g.ai'
        : `Check OG_ROUTER_URL; keys at ${keyUrl}`;
      if (!ctx.config.OG_API_KEY) return notConfigured(['OG_API_KEY'], `${detail}; decisions safe-stop until OG_API_KEY is set`, nextAction);
      return { state: 'offline', detail, nextAction };
    }
    if (!res.ok) {
      if (!ctx.config.OG_API_KEY) return notConfigured(['OG_API_KEY'], `router answered ${res.status}; decisions safe-stop`, `Keys at ${keyUrl}`);
      return httpFailure('0G Router', res);
    }
    const ids = ((res.body as { data?: Array<{ id?: string }> })?.data ?? []).map((m) => m.id);
    const hasModel = ids.includes(ctx.config.OG_MODEL);
    const models = `${ids.length} models${hasModel ? `, ${ctx.config.OG_MODEL} listed` : `, ${ctx.config.OG_MODEL} NOT listed`}`;
    if (!ctx.config.OG_API_KEY) {
      return notConfigured(['OG_API_KEY'], `router reachable (${models}); decisions safe-stop until OG_API_KEY is set`, `Create a Router API key at ${keyUrl} and set OG_API_KEY`);
    }
    if (!hasModel) return { state: 'degraded', detail: `key set; ${models}`, nextAction: `Pick OG_MODEL from ${base}/models` };
    return { state: 'live', detail: `key set; ${models}` };
  },
};

const zeroGStorage: ProviderProbe = {
  id: '0g-storage',
  label: '0G Storage (memory + episode log)',
  track: '0g',
  async run(ctx) {
    const key = normalizePrivateKey(ctx.config.OG_PRIVATE_KEY);
    const next = `Set OG_PRIVATE_KEY (any EVM key). ${zeroGFundHint(ctx.config)}`;
    if (!key) return notConfigured(['OG_PRIVATE_KEY'], 'memory and episode log answer 503 not_configured', next);
    const address = privateKeyToAccount(key).address;
    const wei = await evmBalance(ctx, ctx.config.OG_RPC_URL, address);
    const bal = `${formatUnits18(wei)} 0G`;
    if (wei === 0n) return { state: 'degraded', detail: `${shortAddr(address)} has 0 0G: uploads will fail`, nextAction: zeroGFundHint(ctx.config, address) };
    return { state: 'live', detail: `${shortAddr(address)} balance ${bal}` };
  },
};

// ---------------------------------------------------------------------------
// Hedera

async function hederaAccount(ctx: ProbeContext, accountId: string): Promise<{ ok: true; tinybar: number } | { ok: false; detail: string }> {
  const res = await http(ctx, `${mirrorBase(ctx.config)}/api/v1/accounts/${encodeURIComponent(accountId)}`);
  if (res.status === 404) return { ok: false, detail: `account ${accountId} not found on ${ctx.config.HEDERA_NETWORK}` };
  if (!res.ok) return { ok: false, detail: `mirror node answered ${res.status}` };
  const tinybar = Number((res.body as { balance?: { balance?: unknown } })?.balance?.balance ?? NaN);
  return Number.isFinite(tinybar) ? { ok: true, tinybar } : { ok: false, detail: 'mirror node returned no balance' };
}

const hbar = (tinybar: number) => `${(tinybar / 100_000_000).toFixed(4)} HBAR`;

const hederaPayer: ProviderProbe = {
  id: 'hedera-payer',
  label: 'Hedera payer (agent wallet, x402 client)',
  track: 'hedera',
  async run(ctx) {
    const miss = missing(ctx.config, ['HEDERA_ACCOUNT_ID', 'HEDERA_PRIVATE_KEY']);
    const next = hederaAccountHint(ctx.config, 'HEDERA_ACCOUNT_ID + HEDERA_PRIVATE_KEY');
    if (miss.length > 0) return notConfigured(miss, 'POST /sim/pay-signal answers 503 not_configured', next);
    const id = ctx.config.HEDERA_ACCOUNT_ID as string;
    const acct = await hederaAccount(ctx, id);
    if (!acct.ok) return { state: 'offline', detail: acct.detail, nextAction: next };
    if (acct.tinybar < ctx.config.X402_INTEL_PRICE_TINYBAR) {
      return { state: 'degraded', detail: `${id} balance ${hbar(acct.tinybar)} is below one intel payment`, nextAction: ctx.config.HEDERA_NETWORK === 'mainnet' ? `Send HBAR to ${id}` : 'Fund it at https://portal.hedera.com/faucet' };
    }
    return { state: 'live', detail: `${id} balance ${hbar(acct.tinybar)}` };
  },
};

const hederaMerchant: ProviderProbe = {
  id: 'hedera-merchant',
  label: 'Hedera merchant (Signal Desk, receives intel payments)',
  track: 'hedera',
  async run(ctx) {
    const payTo = ctx.config.X402_PAY_TO;
    const next = hederaAccountHint(ctx.config, 'X402_PAY_TO (a second account)');
    if (!payTo) return notConfigured(['X402_PAY_TO'], 'Signal Desk answers 503 payments_not_configured', next);
    if (payTo === ctx.config.HEDERA_ACCOUNT_ID) {
      return { state: 'degraded', detail: 'X402_PAY_TO equals the payer: the agent refuses a self-transfer', missingEnv: [], nextAction: next };
    }
    const acct = await hederaAccount(ctx, payTo);
    if (!acct.ok) return { state: 'offline', detail: acct.detail, nextAction: next };
    return { state: 'live', detail: `${payTo} exists, balance ${hbar(acct.tinybar)}` };
  },
};

const x402Facilitator: ProviderProbe = {
  id: 'x402-facilitator',
  label: 'x402 facilitator',
  track: 'hedera',
  async run(ctx) {
    const base = ctx.config.X402_FACILITATOR_URL.replace(/\/+$/, '');
    const network = `hedera:${ctx.config.HEDERA_NETWORK}`;
    const res = await http(ctx, `${base}/supported`);
    if (!res.ok) return { state: 'offline', detail: `/supported answered ${res.status}` };
    const kinds = (res.body as { kinds?: Array<{ network?: string; scheme?: string }> })?.kinds ?? [];
    if (!kinds.some((k) => k.network === network)) {
      return {
        state: 'degraded',
        detail: `facilitator does not list ${network}`,
        nextAction:
          ctx.config.HEDERA_NETWORK === 'mainnet'
            ? 'Pick a facilitator that lists hedera:mainnet in /supported, e.g. X402_FACILITATOR_URL=https://api.blocky402.com'
            : 'Try X402_FACILITATOR_URL=https://testnet.facilitator.launa.dev or https://api.testnet.blocky402.com',
      };
    }
    return { state: 'live', detail: `${network} supported (${kinds.length} kinds)` };
  },
};

const hcsAudit: ProviderProbe = {
  id: 'hcs-audit',
  label: 'HCS audit topic',
  track: 'hedera',
  async run(ctx) {
    const miss = missing(ctx.config, ['HEDERA_ACCOUNT_ID', 'HEDERA_PRIVATE_KEY']);
    if (miss.length > 0) return notConfigured(miss, 'audit log is off without the payer keys', 'Set the Hedera payer keys (https://portal.hedera.com)');
    const cached = readJsonFile<{ network?: string; topicId?: string }>(join(DEFAULT_STATE_DIR, 'hcs.json'));
    const topicId = ctx.config.HEDERA_HCS_TOPIC_ID ?? (cached?.network === ctx.config.HEDERA_NETWORK ? cached.topicId : undefined);
    if (!topicId) return { state: 'degraded', detail: 'no topic yet: one is created on the first payment', nextAction: 'Run npm run x402:demo once, or set HEDERA_HCS_TOPIC_ID' };
    const res = await http(ctx, `${mirrorBase(ctx.config)}/api/v1/topics/${encodeURIComponent(topicId)}`);
    if (res.status === 404) return { state: 'offline', detail: `topic ${topicId} not found on ${ctx.config.HEDERA_NETWORK}` };
    if (!res.ok) return { state: 'offline', detail: `mirror node answered ${res.status}` };
    return { state: 'live', detail: `topic ${topicId}` };
  },
};

// ---------------------------------------------------------------------------
// Hyperliquid

const hyperliquid: ProviderProbe = {
  id: 'hyperliquid',
  label: 'Hyperliquid perps (execution)',
  track: 'hyperliquid',
  async run(ctx) {
    const { config } = ctx;
    const net = config.HL_TESTNET ? 'testnet' : 'mainnet';
    const app = config.HL_TESTNET ? 'https://app.hyperliquid-testnet.xyz' : 'https://app.hyperliquid.xyz';
    const url = HL_INFO_URL[net];
    const master = isAddress(config.HL_MASTER_ADDRESS) ? config.HL_MASTER_ADDRESS : undefined;
    const agentKey = normalizePrivateKey(config.HL_AGENT_PRIVATE_KEY);
    const miss = [...(master ? [] : ['HL_MASTER_ADDRESS']), ...(agentKey ? [] : ['HL_AGENT_PRIVATE_KEY'])];
    if (!master) {
      // Reachability still tells the user the venue itself is fine.
      const reach = await postJson(ctx, url, { type: 'perpDexs' }).then(
        (res) => (res.ok ? `${net} info API reachable` : `${net} info API answered ${res.status}`),
        (err: unknown) => `${net} info API unreachable (${describeError(err)})`,
      );
      return notConfigured(miss, `${reach}; orders answer 503 not_configured`, `Approve an API wallet at ${app}/API, then set HL_MASTER_ADDRESS + HL_AGENT_PRIVATE_KEY`);
    }
    const dexes = ['', ...config.HL_DEXES.split(',').map((d) => d.trim()).filter(Boolean)];
    const states = await Promise.all(
      dexes.map((dex) => postJson(ctx, url, { type: 'clearinghouseState', user: master, ...(dex ? { dex } : {}) })),
    );
    const margins: Record<string, number> = {};
    for (const [i, res] of states.entries()) {
      const dex = dexes[i] ?? '';
      if (!res.ok) return { state: 'offline', detail: `clearinghouseState(${dex || 'main'}) answered ${res.status}` };
      margins[dex || 'main'] = Number((res.body as { marginSummary?: { accountValue?: unknown } })?.marginSummary?.accountValue ?? 0) || 0;
    }
    const marginText = Object.entries(margins)
      .map(([d, v]) => `${d} $${v.toFixed(2)}`)
      .join(', ');
    const problems: string[] = [];
    let nextAction: string | undefined;
    for (const dex of dexes.slice(1)) {
      if ((margins[dex] ?? 0) <= 0) {
        problems.push(`${dex} dex margin is 0`);
        nextAction = `Move USDC into the ${dex} dex margin at ${app}/trade (HIP-3 markets use their own margin)`;
      }
    }
    if (agentKey) {
      const agent = privateKeyToAccount(agentKey).address.toLowerCase();
      const res = await postJson(ctx, url, { type: 'extraAgents', user: master });
      if (res.ok && Array.isArray(res.body)) {
        const approved = (res.body as Array<{ address?: string }>).some((a) => a.address?.toLowerCase() === agent);
        if (!approved) {
          problems.push(`agent ${shortAddr(agent)} not in extraAgents`);
          nextAction ??= `Approve the agent at ${app}/API`;
        }
      }
    } else {
      problems.push('HL_AGENT_PRIVATE_KEY not set: read-only');
      nextAction ??= `Approve an API wallet at ${app}/API and set HL_AGENT_PRIVATE_KEY`;
    }
    const detail = `${net} ${shortAddr(master)} margin: ${marginText}${problems.length ? `; ${problems.join('; ')}` : ''}`;
    if (!agentKey) return { state: 'not_configured', detail, missingEnv: miss, nextAction };
    return { state: problems.length ? 'degraded' : 'live', detail, nextAction };
  },
};

// ---------------------------------------------------------------------------
// Uniswap

const uniswap: ProviderProbe = {
  id: 'uniswap',
  label: 'Uniswap Trading API (spot leg)',
  track: 'uniswap',
  async run(ctx) {
    const { config } = ctx;
    const key = normalizePrivateKey(config.EVM_PRIVATE_KEY);
    const miss = [...(config.UNISWAP_API_KEY ? [] : ['UNISWAP_API_KEY']), ...(key ? [] : ['EVM_PRIVATE_KEY'])];
    const address = key ? privateKeyToAccount(key).address : isAddress(config.EVM_ADDRESS) ? config.EVM_ADDRESS : undefined;
    let balanceText = '';
    let wei: bigint | undefined;
    if (address) {
      const chain = chainFor(config.EVM_CHAIN_ID, config.EVM_RPC_URL);
      const rpc = config.EVM_RPC_URL ?? chain.rpcUrls.default.http[0];
      if (rpc) {
        wei = await evmBalance(ctx, rpc, address);
        balanceText = `${shortAddr(address)} on ${chain.name} (${config.EVM_CHAIN_ID}): ${formatUnits18(wei)} ${chain.nativeCurrency.symbol}`;
      }
    }
    const spot = config.UNISWAP_SPOT_LEG ? 'spot leg on' : 'spot leg off (UNISWAP_SPOT_LEG=false)';
    if (miss.length > 0) {
      return notConfigured(
        miss,
        `${balanceText ? `${balanceText}; ` : ''}${spot}`,
        'Get a Trading API key at https://developers.uniswap.org/dashboard and set UNISWAP_API_KEY + EVM_PRIVATE_KEY',
      );
    }
    if (wei === 0n) return { state: 'degraded', detail: `${balanceText}; no gas`, nextAction: `Fund ${address} on chain ${config.EVM_CHAIN_ID}` };
    return { state: 'live', detail: `API key set; ${balanceText}; ${spot}` };
  },
};

// ---------------------------------------------------------------------------
// data

const rss: ProviderProbe = {
  id: 'rss',
  label: 'RSS feeds',
  track: 'data',
  async run(ctx) {
    if (!ctx.config.NEWS_LIVE) return notConfigured(['NEWS_LIVE'], 'live news is off (NEWS_LIVE=false)', 'Set NEWS_LIVE=true (no key needed)');
    const feeds = Object.entries(parseFeedList(ctx.config.NEWS_RSS_FEEDS));
    const results = await Promise.allSettled(feeds.map(([, url]) => http(ctx, url, { headers: { accept: 'application/rss+xml, application/xml, text/xml' } })));
    const ok = feeds.filter((_, i) => {
      const r = results[i];
      return r?.status === 'fulfilled' && r.value.ok;
    });
    const down = feeds.filter((f) => !ok.includes(f)).map(([name]) => name);
    const detail = `${ok.length}/${feeds.length} feeds reachable${down.length ? ` (down: ${down.join(', ')})` : ''}`;
    if (ok.length === 0) return { state: 'offline', detail };
    return { state: ok.length === feeds.length ? 'live' : 'degraded', detail };
  },
};

const polymarket: ProviderProbe = {
  id: 'polymarket',
  label: 'Polymarket Gamma',
  track: 'data',
  async run(ctx) {
    if (!ctx.config.NEWS_LIVE) return notConfigured(['NEWS_LIVE'], 'live news is off (NEWS_LIVE=false)', 'Set NEWS_LIVE=true (no key needed)');
    const hint = 'Polymarket is blocked on many Indian ISPs: use a VPN or another network';
    try {
      const res = await http(ctx, `${POLYMARKET_GAMMA}/events?limit=1&active=true&closed=false`);
      if (!res.ok) return { state: 'offline', detail: `Gamma answered ${res.status}`, nextAction: hint };
      return { state: 'live', detail: 'Gamma /events reachable' };
    } catch (err) {
      return { state: 'offline', detail: `unreachable: ${describeError(err)}`, nextAction: hint };
    }
  },
};

const cryptopanic: ProviderProbe = {
  id: 'cryptopanic',
  label: 'CryptoPanic',
  track: 'data',
  async run(ctx) {
    const token = ctx.config.CRYPTOPANIC_TOKEN;
    const next = 'Get a token at https://cryptopanic.com/developers/api/ and set CRYPTOPANIC_TOKEN';
    if (!token) return notConfigured(['CRYPTOPANIC_TOKEN'], 'left out of the news feed', next);
    const base = ctx.config.CRYPTOPANIC_API_URL.replace(/\/+$/, '');
    const params = new URLSearchParams({ auth_token: token, public: 'true', kind: 'news' });
    const res = await http(ctx, `${base}/posts/?${params.toString()}`);
    if (!res.ok) return httpFailure('CryptoPanic', res, next);
    const n = (res.body as { results?: unknown[] })?.results?.length ?? 0;
    return { state: 'live', detail: `token valid, ${n} posts` };
  },
};

const ethos: ProviderProbe = {
  id: 'ethos',
  label: 'Ethos credibility',
  track: 'data',
  async run(ctx) {
    if (!ctx.config.ETHOS_ENABLED) return notConfigured(['ETHOS_ENABLED'], 'credibility weights unknown (Ethos off)', 'Set ETHOS_ENABLED=true (no key needed)');
    const base = ctx.config.ETHOS_API_URL.replace(/\/+$/, '');
    const res = await http(ctx, `${base}/score/userkey?userkey=${encodeURIComponent(xUserkey('Reuters'))}`, {
      headers: { 'X-Ethos-Client': ctx.config.ETHOS_CLIENT },
    });
    if (!res.ok && res.status !== 404) return { state: 'offline', detail: `Ethos answered ${res.status}` };
    const score = (res.body as { score?: unknown })?.score;
    return { state: 'live', detail: typeof score === 'number' ? `reachable (@Reuters score ${score})` : 'reachable' };
  },
};

const xai: ProviderProbe = {
  id: 'xai',
  label: 'xAI Grok x_search',
  track: 'data',
  async run(ctx) {
    const key = ctx.config.XAI_API_KEY;
    const next = 'Optional: create a key at https://console.x.ai and set XAI_API_KEY';
    if (!key) return notConfigured(['XAI_API_KEY'], 'X posts left out of the news feed (optional)', next);
    const res = await http(ctx, 'https://api.x.ai/v1/models', { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) return httpFailure('xAI', res, next);
    return { state: 'live', detail: `key valid, model ${ctx.config.XAI_MODEL}` };
  },
};

/**
 * Claude (Anthropic API): GET /v1/models/{ANTHROPIC_MODEL} with the key. Costs no tokens. Claude researches and
 * talks (voice answers, news scout); it never decides trades, so a dead key only silences those features.
 */
const claude: ProviderProbe = {
  id: 'claude',
  label: 'Claude (voice answers + news scout)',
  track: 'data',
  async run(ctx) {
    const key = ctx.config.ANTHROPIC_API_KEY;
    const next = 'Create a key at https://console.anthropic.com/settings/keys and set ANTHROPIC_API_KEY';
    if (!key) return notConfigured(['ANTHROPIC_API_KEY'], 'questions go to the 0G path; no Claude news scout', next);
    const client = new Anthropic({ apiKey: key, fetch: ctx.fetch, maxRetries: 0, timeout: ctx.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS });
    const model = ctx.config.ANTHROPIC_MODEL;
    try {
      const info = await client.models.retrieve(model, {}, { signal: ctx.signal });
      const features = [ctx.config.CLAUDE_VOICE_ENABLED ? 'voice on' : 'voice off', ctx.config.CLAUDE_SCOUT_ENABLED ? 'scout on' : 'scout off'];
      return { state: 'live', detail: `key valid, ${info.id} available (${features.join(', ')})` };
    } catch (err) {
      if (err instanceof Anthropic.NotFoundError) return { state: 'offline', detail: `key valid, but model ${model} was not found`, nextAction: 'Set ANTHROPIC_MODEL to a listed model (GET /v1/models)' };
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        return { state: 'offline', detail: `Anthropic rejected the key (${err.status})`, nextAction: next };
      }
      if (err instanceof Anthropic.APIConnectionError) return { state: 'offline', detail: `unreachable: ${describeError(err.cause ?? err)}` };
      if (err instanceof Anthropic.APIError) return { state: 'offline', detail: `Anthropic answered ${err.status ?? 'error'}` };
      return { state: 'offline', detail: describeError(err) };
    }
  },
};

/** All probes, in display order. */
export const PROBES: ProviderProbe[] = [
  zeroGRouter,
  zeroGStorage,
  hederaPayer,
  hederaMerchant,
  x402Facilitator,
  hcsAudit,
  hyperliquid,
  uniswap,
  rss,
  polymarket,
  cryptopanic,
  ethos,
  xai,
  claude,
  groq,
  elevenlabs,
  openaiTts,
];
