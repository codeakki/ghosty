/**
 * Voice intent routing. Claude answers questions and chit-chat; anything that asks for a trade, or reacts to an
 * alert, stays on the 0G decision path (0G decides trades, always). When in doubt about a trade, route to 0G.
 *
 *  - `question` → Claude (research + talk). Never produces a trade.
 *  - `trade`    → the existing 0G decision loop (proposes, the button confirms).
 *  - `confirm`  → a reaction to an alert ("yes", "confirm", "cancel"). Voice never executes: the button does.
 */
export type VoiceIntent = 'question' | 'trade' | 'confirm';

/** Short reactions to an alert: "yes", "confirm", "do it", "cancel that". */
const CONFIRM =
  /^(?:ok(?:ay)?[, ]+)?(?:yes|yeah|yep|yup|sure|ok(?:ay)?|confirm(?:ed)?|do it|go ahead|go for it|execute(?: it)?|cancel|no|nope|abort|stop|don'?t)\b/i;

const TRADE_VERB = '(?:buy|sell|long|short|hedge|trade|enter|exit|close|open|add to|reduce|trim|take profits?|ape(?: into)?)';

const TRADE_PATTERNS: RegExp[] = [
  // "should I buy gold?", "can we go long oil", "would you short BTC"
  new RegExp(`\\b(?:should|shall|can|could|would|do)\\s+(?:i|we|you)\\s+(?:go\\s+|be\\s+)?${TRADE_VERB}\\b`, 'i'),
  // imperatives: "go long oil", "buy gold", "please short BTC"
  new RegExp(`^(?:please\\s+|ghosty,?\\s+)?(?:go\\s+(?:long|short)|${TRADE_VERB})\\b`, 'i'),
  /\bgo(?:ing)?\s+(?:long|short)\b/i,
  /\b(?:place|put in|submit)\s+(?:a|an|the|my)?\s*(?:trade|order|position)\b/i,
  /\bwhat\s+should\s+(?:i|we)\s+(?:buy|sell|trade|do|hedge)\b/i,
  /\b(?:hedge|protect)\s+(?:me|my|our)\b/i,
];

/**
 * "Ghosty" as Whisper tends to write it ("Ghostie", "Ghost E", "Goshty", or Devanagari "गोस्टी" / "गोश्टी"),
 * anywhere in the utterance. The always-listening pod acts only on speech that contains it.
 */
const WAKE_WORD = /\b(?:gh?o+s?h?t[\s-]?(?:y|ie|i|ee|e)|gho?sti)\b/i;
// \b is ASCII-only, so the Devanagari forms get their own pattern: गो/घो + स/श + optional virama + टी/ती.
const WAKE_WORD_DEVANAGARI = /[गघ]ो[सश]्?[टत]ी/u;

export function hasWakeWord(utterance: string): boolean {
  return WAKE_WORD.test(utterance) || WAKE_WORD_DEVANAGARI.test(utterance);
}

/** Pure keyword routing: same text in, same intent out. */
export function classifyIntent(utterance: string): VoiceIntent {
  const text = utterance.trim().replace(/\s+/g, ' ');
  const words = text.split(' ').filter(Boolean).length;
  // "no news today?" is a question, "no, cancel" is a reaction.
  if (words <= 5 && !text.endsWith('?') && CONFIRM.test(text)) return 'confirm';
  if (TRADE_PATTERNS.some((re) => re.test(text))) return 'trade';
  return 'question';
}
