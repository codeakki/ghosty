import type { Config } from '../config.js';
import type { CredibilityScorer } from '../credibility/ethos.js';
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
>;

/**
 * One provider per source. Real when enabled, fake otherwise:
 *  - RSS, Polymarket: real when NEWS_LIVE=true (no key needed)
 *  - CryptoPanic: real when CRYPTOPANIC_TOKEN is set
 *  - Grok: real when XAI_API_KEY is set
 * With NEWS_LIVE=true, sources without a key are left out instead of faked, so live mode never
 * mixes canned headlines into real ones.
 */
export function createNewsProviders(config: NewsConfig): NewsProvider[] {
  const timeoutMs = config.NEWS_PROVIDER_TIMEOUT_MS;
  const live = config.NEWS_LIVE;
  const providers: NewsProvider[] = [
    live ? new RssProvider({ feeds: parseFeedList(config.NEWS_RSS_FEEDS), timeoutMs }) : new FakeRssProvider(),
  ];
  if (config.CRYPTOPANIC_TOKEN) {
    providers.push(new CryptoPanicProvider({ token: config.CRYPTOPANIC_TOKEN, baseUrl: config.CRYPTOPANIC_API_URL, timeoutMs }));
  } else if (!live) {
    providers.push(new FakeCryptoPanicProvider());
  }
  providers.push(
    live
      ? new PolymarketProvider({ keywords: csv(config.NEWS_POLYMARKET_KEYWORDS), tagSlug: config.NEWS_POLYMARKET_TAG, timeoutMs })
      : new FakePolymarketProvider(),
  );
  if (config.XAI_API_KEY) {
    providers.push(
      new GrokProvider({
        apiKey: config.XAI_API_KEY,
        model: config.XAI_MODEL,
        handles: csv(config.XAI_X_HANDLES),
        minIntervalMs: config.XAI_MIN_INTERVAL_SECONDS * 1000,
      }),
    );
  } else if (!live) {
    providers.push(new FakeGrokProvider());
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
