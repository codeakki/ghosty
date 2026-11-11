import 'dotenv/config';
import { Readable } from 'node:stream';
import { networkInterfaces } from 'node:os';
import Fastify, { type FastifyReply } from 'fastify';
import { Brain, type BrainOptions } from './brain.js';
import { ErrorVoice, type ErrorKind } from './errors.js';
import { hasWakeWord, isOnlyWakeWord, OUTPUT_SAMPLE_RATE, parseWav, synthesize, transcribe, type TtsKeys } from './audio.js';
import { decodeForPod, MusicLibrary, type Track } from './music.js';
import { Reminders } from './reminders.js';
import { contextLine, Notes, runTool, SettingsStore, TOOL_DEFS, type Player, type ToolDeps } from './tools.js';

/**
 * Ghosty personal assistant server. Speaks the same protocol as the pod firmware (07_AlwaysListen):
 *   POST /voice     WAV in -> 200 + raw PCM s16le 16 kHz, or 204 when nobody said "Ghosty"
 *   GET  /announce  queued audio (songs, reminders) for the pod, 204 when nothing is queued
 *   POST /pod/state 200
 *   POST /ask       {"text": "..."} -> {"reply": "..."}  (test from this PC, no pod needed)
 *   POST /play      raw PCM to queue (npm run play), POST /stop (npm run stop)
 */

const env = process.env;
const need = (name: string) => {
  const v = env[name]?.trim();
  if (!v) {
    console.error(`Missing ${name} in assistant/.env (see .env.example).`);
    process.exit(1);
  }
  return v;
};

const groqKey = env.GROQ_API_KEY?.trim();
const tts: TtsKeys = {
  elevenLabsKey: env.ELEVENLABS_API_KEY?.trim() || undefined,
  elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID?.trim() || undefined,
  openAiKey: env.OPENAI_API_KEY?.trim() || undefined,
};
const deviceToken = need('GHOSTY_DEVICE_TOKEN');
const port = Number(env.PORT || 8787);
// Whisper guesses the language per clip and gets short clips wrong (Hindi, Spanish). "auto" = let it guess.
const sttLanguage = (env.STT_LANGUAGE?.trim() || 'en').toLowerCase();
const sttLanguageHint = sttLanguage === 'auto' ? undefined : sttLanguage;
// Music level before the volume setting. The pod boosts 4x for speech; 1.0 = loudest (peaks get limited).
const MUSIC_GAIN = Number(env.MUSIC_GAIN || 1.0);

/** After an answer, the next words need no "Ghosty": "Ghosty... (pause) ...how are you?" is one conversation. */
const FOLLOW_UP_MS = 25_000;
let followUpUntil = 0;

// ---- Audio helpers ---------------------------------------------------------------

const settings = new SettingsStore();

/** Apply the volume setting (0-100) to PCM going to the pod. */
function atVolume(pcm: Buffer): Buffer {
  const v = settings.get().volume / 100;
  if (v >= 0.999) return pcm;
  const out = Buffer.alloc(pcm.length - (pcm.length % 2));
  for (let i = 0; i < out.length; i += 2) out.writeInt16LE(Math.round(pcm.readInt16LE(i) * v), i);
  return out;
}

/** Two-note chime before a reminder, so it is not mistaken for a reply. */
function chime(): Buffer {
  const notes = [
    { hz: 988, ms: 160 },
    { hz: 1319, ms: 260 },
  ];
  const parts = notes.map(({ hz, ms }) => {
    const n = Math.round((OUTPUT_SAMPLE_RATE * ms) / 1000);
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 160, (n - i) / 800);
      b.writeInt16LE(Math.round(5000 * env * Math.sin((2 * Math.PI * hz * i) / OUTPUT_SAMPLE_RATE)), i * 2);
    }
    return b;
  });
  return Buffer.concat([parts[0]!, parts[1]!, Buffer.alloc(OUTPUT_SAMPLE_RATE / 5)]);  // + 200 ms gap
}

// ---- The pod's play queue --------------------------------------------------------

interface QueueItem {
  name: string;
  pcm: Buffer;
  kind: 'song' | 'reminder' | 'clip';
}
const playQueue: QueueItem[] = [];
/** The item now playing, kept so a stream cut by Wi-Fi can resume (X-Resume-From: byte offset). */
let nowPlaying: (QueueItem & { at: number; cut?: () => void }) | undefined;
const RESUME_WINDOW_MS = 10 * 60_000;
const secondsOf = (pcm: Buffer) => Math.round(pcm.length / 2 / OUTPUT_SAMPLE_RATE);

function enqueue(item: QueueItem): number {
  // Reminders jump the queue: they are time-sensitive, songs are not.
  if (item.kind === 'reminder') {
    const firstSong = playQueue.findIndex((q) => q.kind !== 'reminder');
    playQueue.splice(firstSong < 0 ? playQueue.length : firstSong, 0, item);
  } else {
    playQueue.push(item);
  }
  return playQueue.indexOf(item) + 1;
}

const player: Player = {
  async queueTrack(track: Track) {
    const pcm = await decodeForPod(track.path, MUSIC_GAIN);
    const position = enqueue({ name: track.title, pcm, kind: 'song' });
    app.log.info({ name: track.title, sec: secondsOf(pcm), position }, 'queued for the pod');
    return { seconds: secondsOf(pcm), position };
  },
  stop() {
    const cleared = playQueue.filter((q) => q.kind === 'song').length;
    for (let i = playQueue.length - 1; i >= 0; i--) if (playQueue[i]!.kind === 'song') playQueue.splice(i, 1);
    const current = nowPlaying?.kind === 'song' ? nowPlaying : undefined;
    if (current) {
      current.cut?.();  // ends the stream on the pod; clearing nowPlaying makes its resume get 204
      nowPlaying = undefined;
    }
    app.log.info({ cleared, stopped: current?.name ?? null }, 'music stopped');
    return { cleared, stoppedCurrent: current?.name ?? null };
  },
  status() {
    const playing = nowPlaying && Date.now() - nowPlaying.at < secondsOf(nowPlaying.pcm) * 1000 + 15_000 ? nowPlaying.name : null;
    return { playing, queued: playQueue.map((q) => q.name) };
  },
};

// ---- Brain and tools -------------------------------------------------------------

const music = new MusicLibrary();
const reminders = new Reminders();
const notes = new Notes();
const deps: ToolDeps = { music, player, reminders, notes, settings };

const brain = new Brain({
  apiKey: need('ANTHROPIC_API_KEY'),
  model: env.CLAUDE_MODEL?.trim() || 'claude-sonnet-5-5',
  effort: (env.CLAUDE_EFFORT?.trim() || 'medium') as BrainOptions['effort'],
  tools: {
    defs: TOOL_DEFS,
    run: async (name, input) => {
      const r = await runTool(name, input, deps);
      app.log.info({ tool: name, input, result: r.content }, 'tool');
      return r;
    },
    context: () => contextLine(deps),
  },
});

// ---- HTTP ------------------------------------------------------------------------

const app = Fastify({
  logger: { level: 'info', transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname,reqId' } } },
  bodyLimit: 4 * 1024 * 1024,
});

app.addContentTypeParser(['audio/wav', 'application/octet-stream'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

const errorVoice = new ErrorVoice(tts);

/**
 * Answer the pod with a spoken error. 200 + audio so the pod plays it; X-Ghosty-Error names the kind.
 * When even the cached clip is missing, a 500 with no audio: the pod then plays its own error beeps.
 */
async function sendError(reply: FastifyReply, kind: ErrorKind, detail: string) {
  reply.log.error({ kind, detail }, `voice turn failed: ${kind}`);
  const clip = await errorVoice.clip(kind);
  if (!clip) return reply.code(500).header('x-ghosty-error', kind).send({ error: kind, detail });
  return reply
    .header('content-type', 'application/octet-stream')
    .header('x-sample-rate', String(OUTPUT_SAMPLE_RATE))
    .header('x-ghosty-error', kind)
    .send(atVolume(clip));
}

const UPLOAD_STALL_MS = 30_000;

app.addHook('onRequest', async (req, reply) => {
  (req as { startedAt?: number }).startedAt = performance.now();
  if (req.url === '/health') return;
  if (req.headers['x-device-token'] !== deviceToken) {
    // Only /voice gets a spoken answer: the pod plays that reply, and it is the one the user waits on.
    if (req.method === 'POST' && req.url === '/voice') return sendError(reply, 'token', 'X-Device-Token does not match');
    return reply.code(401).send({ error: 'bad_device_token' });
  }
  // A stalled Wi-Fi upload must not hang forever. Only while the pod uploads its recording:
  // a long song going the other way must never be cut by this.
  if (req.method === 'POST' && req.url === '/voice') {
    req.raw.socket.setTimeout(UPLOAD_STALL_MS, () => req.raw.socket.destroy());
  }
});

app.addHook('preHandler', async (req) => {
  if (req.method === 'POST' && req.url === '/voice') req.raw.socket.setTimeout(0);  // upload done
});

// Anything unexpected on /voice is still spoken, never silence.
app.setErrorHandler(async (err, req, reply) => {
  if (req.method === 'POST' && req.url === '/voice') return sendError(reply, 'server', (err as Error).message);
  req.log.error({ err: (err as Error).message }, 'request failed');
  return reply.code(500).send({ error: 'server_error' });
});

/**
 * Stream long audio in 16 KB chunks, only as fast as the pod reads (backpressure). Sending a whole song
 * in one write hands it all to Windows at once, and then nothing can stop it. Returns a cut() that ends
 * the stream for real (stop, or a test of the pod's resume).
 */
function streamPcm(reply: FastifyReply, pcm: Buffer): () => void {
  const socket = reply.raw.socket;  // kept now: the response detaches from it later
  const chunks = function* () {
    for (let i = 0; i < pcm.length; i += 16_384) yield pcm.subarray(i, i + 16_384);
  };
  const stream = Readable.from(chunks(), { objectMode: false });
  reply
    .header('content-type', 'application/octet-stream')
    .header('content-length', String(pcm.length))  // the pod needs the length to know a stream was cut
    .header('x-sample-rate', String(OUTPUT_SAMPLE_RATE))
    .send(stream);
  return () => {
    stream.destroy();
    socket?.resetAndDestroy();
  };
}

const sendPcm = (reply: FastifyReply, pcm: Buffer) =>
  reply.header('content-type', 'application/octet-stream').header('x-sample-rate', String(OUTPUT_SAMPLE_RATE)).send(pcm);

app.get('/health', async () => ({ ok: true, stt: Boolean(groqKey), tts: Boolean(tts.elevenLabsKey || tts.openAiKey), ...player.status() }));

app.get('/announce', async (req, reply) => {
  const resume = Number(req.headers['x-resume-from']);
  if (resume > 0 && nowPlaying && Date.now() - nowPlaying.at < RESUME_WINDOW_MS && resume < nowPlaying.pcm.length) {
    const from = resume - (resume % 2);
    req.log.info({ name: nowPlaying.name, fromSec: Math.round(from / 2 / OUTPUT_SAMPLE_RATE) }, 'resuming on the pod');
    nowPlaying.at = Date.now();
    nowPlaying.cut = streamPcm(reply, atVolume(nowPlaying.pcm.subarray(from)));
    return reply;
  }
  const next = playQueue.shift();
  if (!next) return reply.code(204).send();
  nowPlaying = { ...next, at: Date.now() };
  req.log.info({ name: next.name, kind: next.kind, sec: secondsOf(next.pcm), left: playQueue.length }, 'playing on the pod');
  nowPlaying.cut = streamPcm(reply, atVolume(next.pcm));
  return reply;
});

// Raw PCM s16le mono 16 kHz in the body; X-Name labels it. Songs are big: 64 MB is about 35 minutes.
app.post('/play', { bodyLimit: 64 * 1024 * 1024 }, async (req, reply) => {
  if (!Buffer.isBuffer(req.body) || req.body.length < 2) return reply.code(400).send({ error: 'expected raw PCM body' });
  const name = decodeURIComponent(String(req.headers['x-name'] ?? 'audio'));
  const pcm = req.body.subarray(0, req.body.length - (req.body.length % 2));
  const position = enqueue({ name, pcm, kind: 'song' });
  req.log.info({ name, sec: secondsOf(pcm), position }, 'queued for the pod');
  return { queued: name, seconds: secondsOf(pcm), position };
});

app.post('/stop', async () => player.stop());

// Test hook: cut the current stream but keep it resumable, as a Wi-Fi drop would.
app.post('/debug/cut', async () => {
  const had = Boolean(nowPlaying?.cut);
  nowPlaying?.cut?.();
  return { cut: had, name: nowPlaying?.name ?? null };
});

app.post('/pod/state', async () => ({ ok: true }));

app.post('/ask', async (req, reply) => {
  const text = (req.body as { text?: unknown } | undefined)?.text;
  if (typeof text !== 'string' || !text.trim()) return reply.code(400).send({ error: 'body must be {"text": "..."}' });
  const answer = await brain.ask(text.trim());
  req.log.info({ q: text, a: answer.text, tools: answer.tools, model: answer.model }, 'ask');
  return { reply: answer.text, searches: answer.searches, tools: answer.tools, rounds: answer.rounds, model: answer.model };
});

app.post('/voice', async (req, reply) => {
  if (!groqKey) return sendError(reply, 'stt', 'GROQ_API_KEY is not set');
  if (!tts.elevenLabsKey && !tts.openAiKey) return sendError(reply, 'tts', 'no ELEVENLABS_API_KEY or OPENAI_API_KEY');
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return sendError(reply, 'server', 'empty /voice body');

  let wav;
  try {
    wav = parseWav(req.body);
  } catch (err) {
    return sendError(reply, 'server', `bad WAV from the pod: ${(err as Error).message}`);
  }

  // Stage timings (ms). upload = request start to body received, i.e. the pod's Wi-Fi upload.
  const ms: Record<string, number> = { upload: Math.round(performance.now() - (req as { startedAt?: number }).startedAt!) };
  const audioSec = Number((wav.pcm.length / 2 / wav.sampleRate).toFixed(1));
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    ms[name] = Math.round(now - t);
    t = now;
  };

  let heard: string;
  try {
    heard = await transcribe(wav, groqKey, sttLanguageHint);
  } catch (err) {
    return sendError(reply, 'stt', errorDetail(err));
  }
  lap('stt');

  const always = req.headers['x-listen'] === 'always';
  const followUp = Date.now() < followUpUntil;
  if (!heard || (always && !followUp && !hasWakeWord(heard))) {
    req.log.info({ heard, audioSec, ms }, 'no wake word, ignored');
    return reply.code(204).send();
  }

  let text: string;
  let audio: Buffer;
  let tools: string[] = [];
  if (isOnlyWakeWord(heard) && quickYes) {
    // Just "Ghosty": answer at once and wait for the question (the follow-up window).
    text = 'Yes?';
    audio = quickYes;
  } else {
    try {
      const answer = await brain.ask(heard);
      text = answer.text;
      tools = answer.tools;
    } catch (err) {
      return sendError(reply, 'claude', `${errorDetail(err)} (heard: ${heard})`);
    }
    lap('claude');
    try {
      audio = await synthesize(text, tts);
    } catch (err) {
      return sendError(reply, 'tts', `${errorDetail(err)} (reply was: ${text})`);
    }
    lap('tts');
  }
  ms.total = Math.round(performance.now() - (req as { startedAt?: number }).startedAt!);
  const replySec = Number((audio.length / 2 / OUTPUT_SAMPLE_RATE).toFixed(1));
  // The window opens once the reply has finished playing.
  followUpUntil = Date.now() + replySec * 1000 + FOLLOW_UP_MS;
  req.log.info({ heard, reply: text, tools, followUp, audioSec, replySec, ms }, 'voice turn');
  return sendPcm(reply, atVolume(audio));
});

// The pod only ever sees 200, 204 or an error from this server: no sign requests, no trades.
app.post('/sign', async (_req, reply) => reply.code(404).send({ error: 'no_signer_on_this_server' }));
// The pod asks for background Dabao sign requests while idle: never any here.
app.get('/sign/next', async (_req, reply) => reply.code(204).send());

/** The message plus its network cause, e.g. "fetch failed: Connect Timeout Error". */
function errorDetail(err: unknown): string {
  const e = err as Error & { cause?: { message?: string } };
  return e.cause?.message ? `${e.message}: ${e.cause.message}` : (e.message ?? String(err));
}

// ---- Start -----------------------------------------------------------------------

// "Yes?" for a bare "Ghosty": pre-made so it plays without a Claude or voice-service round trip.
let quickYes: Buffer | undefined;
try {
  quickYes = await synthesize('Yes?', tts);
} catch {
  console.warn('Could not pre-make the "Yes?" clip; a bare "Ghosty" goes to Claude instead.');
}

const notReady = await errorVoice.prepare();
if (notReady.length) console.warn(`Error clips not ready (voice service down?): ${notReady.join(', ')}. The pod will beep for those.`);

// Due reminders: chime + spoken text, at the front of the pod's queue. The pod checks the queue every
// 15 s and right after each reply, so a reminder plays within about 15 s of its time.
reminders.start(async (r, lateMs) => {
  const late = lateMs > 5 * 60_000 ? ' This one is late: the assistant was off at the time.' : '';
  let speech: Buffer;
  try {
    speech = await synthesize(`Reminder: ${r.text}.${late}`, tts);
  } catch (err) {
    app.log.error({ id: r.id, err: errorDetail(err) }, 'reminder speech failed; chime only');
    speech = Buffer.concat([chime(), chime()]);
  }
  enqueue({ name: `reminder: ${r.text}`, pcm: Buffer.concat([chime(), speech]), kind: 'reminder' });
  app.log.info({ id: r.id, text: r.text, lateMs }, 'reminder due, queued for the pod');
});

await app.listen({ host: '0.0.0.0', port });
const ips = Object.values(networkInterfaces())
  .flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal)
  .map((n) => n!.address);
console.log(`\nGhosty assistant is up. Music folders: ${music.all().length} songs found. In the pod's secrets.h use one of:`);
for (const ip of ips) console.log(`  #define GHOSTY_SERVER_URL "http://${ip}:${port}"`);
console.log('');
