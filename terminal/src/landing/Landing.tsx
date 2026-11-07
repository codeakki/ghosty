import { useEffect, useRef, useState, type ReactNode } from 'react';
import '../design/tokens.css';
import { GhostMark } from '../live/brand/GhostMark';
import { Link } from '../live/Link';
import { ROUTE_PATH } from '../live/router';
import './landing.css';

/**
 * Landing page at `/`: what Ghosty is, how it works, the sponsor stack, and the way into the app (`/live`).
 * Motion is CSS (transform/opacity) plus one small state loop for the pod demo; all of it stops under
 * prefers-reduced-motion. Sections fade in once as they scroll into view.
 */

const REPO = 'https://github.com/codeakki/ghosty';

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Adds data-in="true" to every [data-reveal] child once it scrolls into view. */
function useReveal() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const targets = Array.from(el.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (reduceMotion() || typeof IntersectionObserver === 'undefined') {
      targets.forEach((t) => (t.dataset.in = 'true'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            (e.target as HTMLElement).dataset.in = 'true';
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.12 },
    );
    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, []);
  return root;
}

function Mark({ size = 28 }: { size?: number }) {
  return <GhostMark size={size} className="ln-mark" />;
}

// ---------------------------------------------------------------------------
// Hero pod demo: the loop a wearer actually sees.

type Beat = { mood: 'calm' | 'think' | 'alert' | 'done'; label: string; line: string; chip?: { tone: string; text: string } };

const BEATS: Beat[] = [
  { mood: 'calm', label: 'Watching the markets', line: 'Reading 4 news feeds, Polymarket and X.' },
  { mood: 'calm', label: 'Headline', line: 'Reuters: Israel strikes Iran nuclear facilities.', chip: { tone: 'warn', text: 'STRIKE · credible source' } },
  { mood: 'think', label: 'Thinking on 0G', line: 'Paid 0.01 USDC for intel over x402. Asking 0G Compute…', chip: { tone: 'hedera', text: 'x402 · hedera:testnet ✓' } },
  { mood: 'alert', label: 'Heads up', line: '“Long gold, short Bitcoin. Press to confirm.”', chip: { tone: 'og', text: '0G · geopolitical shock · 78%' } },
  { mood: 'done', label: 'Done', line: 'Short BTC filled on Hyperliquid mainnet. Episode saved to 0G Storage.', chip: { tone: 'hl', text: 'order 597593593888 · filled' } },
];

function PodDemo() {
  const [i, setI] = useState(reduceMotion() ? 3 : 0);
  useEffect(() => {
    if (reduceMotion()) return;
    const id = window.setInterval(() => setI((n) => (n + 1) % BEATS.length), 2600);
    return () => window.clearInterval(id);
  }, []);
  const beat = BEATS[i]!;
  return (
    <div className="ln-pod-wrap" aria-hidden="true">
      <div className="ln-orbit ln-orbit-1">
        <span className="ln-sat ln-sat-og">0G</span>
      </div>
      <div className="ln-orbit ln-orbit-2">
        <span className="ln-sat ln-sat-hedera">Hedera</span>
      </div>
      <div className="ln-orbit ln-orbit-3">
        <span className="ln-sat ln-sat-hl">Hyperliquid</span>
        <span className="ln-sat ln-sat-uni">Uniswap</span>
      </div>
      <div className="ln-pod" data-mood={beat.mood}>
        <div className="ln-pod-cord" />
        <div className="ln-orb">
          <GhostMark size={128} className="ln-orb-ghost" />
        </div>
        <div className="ln-grille">
          {Array.from({ length: 21 }, (_, k) => (
            <span key={k} />
          ))}
        </div>
        <div className="ln-pod-btn" data-press={beat.mood === 'done' ? 'true' : undefined} />
      </div>
      <div className="ln-caption" key={i}>
        <p className="ln-caption-label">
          <span className="ln-dot" data-mood={beat.mood} /> {beat.label}
        </p>
        <p className="ln-caption-line">{beat.line}</p>
        {beat.chip ? <p className={`ln-chip ln-chip-${beat.chip.tone}`}>{beat.chip.text}</p> : null}
      </div>
      <ol className="ln-steps-dots">
        {BEATS.map((b, k) => (
          <li key={b.label} data-on={k === i ? 'true' : undefined} />
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------

const TICKER = [
  ['REUTERS', 'Israel strikes Iran nuclear facilities'],
  ['GOLD', '+1.8%'],
  ['POLYMARKET', 'Ceasefire odds 31% → 12%'],
  ['BTC', '−2.1%'],
  ['U.S. SEC', 'SEC files 13 charges against Binance'],
  ['WTI', '+6.0%'],
  ['BLOOMBERG', 'Bybit says exchange wallet hacked'],
  ['ETH', '−3.4%'],
];

type Feature = { icon: ReactNode; title: string; body: string; tag: string; tone: string };

const I = {
  news: <path d="M4 5h12v14H6a2 2 0 0 1-2-2V5Zm12 4h4v8a2 2 0 0 1-2 2M8 9h4M8 13h4" />,
  shield: <path d="M12 3 5 6v5c0 4.4 3 8.4 7 10 4-1.6 7-5.6 7-10V6l-7-3Zm-3 9 2 2 4-4" />,
  coin: <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v10m3-8.5c-.6-.9-1.7-1.5-3-1.5-1.7 0-3 .9-3 2s1.3 1.8 3 2 3 .9 3 2-1.3 2-3 2c-1.3 0-2.4-.6-3-1.5" />,
  brain: <path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h0V4Zm6 0a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3V4Z" />,
  voice: <path d="M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3Zm-6 8a6 6 0 0 0 12 0M12 18v3" />,
  bolt: <path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z" />,
  db: <path d="M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3Zm0 0v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />,
  stop: <path d="M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7L8.5 3ZM9 12h6" />,
};

const FEATURES: Feature[] = [
  { icon: I.news, title: 'Reads everything', body: 'Four news feeds, Polymarket odds and X, plus a Claude scout that searches the web every few minutes.', tag: 'RSS · Polymarket · X', tone: 'warn' },
  { icon: I.shield, title: 'Checks who said it', body: 'Every headline is weighed by its source’s Ethos credibility score. A rumour from nobody does not move your money.', tag: 'Ethos', tone: 'ghost' },
  { icon: I.coin, title: 'Pays for its own intel', body: 'Before a big call, the agent buys a signal bundle over x402 from its own wallet. No human approval, hard spending caps.', tag: 'Hedera x402 · HCS audit', tone: 'hedera' },
  { icon: I.brain, title: 'Decides on 0G', body: 'The trade decision runs on 0G Compute and returns strict JSON: signal, confidence and legs, each with a request id.', tag: '0G Compute', tone: 'og' },
  { icon: I.voice, title: 'Speaks up', body: 'The pod says what it saw and what it wants to do, out loud. Ask it anything: “what’s moving gold?”', tag: 'ElevenLabs · Groq · Claude', tone: 'ghost' },
  { icon: I.bolt, title: 'One press to trade', body: 'Confirm and it places perps on Hyperliquid (BTC, gold, oil, 24/7) and runs the spot leg through Uniswap.', tag: 'Hyperliquid · Uniswap', tone: 'hl' },
  { icon: I.db, title: 'Remembers, privately', body: 'Your risk profile and watchlist are encrypted on 0G Storage. Every decision is logged as an episode you can replay.', tag: '0G Storage', tone: 'og' },
  { icon: I.stop, title: 'No brain, no trade', body: 'If 0G is unreachable the pod says “brain offline” and refuses to act. No fallback model, no faked decisions.', tag: 'Safe-stop', tone: 'down' },
];

const FLOW = [
  { n: '01', t: 'Headline lands', d: 'A shock headline passes the keyword pre-filter.' },
  { n: '02', t: 'Source is scored', d: 'Ethos credibility for every outlet and handle.' },
  { n: '03', t: 'Intel is bought', d: 'x402 payment on Hedera, verified on the mirror node.' },
  { n: '04', t: '0G decides', d: 'Signal, confidence and sized legs, logged with a request id.' },
  { n: '05', t: 'Pod asks you', d: 'It speaks the alert. Nothing happens until you press.' },
  { n: '06', t: 'Trade + log', d: 'Hyperliquid and Uniswap fill; the episode goes to 0G Storage.' },
];

const STACK = [
  { name: '0G', role: 'Compute makes every trade decision. Storage keeps encrypted memory and an episode per decision.', tone: 'og' },
  { name: 'Hedera', role: 'The agent pays per signal over x402, in USDC or HBAR, with every step on an HCS audit topic.', tone: 'hedera' },
  { name: 'Hyperliquid', role: 'Perps on BTC, gold and oil, 24/7, through HIP-3 markets on trade.xyz.', tone: 'hl' },
  { name: 'Uniswap', role: 'The spot leg through the Trading API on Base, before the perps.', tone: 'uni' },
];

export default function Landing() {
  const root = useReveal();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    document.title = 'Ghosty · Market intelligence that stays beside you, 24/7';
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  return (
    <div className="ln" ref={root}>
      <a href="#ln-main" className="ln-skip">
        Skip to content
      </a>

      <header className="ln-nav" data-scrolled={scrolled ? 'true' : undefined}>
        <div className="ln-nav-in">
          <a href="#top" className="ln-brand" translate="no" aria-label="Ghosty, top of page">
            <Mark />
            <span>ghosty</span>
          </a>
          <nav className="ln-links" aria-label="Sections">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#stack">Stack</a>
          </nav>
          <div className="ln-nav-cta">
            <Link to={ROUTE_PATH.simulate} className="ln-btn ln-btn-ghost">
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
          <div className="ln-aurora" aria-hidden="true">
            <span className="ln-blob ln-blob-1" />
            <span className="ln-blob ln-blob-2" />
            <span className="ln-blob ln-blob-3" />
          </div>
          <div className="ln-grid-bg" aria-hidden="true" />
          <div className="ln-hero-in">
            <div className="ln-hero-copy">
              <p className="ln-eyebrow ln-rise" style={{ animationDelay: '60ms' }}>
                <span className="ln-live-dot" /> Wearable AI trading copilot · ETHGlobal Mumbai
              </p>
              <h1 id="ln-hero-title" className="ln-h1 ln-rise" style={{ animationDelay: '140ms' }}>
                Market intelligence that stays beside you, <span className="ln-shine">24/7.</span>
              </h1>
              <p className="ln-lede ln-rise" style={{ animationDelay: '240ms' }}>
                Ghosty is a pod you wear with its own trading brain. It reads the news, checks who is saying it, pays for premium signals and
                tells you when something matters. One press, and it trades from its own wallet.
              </p>
              <div className="ln-hero-cta ln-rise" style={{ animationDelay: '340ms' }}>
                <Link to={ROUTE_PATH.live} className="ln-btn ln-btn-primary ln-btn-lg">
                  Open the live app <span aria-hidden="true">→</span>
                </Link>
                <Link to={ROUTE_PATH.simulate} className="ln-btn ln-btn-ghost ln-btn-lg">
                  Replay a real shock
                </Link>
              </div>
              <dl className="ln-stats ln-rise" style={{ animationDelay: '440ms' }}>
                <div>
                  <dt>Button</dt>
                  <dd>1</dd>
                </div>
                <div>
                  <dt>Trades without you</dt>
                  <dd>0</dd>
                </div>
                <div>
                  <dt>Watching</dt>
                  <dd>24/7</dd>
                </div>
              </dl>
            </div>
            <PodDemo />
          </div>
        </section>

        {/* ---------------- Ticker ---------------- */}
        <div className="ln-ticker" aria-hidden="true">
          <div className="ln-ticker-track">
            {[0, 1].map((dup) => (
              <div className="ln-ticker-run" key={dup}>
                {TICKER.map(([k, v]) => (
                  <span key={`${dup}-${k}`} className="ln-tick">
                    <b>{k}</b> {v}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* ---------------- Features ---------------- */}
        <section className="ln-section" id="features" aria-labelledby="ln-features-title">
          <div className="ln-section-head" data-reveal>
            <p className="ln-kicker">Features</p>
            <h2 id="ln-features-title" className="ln-h2">
              Everything a trading desk does, <span className="ln-muted">on a lanyard.</span>
            </h2>
          </div>
          <ul className="ln-features">
            {FEATURES.map((f, k) => (
              <li key={f.title} className="ln-card" data-tone={f.tone} data-reveal style={{ transitionDelay: `${(k % 4) * 70}ms` }}>
                <svg className="ln-icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
                  {f.icon}
                </svg>
                <h3 className="ln-h3">{f.title}</h3>
                <p className="ln-body">{f.body}</p>
                <p className="ln-tag">{f.tag}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* ---------------- How it works ---------------- */}
        <section className="ln-section ln-section-alt" id="how" aria-labelledby="ln-how-title">
          <div className="ln-section-head" data-reveal>
            <p className="ln-kicker">How it works</p>
            <h2 id="ln-how-title" className="ln-h2">
              From headline to fill, <span className="ln-muted">with you in the loop.</span>
            </h2>
          </div>
          <ol className="ln-flow" data-reveal>
            {FLOW.map((s) => (
              <li key={s.n} className="ln-flow-step">
                <span className="ln-flow-n">{s.n}</span>
                <h3 className="ln-h3">{s.t}</h3>
                <p className="ln-body">{s.d}</p>
              </li>
            ))}
          </ol>
          <div className="ln-split" data-reveal>
            <div className="ln-quote">
              <p className="ln-quote-big">
                “Conflict headline, credible sources. Long gold, short Bitcoin. <span className="ln-accent">Press to confirm.</span>”
              </p>
              <p className="ln-body">What the pod actually says, in its own voice, when 0G finds a trade.</p>
            </div>
            <div className="ln-safe">
              <p className="ln-safe-big">
                No brain?
                <br />
                <span>No trade.</span>
              </p>
              <p className="ln-body">0G unreachable → 503 brain_offline, 0 orders sent, and the pod says so out loud.</p>
            </div>
          </div>
        </section>

        {/* ---------------- Stack ---------------- */}
        <section className="ln-section" id="stack" aria-labelledby="ln-stack-title">
          <div className="ln-section-head" data-reveal>
            <p className="ln-kicker">The stack</p>
            <h2 id="ln-stack-title" className="ln-h2">
              Each sponsor does <span className="ln-muted">one real job.</span>
            </h2>
          </div>
          <ul className="ln-stack">
            {STACK.map((s, k) => (
              <li key={s.name} className="ln-stack-card" data-tone={s.tone} data-reveal style={{ transitionDelay: `${k * 80}ms` }}>
                <span className="ln-stack-name">{s.name}</span>
                <p className="ln-body">{s.role}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* ---------------- CTA ---------------- */}
        <section className="ln-cta" aria-labelledby="ln-cta-title">
          <div className="ln-cta-in" data-reveal>
            <Mark size={56} />
            <h2 id="ln-cta-title" className="ln-h2">
              Don’t watch the markets. <span className="ln-accent">Wear them.</span>
            </h2>
            <div className="ln-hero-cta">
              <Link to={ROUTE_PATH.live} className="ln-btn ln-btn-primary ln-btn-lg">
                Open the live app <span aria-hidden="true">→</span>
              </Link>
              <a href={REPO} className="ln-btn ln-btn-ghost ln-btn-lg" target="_blank" rel="noreferrer">
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
              <Mark />
              <span>ghosty</span>
            </a>
            <p className="ln-body">Market intelligence that stays beside you, 24/7.</p>
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
