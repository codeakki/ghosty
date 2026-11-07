import { createContext, memo, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { formatSimClock } from '../sim/simState';
import { RelTime } from './RelTime';
import { formatSignal, shockTag } from '../../lib/format';
import { chainscanBase } from '../../state/proofs';
import { coinName, formatAssetPx, formatConfidencePct, formatPx, formatSignedPct, formatUsdAmount, legText, shortHash } from '../words';
import { systemText, type ReplayCard, type SimCardTag, type AlertCard, type BrainCard, type FeedCard, type MarketCard, type NewsCard, type SystemCard, type TxCard, type TxTrack } from './feedReducer';
import { MiniSpark } from './MiniSpark';

export interface CardContext {
  labels: Record<string, string>;
  storagescan: string | undefined;
}

const TRACK_LABEL: Record<TxTrack, string> = { '0g': '0G', hedera: 'Hedera', uniswap: 'Uniswap', hyperliquid: 'Hyperliquid' };

function Ext({ href, children, label }: { href: string; children: ReactNode; label?: string }) {
  return (
    <a className="lv-ext" href={href} target="_blank" rel="noreferrer noopener" aria-label={label}>
      {children}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

function CopyId({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(t.current);
      t.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <span className="lv-id">
      <code className="lv-mono" translate="no" title={value}>
        {shortHash(value, 10, 6)}
      </code>
      <button type="button" className="lv-icon-btn" onClick={copy} aria-label={`Copy ${label}`}>
        <span aria-hidden="true">{copied ? '✓' : '⧉'}</span>
      </button>
      <span className="lv-sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </span>
  );
}

/** Set per card: a simulation card shows its HISTORICAL sim clock and a SIM tag instead of "12s ago". */
const SimTagContext = createContext<SimCardTag | null>(null);

function CardTime({ at, className }: { at: number; className: string }) {
  const sim = useContext(SimTagContext);
  if (!sim) return <RelTime at={at} className={className} />;
  const iso = new Date(sim.simAt).toISOString();
  return (
    <span className={`${className} lv-sim-time`} title={`Simulated time ${iso.replace('T', ' ').slice(0, 16)} UTC · not live`}>
      <span className="lv-sim-tag">SIM</span>
      <time dateTime={iso}>{formatSimClock(sim.simAt)}</time>
    </span>
  );
}

function Head({ kind, label, at, extra }: { kind: string; label: ReactNode; at: number; extra?: ReactNode }) {
  return (
    <header className="lv-card-head">
      <span className={`lv-kind lv-kind-${kind}`}>{label}</span>
      {extra}
      <CardTime at={at} className="lv-card-time" />
    </header>
  );
}

/** Settled transaction: a check that draws in once. */
function Check() {
  return (
    <svg className="lv-check" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

// ---------------------------------------------------------------------------

/** Why the row exists, in two or three words. */
function moveWhy(card: MarketCard): string {
  const { move } = card;
  if (move.reason === 'high') return 'new 1h high';
  if (move.reason === 'low') return 'new 1h low';
  if (move.reason === 'day') return 'on the day';
  const min = Math.max(1, Math.round(move.windowSec / 60));
  return `in ${min} min`;
}

/**
 * Market moves are context, not the story: one compact row (coin · price · % · why · spark · time).
 * The source and reference price live in the tooltip.
 */
function MarketRow({ card, ctx }: { card: MarketCard; ctx: CardContext }) {
  const { move } = card;
  const name = coinName(move.coin, ctx.labels);
  const dir = move.pct >= 0 ? 'up' : 'down';
  const ref =
    move.reason === 'move'
      ? `from ${formatAssetPx(move.coin, move.from)}`
      : move.reason === 'day'
        ? `previous close ${formatAssetPx(move.coin, move.from)}`
        : `1h ${move.reason === 'high' ? 'high' : 'low'} was ${formatAssetPx(move.coin, move.from)}`;
  return (
    <div className="lv-row-body" title={ref.charAt(0).toUpperCase() + ref.slice(1)}>
      <span className="lv-row-name">{name}</span>
      <span className="lv-row-px lv-num">{formatAssetPx(move.coin, move.price)}</span>
      <span className={`lv-delta lv-delta-${dir} lv-num`}>
        <span aria-hidden="true">{dir === 'up' ? '▲' : '▼'}</span> {formatSignedPct(move.pct)}
      </span>
      <span className="lv-row-why">{moveWhy(card)}</span>
      <MiniSpark points={card.points} dir={dir} label={`${name} ${dir === 'up' ? 'rising' : 'falling'}, ${ref}`} />
      <CardTime at={card.at} className="lv-card-time" />
    </div>
  );
}

const CRED_WORD: Record<string, string> = {
  untrusted: 'Untrusted',
  questionable: 'Questionable',
  neutral: 'Neutral',
  reputable: 'Reputable',
  exemplary: 'Exemplary',
};

/** Low credibility is worth a word; "reputable" on every row is noise. */
const CRED_WARN = new Set(['untrusted', 'questionable']);

/**
 * Headlines are context until the agent acts on one (the brain card then quotes it): one compact row with the
 * headline, at most a couple of tags, and source · age.
 */
function NewsRow({ card }: { card: NewsCard }) {
  const { item } = card;
  const shock = shockTag(`${item.title} ${item.summary ?? ''}`);
  const source = item.handle ?? item.domain ?? item.source;
  const published = Date.parse(item.publishedAt);
  const injected = item.source === 'inject' || item.source === 'terminal-test';
  const cred = item.credibility;
  const credTitle = cred ? `Source credibility from Ethos: ${CRED_WORD[cred.level] ?? cred.level}${cred.score !== null ? ` (${cred.score} / 2800)` : ''}` : undefined;
  return (
    <div className="lv-news-row">
      <p className="lv-news-title">{item.url ? <Ext href={item.url}>{item.title}</Ext> : item.title}</p>
      <p className="lv-news-meta">
        {shock ? <span className={`lv-tag lv-tag-shock lv-tag-${shock.kind}`}>{shock.tag}</span> : null}
        {injected ? <span className="lv-tag">Test</span> : null}
        {cred && CRED_WARN.has(cred.level) ? (
          <span className={`lv-tag lv-tag-cred lv-cred-${cred.level}`} title={credTitle}>
            {CRED_WORD[cred.level]} source
          </span>
        ) : null}
        {item.probability !== undefined && !/polymarket/i.test(item.title) ? (
          <span className="lv-tag lv-tag-poly">
            Polymarket <span className="lv-num">{formatConfidencePct(item.probability)}</span> yes
          </span>
        ) : null}
        <span className="lv-card-source" title={credTitle}>
          {source}
        </span>
        <CardTime at={Number.isFinite(published) ? published : card.at} className="lv-card-time" />
      </p>
    </div>
  );
}

function BrainView({ card, ctx }: { card: BrainCard; ctx: CardContext }) {
  const triggerWord = card.trigger === 'voice' ? 'You asked by voice' : card.trigger === 'text' ? 'You asked' : card.trigger === 'inject' ? 'On the headline' : card.trigger === 'button' ? 'Button' : card.trigger;
  return (
    <>
      <Head kind="brain" label={<>Ghosty · <span translate="no">0G</span></>} at={card.at} />
      {card.status === 'thinking' ? (
        <h3 className="lv-card-title lv-thinking">
          <span className="lv-thinking-dot" aria-hidden="true" />
          Ghosty is thinking on 0G…
        </h3>
      ) : card.status === 'failed' ? (
        <h3 className="lv-card-title">
          <span aria-hidden="true" className="lv-warn-icon">
            !
          </span>{' '}
          No decision this time
        </h3>
      ) : (
        <h3 className="lv-card-title">
          {card.signal === 'none' ? 'No trade: nothing actionable' : formatSignal(card.signal ?? 'none')}
          <span className="lv-conf">
            {' '}
            · <span className="lv-num">{formatConfidencePct(card.confidence)}</span> confident
          </span>
        </h3>
      )}
      {card.prompt ? (
        <p className="lv-card-meta">
          {triggerWord}: <span className="lv-prompt">{card.prompt}</span>
        </p>
      ) : null}
      {card.status === 'failed' && card.message ? <p className="lv-card-body lv-fail">{card.message}</p> : null}
      {card.status === 'done' && card.rationale ? <p className="lv-card-body">{card.rationale}</p> : null}
      {card.status === 'done' && card.actions.length > 0 ? (
        <ul className="lv-legs">
          {card.actions.map((a, i) => (
            <li key={`${a.coin}-${i}`}>
              Suggests: <strong>{legText(a, ctx.labels)}</strong>
            </li>
          ))}
        </ul>
      ) : null}
      {card.requestId ? (
        <p className="lv-card-meta lv-card-proof">
          0G request <CopyId value={card.requestId} label="0G request id" />
        </p>
      ) : null}
    </>
  );
}

function AlertView({ card, ctx }: { card: AlertCard; ctx: CardContext }) {
  const { alert } = card;
  const leg = alert.actions[0];
  return (
    <>
      <Head kind="alert" label="Alert" at={card.at} />
      <h3 className="lv-card-title">Pinged your pod</h3>
      <blockquote className="lv-card-quote">“{alert.text}”</blockquote>
      {leg ? (
        <p className="lv-card-meta">
          Waiting for your tap: <strong>{legText(leg, ctx.labels)}</strong> · <span className="lv-num">{formatConfidencePct(alert.confidence)}</span> confident
        </p>
      ) : null}
    </>
  );
}

function TxView({ card, ctx }: { card: TxCard; ctx: CardContext }) {
  const head = <Head kind="tx" label={<span translate="no">{TRACK_LABEL[card.track]}</span>} at={card.at} />;
  switch (card.tx) {
    case 'order': {
      const o = card.order;
      const simulated = o.status === 'simulated';
      return (
        <>
          {head}
          <h3 className="lv-card-title">
            {o.isBuy ? 'Long' : 'Short'} {coinName(o.coin, ctx.labels)} · <span className="lv-num">{formatUsdAmount(o.sizeUsd)}</span>
            <span className={`lv-status lv-status-${o.status}`}>
              {' '}
              · {o.status === 'filled' ? <Check key="done" /> : null}
              {o.status}
            </span>
          </h3>
          <p className="lv-card-meta">
            {o.live ? (
              <>
                <span className="lv-real-tag">REAL</span> Hyperliquid {o.network === 'testnet' ? 'testnet' : 'mainnet'} order from the simulation
              </>
            ) : (
              'Hyperliquid perp order'
            )}
            {o.avgPx ? (
              <>
                {' '}
                · avg <span className="lv-num">{formatPx(o.avgPx)}</span>
              </>
            ) : null}
            {o.error ? ` · ${o.error}` : ''}
            {simulated ? (o.sim ? ' · paper fill at the historical price' : ' · simulated, not on chain') : ''}
          </p>
          {o.url && !simulated ? (
            <p className="lv-card-meta">
              <Ext href={o.url}>View on Hyperliquid explorer</Ext>
            </p>
          ) : null}
        </>
      );
    }
    case 'swap': {
      const s = card.swap;
      const simulated = s.result?.status === 'simulated';
      return (
        <>
          {head}
          <h3 className="lv-card-title">
            Swap {s.action.amount} {s.action.tokenIn} → {s.action.tokenOut}
            <span className="lv-status">
              {' '}
              · {s.result?.status === 'confirmed' ? <Check key="done" /> : null}
              {s.error ? 'failed' : (s.result?.status ?? 'pending…')}
            </span>
          </h3>
          {s.error ? <p className="lv-card-body lv-fail">{s.error}</p> : null}
          {s.result?.txHash ? (
            <p className="lv-card-meta">
              {s.result.explorerUrl && !simulated ? <Ext href={s.result.explorerUrl}>Tx {shortHash(s.result.txHash)}</Ext> : <code className="lv-mono">{shortHash(s.result.txHash)}</code>}
              {simulated ? ' · simulated' : ''}
            </p>
          ) : null}
        </>
      );
    }
    case 'payment': {
      const p = card.payment;
      const hbar = p.amountTinybar !== undefined ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(p.amountTinybar / 1e8)} HBAR` : 'HBAR';
      return (
        <>
          {head}
          <h3 className="lv-card-title">Paid {hbar} for a signal (x402)</h3>
          <p className="lv-card-meta">
            {p.mode === 'real' ? <Ext href={p.hashscanUrl}>View on HashScan</Ext> : 'Simulated payment, not on chain'} · <code className="lv-mono">{shortHash(p.txId, 10, 6)}</code>
          </p>
        </>
      );
    }
    case 'episode': {
      const ep = card.episode;
      const href = ep.txHash ? `${chainscanBase(ctx.storagescan)}/tx/${ep.txHash}` : ctx.storagescan;
      return (
        <>
          {head}
          <h3 className="lv-card-title">
            {ep.rootHash ? <Check key="done" /> : null}
            Episode #{ep.seq} {ep.rootHash ? 'saved' : 'saving…'} · {ep.outcome.replace(/_/g, ' ')}
          </h3>
          {ep.rootHash ? (
            <p className="lv-card-meta">
              0G Storage root <CopyId value={ep.rootHash} label="storage root hash" />
              {href ? (
                <>
                  {' '}
                  · <Ext href={href}>Storagescan</Ext>
                </>
              ) : null}
            </p>
          ) : (
            <p className="lv-card-meta">Not saved to 0G Storage yet.</p>
          )}
        </>
      );
    }
  }
}

function SystemView({ card }: { card: SystemCard }) {
  const t = systemText(card);
  return (
    <>
      <Head kind="system" label="System" at={card.updatedAt} />
      <h3 className="lv-card-title">
        <span aria-hidden="true" className={`lv-sys-icon lv-sys-${t.tone}`}>
          {t.tone === 'ok' ? '●' : '!'}
        </span>{' '}
        {t.title}
      </h3>
      {t.detail ? <p className="lv-card-meta">{t.detail}</p> : null}
      {t.raw.length > 0 ? (
        <details className="lv-details">
          <summary>Details</summary>
          <ul>
            {t.raw.map((line) => (
              <li key={line}>
                <code className="lv-mono">{line}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

/** CSS ident from a card key (for the brain card's view-transition-name). */
/** An episode played back from the log: what was decided, its 0G request id, and where it is stored, honestly. */
function ReplayView({ card }: { card: ReplayCard }) {
  const ep = card.episode;
  const d = ep.decision;
  const leg = ep.actions[0];
  return (
    <>
      <header className="lv-card-head">
        <span className="lv-kind lv-kind-replay">
          Replay · <span className="lv-num">{card.index}</span> of <span className="lv-num">{card.total}</span>
        </span>
        <span className="lv-card-time lv-sim-time" title={ep.ts}>
          <time dateTime={ep.ts}>{formatSimClock(ep.ts)}</time>
        </span>
      </header>
      <h3 className="lv-card-title">
        {d && d.signal !== 'none' ? (
          <>
            {formatSignal(d.signal)} · <span className="lv-num">{formatConfidencePct(d.confidence)}</span>
          </>
        ) : (
          'No trade: held'
        )}
      </h3>
      {d?.rationale ? <p className="lv-card-body">{d.rationale}</p> : null}
      {leg ? (
        <p className="lv-card-meta">
          {legText(leg)}
          {ep.orders > 0 ? ` · ${ep.orders} paper ${ep.orders === 1 ? 'order' : 'orders'}` : ''}
        </p>
      ) : null}
      <p className="lv-card-meta lv-card-proof">
        <span>0G request</span> <CopyId value={ep.requestId} label="0G request id" />
        {ep.storage === '0g' && ep.storagescanUrl ? (
          <Ext href={ep.storagescanUrl} label="Open this episode on 0G Storagescan">
            0G Storage
          </Ext>
        ) : ep.storage === '0g' ? (
          <span>On 0G Storage{ep.rootHash ? ` · root ${shortHash(ep.rootHash)}` : ''}</span>
        ) : (
          <span>Local log only (not on 0G Storage)</span>
        )}
      </p>
    </>
  );
}

function vtName(key: string): string {
  return `card-${key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}`;
}

/**
 * One card. The entrance (staggered by `--i` within a batch) and the "new" glow are decided once, at mount, so a
 * later batch never restarts or cuts them off. A brain card carries a view-transition-name so "thinking" can
 * morph into the decision in place.
 */
export const FeedCardView = memo(function FeedCardView({
  card,
  ctx,
  style,
  fresh,
  dataKey,
}: {
  card: FeedCard;
  ctx: CardContext;
  style?: CSSProperties;
  fresh: boolean;
  dataKey: string;
}) {
  const [glow] = useState(fresh);
  const [enterStyle] = useState(style);
  const track = card.kind === 'tx' ? card.track : undefined;
  const dir = card.kind === 'market' ? (card.move.pct >= 0 ? 'up' : 'down') : undefined;
  const vt = card.kind === 'brain' ? ({ viewTransitionName: vtName(dataKey) } as CSSProperties) : undefined;
  return (
    <li
      className={`${card.kind === 'market' || card.kind === 'news' ? 'lv-row' : 'lv-card'} lv-card-in lv-card-${card.kind}${glow ? ' lv-card-glow' : ''}`}
      data-key={dataKey}
      data-track={track}
      data-dir={dir}
      data-status={card.kind === 'brain' ? card.status : undefined}
      data-sim={card.sim ? 'true' : undefined}
      style={{ ...enterStyle, ...vt }}
    >
      <article>
        <SimTagContext.Provider value={card.sim ?? null}>
        {card.kind === 'market' ? <MarketRow card={card} ctx={ctx} /> : null}
        {card.kind === 'news' ? <NewsRow card={card} /> : null}
        {card.kind === 'brain' ? <BrainView card={card} ctx={ctx} /> : null}
        {card.kind === 'alert' ? <AlertView card={card} ctx={ctx} /> : null}
        {card.kind === 'tx' ? <TxView card={card} ctx={ctx} /> : null}
        {card.kind === 'system' ? <SystemView card={card} /> : null}
        {card.kind === 'replay' ? <ReplayView card={card} /> : null}
        </SimTagContext.Provider>
      </article>
    </li>
  );
});
