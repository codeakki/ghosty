import { memo } from 'react';
import type { MarketAsset } from '../api/types';
import { formatAge, formatCompact, formatFunding, formatPct, formatPrice, splitCoin } from '../lib/format';
import { useNow } from '../lib/useNow';
import type { TerminalState } from '../state/reducer';
import { Sparkline } from './Sparkline';
import { Empty, Panel, Tag } from './ui';

/** Fallback rows from bare mids before the snapshot arrives. Only coins the server reports are shown. */
const PREFERRED = ['BTC', 'ETH', 'xyz:GOLD', 'xyz:CL', 'xyz:TSLA'];

interface Row {
  coin: string;
  label: string;
  mid: number | null;
  change: number | null;
  funding: number | null;
  oi: number | null;
}

function buildRows(assets: MarketAsset[] | undefined, mids: Record<string, number>): Row[] {
  const rows = new Map<string, Row>();
  for (const a of assets ?? []) {
    const mid = mids[a.coin] ?? a.mid;
    const change = mid !== null && a.prevDayPx ? ((mid - a.prevDayPx) / a.prevDayPx) * 100 : a.change24hPct;
    const oi = a.openInterestUsd ?? (a.openInterest !== null && mid !== null ? a.openInterest * mid : null);
    rows.set(a.coin, { coin: a.coin, label: a.label, mid, change, funding: a.funding, oi });
  }
  for (const coin of PREFERRED) {
    if (!rows.has(coin) && mids[coin] !== undefined) {
      rows.set(coin, { coin, label: coin, mid: mids[coin]!, change: null, funding: null, oi: null });
    }
  }
  // Server order = MARKET_WATCHLIST order; mid-only fallback rows go after it in PREFERRED order.
  return [...rows.values()];
}

/** 24 h of hourly closes with the live mid as the last point; session ticks until history arrives. */
function trendPoints(coin: string, history: Record<string, number[]>, series: Record<string, number[]>, mid: number | null) {
  const h = history[coin];
  if (h && h.length >= 2) return { points: mid !== null ? [...h, mid] : h, span: '24h' as const };
  return { points: series[coin] ?? [], span: 'session' as const };
}

export const MarketWatch = memo(function MarketWatch({ state }: { state: TerminalState }) {
  const now = useNow(2000);
  const rows = buildRows(state.market.data?.assets, state.mids);
  const resolved = state.execution?.resolved ?? [];
  const lastTick = state.midsAt;

  return (
    <Panel
      id="market"
      title="Market watch"
      hint="Hyperliquid perps the playbook trades: crypto plus HIP-3 gold, oil and stocks"
      className="panel-market"
      actions={
        lastTick ? (
          <span className="muted small num" title="Last price update">
            tick {formatAge(new Date(lastTick).toISOString(), now)}
          </span>
        ) : null
      }
    >
      {rows.length > 0 ? (
        <div className="table-scroll">
          <table className="watch">
            <caption className="sr-only">Market watch</caption>
            <thead>
              <tr>
                <th scope="col">Market</th>
                <th scope="col" className="num-col">
                  Mid
                </th>
                <th scope="col" className="num-col">
                  24h
                </th>
                <th scope="col" className="num-col hide-sm">
                  Funding
                </th>
                <th scope="col" className="num-col hide-sm">
                  OI
                </th>
                <th scope="col" className="spark-col">
                  Trend
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const { ticker, dex } = splitCoin(r.coin);
                const dir = r.change === null || r.change === 0 ? '' : r.change > 0 ? 'up' : 'down';
                const trend = trendPoints(r.coin, state.history, state.series, r.mid);
                return (
                  <tr key={r.coin}>
                    <th scope="row" className="mono">
                      {dex ? <span className="dex">{dex}:</span> : null}
                      {ticker}
                      {r.label && r.label !== r.coin && r.label !== ticker ? <span className="watch-label">{r.label}</span> : null}
                    </th>
                    <td className="num-col num">{formatPrice(r.mid)}</td>
                    <td className={`num-col num dir-${dir}`}>
                      {dir ? <span aria-hidden="true">{dir === 'up' ? '▲ ' : '▼ '}</span> : null}
                      {formatPct(r.change)}
                    </td>
                    <td className="num-col num hide-sm">{formatFunding(r.funding)}</td>
                    <td className="num-col num hide-sm">{formatCompact(r.oi)}</td>
                    <td className="spark-col">
                      <Sparkline points={trend.points} label={`${r.coin} ${trend.span}`} span={trend.span} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : state.market.status === 'pending' ? (
        <Empty tone="warn" title="Backend upgrade pending: no market feed yet">
          Prices appear here once the server exposes GET /market/snapshot and the SSE <code>market</code> event.
        </Empty>
      ) : state.market.status === 'error' ? (
        <Empty tone="bad" title={state.market.message?.startsWith('Not configured') ? 'Market data not configured' : 'Market snapshot failed'}>
          {state.market.message ?? 'The server could not load market data.'}
        </Empty>
      ) : (
        <Empty title="Loading market snapshot…" />
      )}

      {state.market.data && state.market.data.missing.length > 0 ? (
        <p className="muted small">Not listed on {state.market.data.network}: {state.market.data.missing.join(', ')}</p>
      ) : null}

      {resolved.length > 0 ? (
        <div className="resolved">
          <span className="muted small">Playbook markets on this venue:</span>
          {resolved.map((r) => (
            <Tag key={r.alias} tone={r.error ? 'bad' : r.fallback ? 'warn' : 'muted'} title={r.error ?? (r.fallback ? 'Fallback market' : `asset ${r.assetId}`)}>
              {r.alias} → {r.coin ?? 'unresolved'}
            </Tag>
          ))}
        </div>
      ) : null}
    </Panel>
  );
});
