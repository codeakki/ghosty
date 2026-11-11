import 'dotenv/config';
import { Brain, type BrainOptions } from './brain.js';

/** Ask Ghosty's brain from the terminal, no pod or server needed: npm run ask -- "what's the weather in Pune?" */
const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  console.error('usage: npm run ask -- "your question"');
  process.exit(1);
}
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) {
  console.error('Missing ANTHROPIC_API_KEY in assistant/.env');
  process.exit(1);
}
const brain = new Brain({
  apiKey,
  model: process.env.CLAUDE_MODEL?.trim() || 'claude-sonnet-5-5',
  effort: (process.env.CLAUDE_EFFORT?.trim() || 'medium') as BrainOptions['effort'],
});
const started = Date.now();
const answer = await brain.ask(question);
console.log(answer.text);
console.log(`\n(${answer.model}, ${answer.searches} web lookups, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
