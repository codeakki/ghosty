import type { Config } from '../config.js';
import { isTestMode } from '../mode.js';
import type { CredibilityScorer } from '../credibility/ethos.js';
import { ClaudeScoutProvider } from '../claude/scout.js';
import { NewsAggregator } from './aggregator.js';
import { CryptoPanicProvider, FakeCryptoPanicProvider } from './cryptopanic.js';
import { FakeGrokProvider, GrokProvider } from './grok.js';
import { csv } from './http.js';
import { FakePolymarketProvider, PolymarketProvider } from './polymarket.js';
import { FakeRssProvider, parseFeedList, RssProvider } from './rss.js';
import type { NewsProvider } from './types.js';

type NewsConfig = Pick<
  Config,
  | 'NEWS_LIVE'
  | 'NEWS_RSS_FEEDS'
  | 'NEWS_POLYMARKET_KEYWORDS'
  | 'NEWS_POLYMARKET_TAG'
  | 'NEWS_PROVIDER_TIMEOUT_MS'
  | 'CRYPTOPANIC_TOKEN'
  | 'CRYPTOPANIC_API_URL'
  | 'XAI_API_KEY'
  | 'XAI_MODEL'
  | 'XAI_X_HANDLES'
  | 'XAI_MIN_INTERVAL_SECONDS'
> &
  Partial<
    Pick<Config, 'GHOSTY_MODE' | 'ANTHROPIC_API_KEY' | 'ANTHROPIC_MODEL' | 'CLAUDE_SCOUT_ENABLED' | 'CLAUDE_SCOUT_QUERY' | 'CLAUDE_SCOUT_MAX_PER_DAY'>
  >;

/**
 * One provider per source. Real when enabled; fakes only in test mode:
 *  - RSS, Polymarket: real when NEWS_LIVE=true (no key needed; default true in live mode)
 *  - CryptoPanic: real when CRYPTOPANIC_TOKEN is set
 *  - Grok: real when XAI_API_KEY is set
 *  - Claude scout: with NEWS_LIVE, ANTHROPIC_API_KEY and CLAUDE_SCOUT_ENABLED (index.ts starts its cycles)
 * Fake headlines appear only with GHOSTY_MODE=test and NEWS_LIVE=false. Otherwise sources without a key are
 * left out, so canned headlines are never mixed into real ones.
 */
export function createNewsProviders(config: NewsConfig): NewsProvider[] {
  const timeoutMs = config.NEWS_PROVIDER_TIMEOUT_MS;
  const live = config.NEWS_LIVE;
  const fakes = !live && isTestMode(config);
  const providers: NewsProvider[] = [];
  if (live) providers.push(new RssProvider({ feeds: parseFeedList(config.NEWS_RSS_FEEDS), timeoutMs }));
  else if (fakes) providers.push(new FakeRssProvider());
  if (config.CRYPTOPANIC_TOKEN) {
    providers.push(new CryptoPanicProvider({ token: config.CRYPTOPANIC_TOKEN, baseUrl: config.CRYPTOPANIC_API_URL, timeoutMs }));
  } else if (fakes) {
    providers.push(new FakeCryptoPanicProvider());
  }
  if (live) {
    providers.push(
      new PolymarketProvider({ keywords: csv(config.NEWS_POLYMARKET_KEYWORDS), tagSlug: config.NEWS_POLYMARKET_TAG, timeoutMs }),
    );
  } else if (fakes) {
    providers.push(new FakePolymarketProvider());
  }
  if (config.XAI_API_KEY) {
    providers.push(
      new GrokProvider({
        apiKey: config.XAI_API_KEY,
        model: config.XAI_MODEL,
        handles: csv(config.XAI_X_HANDLES),
        minIntervalMs: config.XAI_MIN_INTERVAL_SECONDS * 1000,
      }),
    );
  } else if (fakes) {
    providers.push(new FakeGrokProvider());
  }
  if (live && config.CLAUDE_SCOUT_ENABLED && config.ANTHROPIC_API_KEY) {
    providers.push(
      new ClaudeScoutProvider({
        apiKey: config.ANTHROPIC_API_KEY,
        model: config.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5',
        query: config.CLAUDE_SCOUT_QUERY ?? 'market-moving news in the last hour',
        maxPerDay: config.CLAUDE_SCOUT_MAX_PER_DAY ?? 200,
      }),
    );
  }
  return providers;
}

/** Aggregator over createNewsProviders, with the configured window, seen file and deadlines. */
export function createNewsAggregator(
  config: NewsConfig & Pick<Config, 'NEWS_WINDOW_MINUTES' | 'NEWS_SEEN_PATH'>,
  opts: { scorer?: CredibilityScorer; providers?: NewsProvider[] } = {},
): NewsAggregator {
  return new NewsAggregator({
    providers: opts.providers ?? createNewsProviders(config),
    timeoutMs: config.NEWS_PROVIDER_TIMEOUT_MS,
    // x_search does several server-side tool rounds; a late result is cached for the next poll anyway.
    timeouts: { grok: Math.max(config.NEWS_PROVIDER_TIMEOUT_MS, 45_000) },
    windowMinutes: config.NEWS_WINDOW_MINUTES,
    seenPath: config.NEWS_SEEN_PATH,
    scorer: opts.scorer,
  });
}
