import { useEffect, useRef, type ReactNode } from 'react';
import '../design/tokens.css';
import { GhostMark } from '../live/brand/GhostMark';
import { Orb } from '../live/device/Orb';
import type { LevelSource } from '../live/device/useDevice';
import { Link } from '../live/Link';
import { ROUTE_PATH } from '../live/router';
import './landing.css';

/**
 * Landing page at `/`: what Ghosty is, how it works, the sponsor stack, and the way into the app (`/live`).
 * Direction: a trading desk at 3 a.m. The page is quiet ink; the one bright thing is the hero's Device screen,
 * built from the app's own ghost and alert card. Every section is visible without scrolling into view (no
 * observers), and nothing loops.
 */

const REPO = 'https://github.com/codeakki/ghosty';

// ---------------------------------------------------------------------------
// Hero: the Device screen at the moment a shock lands. Same ghost (Orb), same alert card layout as /device.

const silent: LevelSource = () => 0;

function DevicePreview() {
  const level = useRef<LevelSource>(silent);
  return (
    <figure className="ln-device" aria-label="The Ghosty Device screen with a pending trade">
      <div className="ln-device-screen">
        <div className="ln-device-orb">
          <Orb mode="idle" levelRef={level} localSpeech={false} />
        </div>
        <div className="ln-alert">
          <p className="ln-alert-kicker">
            Pending trade · confidence <span className="ln-num">78%</span>
          </p>
          <p className="ln-alert-leg">
            Long Gold · <span className="ln-num">$10</span> on Hyperliquid
          </p>
          <p className="ln-alert-headline">On: Israel strikes Iranian nuclear sites</p>
        </div>
        <span className="ln-device-btn">Press to confirm</span>
        <p className="ln-device-hint">Nothing trades until you press</p>
      </div>
      <figcaption className="ln-proof">
        <span>0G Compute decision</span> <code className="ln-num">bb6d851f</code> <span aria-hidden="true">·</span> <span>Hedera HCS topic</span>{' '}
        <code className="ln-num">0.0.11342727</code>
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------

/** What the desk saw on the shocks Ghosty replays: a static strip, printed once, never scrolling by itself. */
const TAPE: Array<{ src: string; text: string; dir?: 'up' | 'down' }> = [
  { src: 'Reuters', text: 'Israel strikes Iran nuclear facilities' },
  { src: 'Gold', text: '+1.8%', dir: 'up' },
  { src: 'Polymarket', text: 'Ceasefire odds 31% → 12%' },
  { src: 'BTC', text: '−2.1%', dir: 'down' },
  { src: 'U.S. SEC', text: 'SEC files 13 charges against Binance' },
  { src: 'WTI', text: '+6.0%', dir: 'up' },
  { src: 'Bloomberg', text: 'Bybit says exchange wallet hacked' },
  { src: 'ETH', text: '−3.4%', dir: 'down' },
];

/** One line-icon set, 20px, 1.5 stroke, in the muted text colour. */
const I = {
  news: <path d="M4 5h12v14H6a2 2 0 0 1-2-2V5Zm12 4h4v8a2 2 0 0 1-2 2M8 9h4M8 13h4" />,
  coin: <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v10m3-8.5c-.6-.9-1.7-1.5-3-1.5-1.7 0-3 .9-3 2s1.3 1.8 3 2 3 .9 3 2-1.3 2-3 2c-1.3 0-2.4-.6-3-1.5" />,
  brain: <path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h0V4Zm6 0a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3V4Z" />,
  voice: <path d="M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3Zm-6 8a6 6 0 0 0 12 0M12 18v3" />,
  press: <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />,
  db: <path d="M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3Zm0 0v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />,
};

type Feature = { icon: ReactNode; title: string; body: string; meta: string };

/** The two things a trader needs to believe first get the wide rows; the rest sit in a quieter grid. */
const LEAD: Feature[] = [
  {
    icon: I.news,
    title: 'Reads the news and checks who said it',
    body: 'Four news feeds, Polymarket odds and X, plus a Claude scout that searches the web every few minutes. Every headline is weighed by its source’s Ethos credibility score, so a rumour from nobody does not move your money.',
    meta: 'RSS · Polymarket · X · Ethos',
  },
  {
    icon: I.press,
    title: 'One press to trade',
    body: 'Confirm and it places perps on Hyperliquid (BTC, gold, oil, 24/7) and runs the spot leg through Uniswap. Until you press, nothing is sent.',
    meta: 'Hyperliquid · Uniswap',
  },
];

const MORE: Feature[] = [
  { icon: I.coin, title: 'Pays for its own intel', body: 'Before a big call, the agent buys a signal bundle over x402 from its own wallet. No human approval, hard spending caps.', meta: 'Hedera x402 · HCS audit' },
  { icon: I.brain, title: 'Decides on 0G', body: 'The trade decision runs on 0G Compute and returns strict JSON: signal, confidence and legs, each with a request id.', meta: '0G Compute' },
  { icon: I.voice, title: 'Speaks up', body: 'The pod says what it saw and what it wants to do, out loud. Ask it anything: “what’s moving gold?”', meta: 'ElevenLabs · Groq · Claude' },
  { icon: I.db, title: 'Remembers, privately', body: 'Your risk profile and watchlist are encrypted on 0G Storage. Every decision is logged as an episode you can replay.', meta: '0G Storage' },
];

const FLOW = [
  { n: '01', t: 'Headline lands', d: 'A shock headline passes the keyword pre-filter.' },
  { n: '02', t: 'Source is scored', d: 'Ethos credibility for every outlet and handle.' },
  { n: '03', t: 'Intel is bought', d: 'x402 payment on Hedera, verified on the mirror node.' },
  { n: '04', t: '0G decides', d: 'Signal, confidence and sized legs, logged with a request id.' },
  { n: '05', t: 'Pod asks you', d: 'It speaks the alert. Nothing happens until you press.' },
  { n: '06', t: 'Trade and log', d: 'Hyperliquid and Uniswap fill; the episode goes to 0G Storage.' },
];

const STACK = [
  { name: '0G', role: 'Compute makes every trade decision. Storage keeps encrypted memory and an episode per decision.' },
  { name: 'Hedera', role: 'The agent pays per signal over x402, in USDC or HBAR, with every step on an HCS audit topic.' },
  { name: 'Hyperliquid', role: 'Perps on BTC, gold and oil, 24/7, through HIP-3 markets on trade.xyz.' },
  { name: 'Uniswap', role: 'The spot leg through the Trading API on Base, before the perps.' },
];

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="ln-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      {children}
    </svg>
  );
}

export default function Landing() {
  useEffect(() => {
    document.title = 'Ghosty · The news, read for your positions';
  }, []);

  return (
    <div className="ln">
      <a href="#ln-main" className="ln-skip">
        Skip to content
      </a>

      <header className="ln-nav">
        <div className="ln-nav-in">
          <a href="#top" className="ln-brand" translate="no" aria-label="Ghosty, top of page">
            <GhostMark size={24} className="ln-mark" />
            <span>ghosty</span>
          </a>
          <nav className="ln-links" aria-label="Sections">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#stack">Stack</a>
          </nav>
          <div className="ln-nav-cta">
            <Link to={ROUTE_PATH.simulate} className="ln-navlink">
              Simulate
            </Link>
            <Link to={ROUTE_PATH.live} className="ln-btn ln-btn-primary">
              Open the app
            </Link>
          </div>
        </div>
      </header>

      <main id="ln-main">
        {/* ---------------- Hero ---------------- */}
        <section className="ln-hero" id="top" aria-labelledby="ln-hero-title">
          <div className="ln-hero-in">
            <div className="ln-hero-copy ln-enter">
              <h1 id="ln-hero-title" className="ln-h1">
                The news, read for your positions. Trades only when you press.
              </h1>
              <p className="ln-lede">A voice pod for crypto traders that watches world news and markets, and says what a shock means for your trades.</p>
              <div className="ln-hero-cta">
                <Link to={ROUTE_PATH.live} className="ln-btn ln-btn-primary ln-btn-lg">
                  Open the live app
                </Link>
                <Link to={ROUTE_PATH.simulate} className="ln-btn ln-btn-secondary ln-btn-lg">
                  Replay a real shock
                </Link>
              </div>
            </div>
            <div className="ln-hero-visual ln-enter" style={{ animationDelay: '60ms' }}>
              <DevicePreview />
            </div>
          </div>
        </section>

        {/* ---------------- Tape: static, printed once ---------------- */}
        <div className="ln-tape" aria-label="Headlines and moves from the shocks Ghosty replays">
          <ul className="ln-tape-row">
            {TAPE.map((t) => (
              <li key={t.src} className="ln-tape-item">
                <span className="ln-tape-src">{t.src}</span>{' '}
                <span className={t.dir ? `ln-num ln-${t.dir}` : undefined}>{t.text}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* ---------------- Features ---------------- */}
        <section className="ln-section" id="features" aria-labelledby="ln-features-title">
          <div className="ln-section-head">
            <p className="ln-kicker">Features</p>
            <h2 id="ln-features-title" className="ln-h2">
              Everything a trading desk does, on a lanyard
            </h2>
          </div>
          <ul className="ln-lead">
            {LEAD.map((f) => (
              <li key={f.title} className="ln-lead-row">
                <Icon>{f.icon}</Icon>
                <h3 className="ln-h3">{f.title}</h3>
                <p className="ln-body">{f.body}</p>
                <p className="ln-meta">{f.meta}</p>
              </li>
            ))}
          </ul>
          <ul className="ln-features">
            {MORE.map((f) => (
              <li key={f.title} className="ln-feature">
                <Icon>{f.icon}</Icon>
                <h3 className="ln-h3">{f.title}</h3>
                <p className="ln-body">{f.body}</p>
                <p className="ln-meta">{f.meta}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* ---------------- How it works ---------------- */}
        <section className="ln-section" id="how" aria-labelledby="ln-how-title">
          <div className="ln-section-head">
            <p className="ln-kicker">How it works</p>
            <h2 id="ln-how-title" className="ln-h2">
              From headline to fill, with you in the loop
            </h2>
          </div>
          <ol className="ln-flow">
            {FLOW.map((s) => (
              <li key={s.n} className="ln-flow-step">
                <span className="ln-flow-n ln-num">{s.n}</span>
                <h3 className="ln-h3">{s.t}</h3>
                <p className="ln-body">{s.d}</p>
              </li>
            ))}
          </ol>
          <div className="ln-split">
            <figure className="ln-quote">
              <blockquote className="ln-quote-big">“Conflict headline, credible sources. Long gold, short Bitcoin. Press to confirm.”</blockquote>
              <figcaption className="ln-body">What the pod actually says, in its own voice, when 0G finds a trade.</figcaption>
            </figure>
            <div className="ln-safe">
              <p className="ln-safe-big">No brain, no trade</p>
              <p className="ln-body">
                If 0G is unreachable the pod says “brain offline” and refuses to act: <code className="ln-num">503 brain_offline</code>, 0 orders sent. No
                fallback model, no faked decisions.
              </p>
            </div>
          </div>
        </section>

        {/* ---------------- Stack ---------------- */}
        <section className="ln-section" id="stack" aria-labelledby="ln-stack-title">
          <div className="ln-section-head">
            <p className="ln-kicker">The stack</p>
            <h2 id="ln-stack-title" className="ln-h2">
              Each sponsor does one real job
            </h2>
          </div>
          <dl className="ln-stack">
            {STACK.map((s) => (
              <div key={s.name} className="ln-stack-row">
                <dt className="ln-stack-name">{s.name}</dt>
                <dd className="ln-body">{s.role}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* ---------------- CTA ---------------- */}
        <section className="ln-cta" aria-labelledby="ln-cta-title">
          <div className="ln-cta-in">
            <h2 id="ln-cta-title" className="ln-h2">
              Don’t watch the markets. Wear them.
            </h2>
            <div className="ln-hero-cta">
              <Link to={ROUTE_PATH.live} className="ln-btn ln-btn-primary ln-btn-lg">
                Open the live app
              </Link>
              <a href={REPO} className="ln-btn ln-btn-secondary ln-btn-lg" target="_blank" rel="noreferrer">
                View on GitHub
              </a>
            </div>
          </div>
        </section>
      </main>

      {/* ---------------- Footer ---------------- */}
      <footer className="ln-footer">
        <div className="ln-footer-in">
          <div className="ln-footer-brand">
            <a href="#top" className="ln-brand" translate="no">
              <GhostMark size={24} className="ln-mark" />
              <span>ghosty</span>
            </a>
            <p className="ln-body">A voice pod that reads the news for your positions and trades only when you press.</p>
          </div>
          <nav className="ln-footer-col" aria-label="App">
            <p className="ln-footer-h">App</p>
            <Link to={ROUTE_PATH.live}>Live view</Link>
            <Link to={ROUTE_PATH.device}>Device</Link>
            <Link to={ROUTE_PATH.feed}>Feed</Link>
            <Link to={ROUTE_PATH.simulate}>Simulate</Link>
          </nav>
          <nav className="ln-footer-col" aria-label="Project">
            <p className="ln-footer-h">Project</p>
            <a href={REPO} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href={`${REPO}/blob/main/docs/architecture.md`} target="_blank" rel="noreferrer">
              Architecture
            </a>
            <a href={`${REPO}/blob/main/docs/hedera.md`} target="_blank" rel="noreferrer">
              Hedera x402
            </a>
            <a href={`${REPO}/blob/main/docs/simulation.md`} target="_blank" rel="noreferrer">
              Simulator
            </a>
          </nav>
          <div className="ln-footer-col">
            <p className="ln-footer-h">Built with</p>
            <span>0G Compute + Storage</span>
            <span>Hedera x402</span>
            <span>Hyperliquid</span>
            <span>Uniswap</span>
          </div>
        </div>
        <p className="ln-footer-base">Built at ETHGlobal Mumbai · November 2026 · Not financial advice: Ghosty asks before every trade.</p>
      </footer>
    </div>
  );
}
