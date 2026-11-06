# Ghosty design: the Live view

Ghosty is market intelligence you wear: a voice pod with a private trading copilot. There is no hardware yet, so the
web UI stands in for it. The Live view has two things on it, and a judge should get both in ten seconds:

1. **The device.** A ghost orb that shows what the pod is doing (listening, thinking, speaking, alerting) and one big
   button that works like the physical one.
2. **The feed.** A stream of cards that keeps popping in: market moves, headlines, what the agent decided, and every
   transaction it made.

The dense terminal is still there at `/pro` for people who want every panel at once.

Code: `terminal/src/design/tokens.css` (tokens), `terminal/src/live/` (pages).

---

## 1. References

Research done before drawing anything. What each one taught us, and what we took.

| # | Reference | What we took |
|---|-----------|--------------|
| 1 | **ChatGPT voice mode orb** ([neowin](https://www.neowin.net/amp/openai-announces-new-improvements-for-chatgpt-advanced-voice-mode/), [AI wiki](https://artificial-intelligence-wiki.com/ai-tools/chatgpt/chatgpt-advanced-voice-mode/)) | One centered orb is the whole interface. It pulses for listening and speaking, so the state is legible without reading. We copy the idea of a single focal object and state-by-motion, and add a plain-words label under it because judges should not have to guess. |
| 2 | **Voice orb component, 21st.dev** ([21st.dev/@aqualang89/voice-orb](https://21st.dev/@aqualang89/components/voice-orb.md)) | A state model we reuse almost one to one: *breathes at idle, reshapes across listening / thinking / speaking, reacts to live mic or playback audio*. Our orb drives scale and glow from an `AnalyserNode` level in both directions (mic in, TTS out). |
| 3 | **Apple Intelligence Siri edge glow** ([9to5Mac](https://9to5mac.com/2024/11/03/new-apple-intelligence-siri-looks-different-works-the-same/), [MacRumors on iOS 27 pill](https://macrumors.com/2026/06/16/iphone-18-could-make-siri-a-circle)) | The glow "follows your voice" and lets you keep working. Lesson: tie motion to the real audio level, not a canned loop. We also keep the glow soft and diffuse (blur + opacity), never a hard ring. |
| 4 | **Rabbit R1 (Teenage Engineering)** ([Engadget hands-on](https://www.engadget.com/rabbit-r1-hands-on-already-more-fun-and-accessible-than-the-humane-ai-pin-163622560.html), [Dezeen](https://www.dezeen.com/2024/01/16/rabbit-r1-reimagines-digital-experience-ai-powered-device/)) | Hold-to-talk on one physical button, plus a character on screen that gives the device personality. We mirror the single button exactly (hold = talk, tap = confirm) and give the orb two small eyes that blink: a ghost, not a logo. |
| 5 | **Humane Ai Pin** ([MacRumors](https://www.macrumors.com/2023/11/09/humane-ai-pin/), [designer analysis](https://beyondux.substack.com/p/a-product-designers-analysis-of-humanes-c96)) | The "Trust Light": a visible signal whenever the mic is on. Our orb only reacts to sound while the button is held, and the label says "Listening…" so it is never ambiguous when the mic is open. Also: one accent colour on black reads well at arm's length. |
| 6 | **Friend / Limitless pendants** ([Tom's Guide on Friend](https://tomsguide.com/ai/friend-is-a-dollar99-ai-necklace-that-wants-to-help-you-remake-the-movie-her), [Yanko on Limitless](https://www.yankodesign.com/2024/04/16/the-limitless-ai-pendant-builds-on-the-mistakes-of-the-humane-ai-pin-with-better-specific-features/amp/)) | A glowing pendant whose real interface is a short message on the phone. We do the same split: the orb glows, and the last thing Ghosty said sits under it as a caption. |
| 7 | **Linear Pulse and issue history** ([Pulse](https://linear-web.pages.dev/changelog/2025-04-16-pulse), [collapsed history](https://linear-web.pages.dev/changelog/2025-04-03-collapsed-issue-history)) | Almost no chrome around each item; group and collapse noisy runs. Our cards are borderless-feeling surfaces with one bold line, and market moves are throttled per asset so the feed does not turn into a tick tape. |
| 8 | **Live-feed pattern guides** ([Oracle activity feed pattern](https://www.oracle.com/webfolder/ux/mobile/pattern/activityfeed.html), [Stream on activity feeds](https://getstream.io/blog/activity-feed-design/)) | Newest on top, and a "3 new items" indicator instead of yanking the list while someone is reading. We pause auto-insert on hover/scroll and show an "N new" pill. |
| 9 | **Whale-alert style trackers** ([Whale Alerts listing](https://www.capterra.com/p/10047418/Whale-Alerts/)) | Transactions as a live stream, filterable by asset and by transaction type. Our filter chips: All · Market · News · Agent · Transactions. |
| 10 | **Phantom activity tab** ([Phantom help](https://help.phantom.com/hc/en-us/articles/35862137120019-View-your-recent-activity), [Phantom blog](https://phantom.app/learn/blog/product-updates-recent-activity-notifications-performance-and-more)) | Each transaction shows status and chain and ends with "View on explorer". Phantom said its old activity tab lacked context, so ours always says *what* happened in words ("Long Gold · $12.50 on Hyperliquid") before the hash. |
| 11 | **Bloomberg TOP Live / Markets Live** ([Bloomberg TOPLive](https://www.bloomberg.com/news/articles/2022-03-27/toplive-blog-coverage-on-bloomberg-for-week-of-march-28), [live blogs analysis](https://medialyter.substack.com/p/publishers-live-blogs-tool-cataloging-constant-crises)) | Live blogs "inspire monitoring rather than reading": newest at top, one-sentence items, a timestamp on each. Our headline cards are source · age · headline, nothing else unless it matters (credibility, shock tag, Polymarket odds). |

Dribbble/Mobbin-style "AI agent dashboard" shots ([Verloop agent activity monitor](https://dribbble.com/verloopdesign), [Agentic AI collection](https://dribbble.com/VickyLi/collections/7642595-Agentic-AI)) mostly
pack a radar chart, KPIs and a feed into one screen. That is what `/pro` already is. The Live view deliberately keeps
only the two pieces that explain the product.

---

## 2. Personality

- **Calm.** Dark, quiet surfaces. Motion is slow unless something is actually happening.
- **Private.** The pod talks to one person. No leaderboards, no confetti, no flashing PnL. Mic state is always visible.
- **A bit ghostly.** A pale mint glow on near-black, soft edges, a small ghost face in the orb.
- **Quiet confidence.** Numbers are precise and tabular. Copy is short. When something is not configured, we say so
  plainly and say what to set.
- **Not a casino.** Green and red only mean price direction, always next to a sign or arrow. No pulsing red buttons, no
  countdowns, no "ape in".

---

## 3. Color

Dark is the default (`color-scheme: dark`). Light follows `prefers-color-scheme: light`. Every text token below passes
WCAG AA (4.5:1) on `bg`, `surface` and `raised` in its theme; the ratios were computed, not eyeballed.

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| `--color-bg` | `#07090d` | `#f5f7fa` | Page |
| `--color-surface` | `#0f1319` | `#ffffff` | Cards, nav |
| `--color-raised` | `#161b23` | `#eef1f5` | Chips, inputs, pressed states |
| `--color-line` | `#222a35` | `#dfe4ea` | Hairlines (1px) |
| `--color-text` | `#eef2f7` (16.6:1) | `#0d1117` (18.9:1) | Body text |
| `--color-muted` | `#9ba6b5` (7.6:1) | `#566170` (6.3:1) | Meta text: source, age, labels |
| `--color-ghost` | `#a6f4e0` (14.8:1) | `#0b7363` (5.8:1) | Brand accent: orb glow, focus ring, active tab, primary button |
| `--color-ghost-ink` | `#06201a` | `#ffffff` | Text on a ghost fill (13.5:1) |
| `--color-up` | `#3ddc97` | `#047857` | Price up (always with ▲ and a + sign) |
| `--color-down` | `#ff7a85` | `#c0263e` | Price down (always with ▼ and a − sign) |
| `--color-warn` | `#f5b84a` | `#a35200` | Alerts, safe-stop, "needs a key" |
| `--color-track-0g` | `#c69bff` | `#7c2fd0` | 0G (compute + storage) |
| `--color-track-hedera` | `#93a3ff` | `#4150d6` | Hedera x402 |
| `--color-track-uniswap` | `#ff85c0` | `#b8226a` | Uniswap |
| `--color-track-hyperliquid` | `#5fd4f4` | `#0b6e8c` | Hyperliquid |

Rules:

- **Track accents are used sparingly**: a 3px left border on a transaction card and the text label next to it ("0G",
  "Hedera", "Uniswap", "Hyperliquid"). No logos. Never a fill.
- **Ghost** is the only brand colour. It marks the one thing to look at: the orb, the active tab, the focus ring.
- **Status colours are reserved.** Warn means "needs your attention or a key". It is never reused for a category.
- Tinted backgrounds are the token at 10–14% alpha (`--color-*-tint`), only behind text that is in `--color-text`.

---

## 4. Typography

- **UI sans: Geist** (Google Fonts), fallback `ui-sans-serif, system-ui`. Clean, neutral, slightly technical.
- **Numbers: Geist Mono** with `font-variant-numeric: tabular-nums`, so prices and percentages line up and do not jitter
  as they tick.
- Loaded with `<link rel="preconnect">` + the Google Fonts stylesheet, `display=swap`. The UI is fully usable on the
  fallback fonts if the CDN is blocked.

| Token | Size / line | Use |
|-------|-------------|-----|
| `--text-xs` | 12 / 16 | Meta: source, age, ids |
| `--text-sm` | 14 / 20 | Card body, chips, buttons |
| `--text-md` | 16 / 24 | Card title, caption |
| `--text-lg` | 20 / 28 | Orb state label |
| `--text-xl` | 28 / 34 | Price on a market card |

Weights: 400 body, 500 labels, 600 titles. Headings use `text-wrap: balance`. No all-caps except shock tags (WAR,
SANCTION, HACK), which are short and set in mono at 11px with letter-spacing.

---

## 5. Space, radius, elevation

### Spacing scale (strict)

Components use **only** these values for padding, margin and gap. No ad-hoc pixel values in `live.css`.

| Token | px | Typical use |
|-------|----|-------------|
| `--space-1` | 4 | Icon-to-text, tight label stacks |
| `--space-2` | 8 | Inside chips and tags, between meta lines, pulse tile gaps |
| `--space-3` | 12 | Between cards (`--card-gap`), header rows |
| `--space-4` | 16 | Card padding on phones, page gutter on phones, stack gap |
| `--space-5` | 24 | Card padding (x) on desktop, page gutter on desktop, around the orb |
| `--space-6` | 32 | Device page top/bottom |
| `--space-7` | 48 | Bottom of the feed scroller, skip-link travel |
| `--space-8` | 64 | Reserved device slots (built as sums of the scale) |

`--space-0` (2px) exists only for optical nudges (segmented-tab inset, tick-flash bleed). Component tokens built from
the scale: `--card-pad-y` 16, `--card-pad-x` 16 → 24 at ≥ 900px, `--card-gap` 12, `--stack-gap` 16. Page gutter is
16px on phones, 24px on desktop.

Sizes are tokens too: `--size-control` 44 (minimum touch target), `--size-control-sm` 32, `--size-control-lg` 72 /
`--size-control-xl` 88 (the talk button), `--size-tag` 24, `--size-icon` 20, `--size-card-min` 104 (skeleton),
`--size-card-brain` 152 (reserved brain card), `--size-ticker` 8.5rem (pulse tile minimum).
- **Radii:** `--radius-sm` 6 (chips, inputs) · `--radius-md` 12 (cards) · `--radius-lg` 20 (device frame) ·
  `--radius-pill` 999 (button, pills).
- **Elevation:** dark mode uses surface steps and a hairline, not shadows (`--shadow-1` is a 1px inset line). Light
  mode adds a soft shadow (`0 1px 2px rgb(13 17 23 / 0.06), 0 4px 12px rgb(13 17 23 / 0.05)`). The only "glow" in the
  product is the orb.

---

## 6. Motion

| Token | Value | Use |
|-------|-------|-----|
| `--dur-fast` | 120ms | Hover, press feedback |
| `--dur-base` | 200ms | State label cross-fade, chip changes |
| `--dur-enter` | 320ms | Card enter |
| `--dur-breathe` | 4.2s | Idle orb breathing loop |
| `--dur-orbit` | 1.6s | Thinking shimmer orbit |
| `--dur-ripple` | 1.4s | Alert ripple |
| `--ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Things arriving |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | Loops |
| `--ease-pop` | `cubic-bezier(0.34, 1.4, 0.64, 1)` | Small pops |
| `--ease-spring` | `linear(…)` spring (cubic-bezier fallback) | Card entrance, pill, check mark |
| `--dur-spring` | 520ms | Spring settle |
| `--stagger` | 40ms | Delay between cards of one batch |
| `--dur-flash` | 600ms | Price tick tint fade |
| `--dur-glow` | 4s | "New" glow on the latest batch |
| `--tick-min-interval` | 500ms | A price repaints at most twice a second |

### Orb states

All orb motion is `transform` and `opacity` on stacked layers (GPU compositing). The live audio level is written to a
CSS variable from `requestAnimationFrame`, so React does not re-render 60 times a second.

| State | Look | Label |
|-------|------|-------|
| **idle** | Slow breathing glow (scale 1 → 1.04, 4.2s), eyes blink every few seconds | "Hold to talk" |
| **listening** | Brighter core; scale and halo follow the mic level from an `AnalyserNode` | "Listening…" |
| **thinking** | A shimmer arc orbits the core (1.6s), eyes glance up | "Thinking on 0G…" |
| **speaking** | Core pulses with the playback amplitude of the TTS PCM | "Speaking" |
| **alert** | Amber ripples expand outward; soft two-note chime; `navigator.vibrate` where available | "Heads up" + what it is |
| **offline** | Dim, steady, eyes closed. No loop. | "Brain offline: trading paused" |

### Card enter

A new card fades in and settles from 8px above (`--dur-spring`, `--ease-spring`), staggered by `--stagger` within its
batch, with a soft inset glow that fades over `--dur-glow`. The list itself never jumps: see "Motion & stability".
The View Transitions API is used for one thing, the in-place morph of a "Thinking on 0G…" card into its decision (same
element, same `view-transition-name`); every other change is a plain CSS animation on transform/opacity.

### Reduced motion

`prefers-reduced-motion: reduce` turns off the breathing loop, orbit, ripples, shimmer, heartbeat and every transform.
New cards, the pill and notes appear with a 150ms opacity fade only; reveal scrolls are instant. The orb still changes
colour (opacity cross-fade), brightness and label per state, and view transitions get `animation-duration: 0s`.

## 6b. Motion & stability

The UI must never move what someone is reading. Measured, not assumed: a `PerformanceObserver` for `layout-shift`
over a 60-second live session (1440×900, `?moveThreshold=0.05`, so a card lands every few seconds).

**Stability rules**

1. **Scroll-anchored inserts.** The feed is always a fixed-height panel that scrolls itself (`overflow-anchor: none`;
   anchoring is done by hand, including at `scrollTop` 0). After every list change, the card at the top edge keeps its
   on-screen position by adjusting `scrollTop` in the same frame (a scroll, not a layout shift). If the reader was at
   the top, the list then glides to the top to reveal what arrived.
2. **Pause, don't push.** Hovering the list or scrolling down freezes the visible set. New cards wait behind an
   "N New" pill in a fixed 44px band between the header and the list, outside the scroller, so it can never cover a
   card and showing it moves nothing. No "paused" label.
3. **Batch bursts.** SSE events arriving within 150ms are applied together in one render (`feed/batcher.ts`). A burst
   (decision + alert + state + ticks) is one layout change, not a cascade.
4. **Cap the feed** at 100 cards; cards past the 16th use `content-visibility: auto`.
5. **In place, not new.** A transaction going pending → confirmed, a "thinking" card resolving, and flapping System
   events (same topic within 60s) update their existing card; they never add a second one.
6. **Reserved space for every async region.** Pulse tiles render as same-size skeletons; the feed shows skeleton cards
   with final dimensions; the brain card reserves `--size-card-brain`; on the device, the label has a fixed height,
   the trade card / caption share one fixed slot, the hint and "Not Now" share one slot, and notes have a two-line
   slot; the "Try it" form appears only after the first snapshot.
7. **Numbers never reflow.** Every price, %, size and time uses tabular digits; pulse prices and deltas are
   right-aligned in tiles with a minimum width; relative times have a fixed minimum width; the nav status pill has
   a fixed minimum width so "Connecting…" → "0G live" never re-centres the tabs.
8. **Price ticks** update in place at most twice a second per ticker, with an up/down tint behind the digits that
   fades over 600ms (an opacity-only overlay; the box never changes size).

**Liveliness (tasteful, not noisy)**

- Staggered card entrance with a spring settle; a soft "new" glow on the latest batch.
- Relative timestamps tick on one shared 1s clock ("just now" → "12s ago" → "3m ago"); only the timestamps re-render.
- A heartbeat ring on the nav status dot pulses on every SSE event.
- Sparklines draw in (a surface-coloured cover scales away, transform only).
- "Thinking on 0G…" shimmers, then morphs into the decision in the same card.
- Transactions that settle get a check mark that pops in once.
- Orb states cross-fade: each state colour is a full layer whose opacity changes; the orb box has fixed dimensions.

**Only transform and opacity animate.** Colour changes on hover/state use short transitions; nothing animates width,
height, top or margin.

**Measured CLS (60s live session, 1440×900):** before this pass **0.037** (2 shifts: the nav status text changing
width re-centred the tabs; the pulse strip popping in). After: **0.0021** with 7 market cards inserted during the run:
0.0004 from the web font swap at load, 0.001 when the server dropped out mid-run and the offline bar pushed the page
(since changed to an overlay), and 0.0007 during one reveal scroll. Card inserts themselves: no shifts.

---

## 7. Iconography

- Unicode glyphs only, always `aria-hidden` and always next to a word: ▲ ▼ for direction, ● for live, ○ for not
  configured, ↗ for external links, ⧉ for copy. No icon font, no logo files.
- Track identity is a word ("Hyperliquid"), never a logo.

---

## 8. Voice and tone

- Short, plain English. Say what happened, then the detail. "Gold up 0.4% in a minute", not "XAU volatility event".
- Second person, active voice. "Hold to talk." "Type instead."
- The pod's own words (alert text, replies) are shown verbatim in quotes as a caption.
- When something is missing, name it and say how to fix it: "Voice needs GROQ_API_KEY + ELEVENLABS_API_KEY — type
  instead." "Decisions need OG_PRIVATE_KEY on the server."
- Empty states explain what Ghosty is waiting for. "Waiting for the next headline — the agent watches 4 news wires +
  Polymarket." Never placeholder numbers.

---

## 9. Accessibility

- Contrast: every text token is AA in both themes (table above). Focus ring: 2px `--color-ghost`, 2px offset.
- **Never colour-only.** Up/down carry ▲/▼ and a sign. Status dots carry a word ("Live", "Safe-stop", "Offline").
  Track borders carry a text label.
- Keyboard: every control is a real `<button>`, `<a>` or `<input>`. Space bar = hold-to-talk on the device page
  (ignored while typing). Filters are a radio-style group of buttons with `aria-pressed`.
- Live regions: the feed list is `aria-live="polite"`. Alerts on the device use `role="alert"` (assertive). The orb
  state label is `aria-live="polite"`.
- The orb is decorative (`aria-hidden`); its state is always in the text label.
- Reduced motion respected everywhere (section 6).
- Touch targets ≥ 44px. The talk button is 88px tall on phones.
- `/device` honours safe-area insets so it works as a full-screen phone "pod".

---

## 10. Layout

- `/` **Split.** Device on the left (~40%), feed on the right (~60%). Below 900px they stack, device first.
- `/device` Device only, full height. Built phone-first (390×844).
- `/feed` Feed only, centred column (max 760px).
- `/pro` The dense terminal.
- Top nav: `ghosty` wordmark · Live · Device · Feed · Pro (subtle) · status dot · network badge (MAINNET/TESTNET).

## 11. Feed card types

| Card | Source (real data only) | Shows |
|------|-------------------------|-------|
| Market move | SSE `market` mids, analysed in the browser | Coin, price, % with ▲/▼, sparkline. Emitted when a watched asset moves ≥ 0.25% within 60 s or breaks its 1h high/low. At most one card per asset per 2 minutes. |
| Headline | SSE `news` (+ the latest headlines from `/state` on load) | Source, age, headline, Ethos credibility, shock tag (WAR / SANCTION / HACK…), Polymarket odds |
| Brain | SSE `decision`, plus "thinking" while a request from this page is in flight | Signal, confidence, rationale, suggested legs, 0G request id (copy) |
| Alert | SSE `alert` | "Pinged your pod" and what it said |
| Transaction | SSE `order`, `episode`; swaps from `state`; x402 payment from `/x402/status` | Hyperliquid order, Uniswap swap, Hedera x402 payment, 0G Storage episode, with explorer links |
| System | `/providers/status` + SSE `providers`, safe-stop from `state` | Plain English ("0G brain unreachable — trading paused", "RSS feeds online (4/4)"); raw probe text only under "Details". Changes within 60s fold into one card that updates in place. |

Thresholds for the market detector can be lowered for a demo with `?moveThreshold=0.05` (percent). The value in use
is shown in the feed header so nobody mistakes a demo threshold for the default.
