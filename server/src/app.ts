import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import { FakeDecider } from './agent/decide.js';
import { InMemoryEpisodeLog } from './agent/episode.js';
import { InMemoryMemoryStore } from './agent/memory.js';
import { FakeStt } from './audio/stt.js';
import { OUTPUT_SAMPLE_RATE, ToneTts } from './audio/tts.js';
import { parseWav, WavFormatError } from './audio/wav.js';
import { loadConfig, type Config } from './config.js';
import { FakeEthosScorer } from './credibility/ethos.js';
import { FakeHyperliquid } from './execution/hyperliquid.js';
import { FakeCryptoPanicProvider } from './news/cryptopanic.js';
import { FakeGrokProvider } from './news/grok.js';
import { FakePolymarketProvider } from './news/polymarket.js';
import { FakeRssProvider } from './news/rss.js';
import { Pipeline, type PipelineDeps } from './pipeline.js';
import { isBrainOnline } from './safety/safeStop.js';
import { VERSION } from './version.js';

/** 30 s of 16 kHz 16-bit mono is ~960 KB; leave headroom. */
const AUDIO_BODY_LIMIT = 4 * 1024 * 1024;

const ButtonBody = z.object({ action: z.enum(['confirm', 'cancel']) });

export interface BuildAppOptions {
  config?: Config;
  deps?: Partial<PipelineDeps>;
  logger?: FastifyServerOptions['logger'];
}

/** Day-one wiring: every provider is a fake. Swap in real ones here as issues land. */
export function defaultDeps(config: Config): PipelineDeps {
  return {
    stt: new FakeStt(),
    tts: new ToneTts(),
    news: [new FakeRssProvider(), new FakeCryptoPanicProvider(), new FakePolymarketProvider(), new FakeGrokProvider()],
    decider: new FakeDecider(new FakeEthosScorer()),
    memory: new InMemoryMemoryStore(),
    episodes: new InMemoryEpisodeLog(),
    venue: new FakeHyperliquid(),
    maxTradeUsd: config.MAX_TRADE_USD,
  };
}

function tokenMatches(got: string, expected: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const config = opts.config ?? loadConfig();
  const pipeline = new Pipeline({ ...defaultDeps(config), ...opts.deps });
  const app = Fastify({ logger: opts.logger ?? false });

  // The device posts WAV; accept the common audio types plus octet-stream as a raw Buffer.
  app.addContentTypeParser(
    ['audio/wav', 'audio/x-wav', 'audio/wave', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: AUDIO_BODY_LIMIT },
    (_req, body, done) => done(null, body),
  );

  const requireDevice = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.DEVICE_TOKEN) return; // local dev: no token configured
    const got = req.headers['x-device-token'];
    if (typeof got !== 'string' || !tokenMatches(got, config.DEVICE_TOKEN)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  const requireBrain = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!(await isBrainOnline(config))) {
      return reply.code(503).send({ error: 'brain_offline' });
    }
  };

  app.get('/health', async () => ({
    ok: true,
    version: VERSION,
    // true = safe-stop engaged: 0G unreachable, trading blocked.
    safeStop: !(await isBrainOnline(config)),
  }));

  app.post('/voice', { preHandler: [requireDevice, requireBrain] }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reply.code(400).send({ error: 'expected_wav_body' });
    }
    let wav;
    try {
      wav = parseWav(req.body);
    } catch (err) {
      if (err instanceof WavFormatError) return reply.code(400).send({ error: 'bad_wav', message: err.message });
      throw err;
    }
    if (wav.sampleRate !== 16000) req.log.warn({ sampleRate: wav.sampleRate }, 'expected 16 kHz input');

    const result = await pipeline.handleVoice(wav);
    req.log.info(
      { requestId: result.decision.requestId, signal: result.decision.signal, confidence: result.decision.confidence },
      'voice decision',
    );
    return reply
      .header('content-type', 'application/octet-stream')
      .header('x-sample-rate', String(OUTPUT_SAMPLE_RATE))
      .header('x-request-id', result.decision.requestId)
      .header('x-signal', result.decision.signal)
      .send(result.audio);
  });

  app.post('/button', { preHandler: [requireDevice, requireBrain] }, async (req, reply) => {
    const parsed = ButtonBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', message: 'body must be {"action":"confirm"|"cancel"}' });
    }
    return pipeline.handleButton(parsed.data.action);
  });

  return app;
}
