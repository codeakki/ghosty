/**
 * Virtual pod CLI: drive a running Ghosty server the way the pod would, from a terminal.
 *
 *   npm run pod -- say "is anything moving gold?"
 *   npm run pod -- wav sample.wav
 *   npm run pod -- press confirm|cancel
 *   npm run pod -- inject "Missile strike near Hormuz" [--source Reuters] [--url https://...]
 *   npm run pod -- state
 *   npm run pod -- watch
 *   npm run pod -- next | ack <alert-id> | safe-stop on|off
 *   npm run pod -- sim list | run <scenario-id> [--speed 360] [--no-autopause] | pause | resume | stop | status
 *
 * Env: SERVER_URL (default http://localhost:$PORT or :3000), DEVICE_TOKEN (sent as X-Device-Token),
 * POD_OUT_DIR (where PCM replies are saved, default /tmp). Reads server/.env like the server does.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const SERVER_URL = (process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/+$/, '');
const DEVICE_TOKEN = process.env.DEVICE_TOKEN?.trim() || undefined;
const OUT_DIR = process.env.POD_OUT_DIR ?? '/tmp';

const USAGE = `usage: npm run pod -- <command>

  say "<text>"                   text turn through decide + TTS (POST /voice/text); saves PCM
  wav <file.wav>                 post a WAV like the pod (POST /voice); saves PCM, prints headers
  press confirm|cancel           press the button (POST /button)
  inject "<headline>" [--source <handle>] [--url <url>]
                                 add a headline and run the decision loop (POST /news/inject)
  state                          print the pod state (GET /state)
  watch                          tail the event stream (GET /events)
  next                           pop the next pending alert (GET /alerts/next)
  ack <alert-id>                 acknowledge an alert (POST /alerts/:id/ack)
  safe-stop on|off               simulate 0G offline (POST /sim/safe-stop)
  sim list                       list replay scenarios (GET /sim/scenarios)
  sim run <id> [--speed N] [--no-autopause]
                                 start a scenario replay, paper trades only (POST /sim/run)
  sim pause|resume|stop          control the run (POST /sim/control)
  sim status                     run status: sim time, P&L vs hold, positions (GET /sim/run)

env: SERVER_URL=${SERVER_URL}  DEVICE_TOKEN=${DEVICE_TOKEN ? '(set)' : '(unset)'}  POD_OUT_DIR=${OUT_DIR}`;

class CliError extends Error {}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return DEVICE_TOKEN ? { ...extra, 'x-device-token': DEVICE_TOKEN } : extra;
}

async function request(method: string, path: string, body?: unknown): Promise<{ res: Response; data: unknown; ms: number }> {
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(SERVER_URL + path, {
      method,
      headers: headers(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new CliError(`cannot reach ${SERVER_URL}: ${(err as Error).message}. Is \`npm run dev\` running?`);
  }
  const text = await res.text();
  const ms = Math.round(performance.now() - started);
  let data: unknown = text;
  if ((res.headers.get('content-type') ?? '').includes('json') && text) data = JSON.parse(text);
  return { res, data, ms };
}

/** Throw a readable error for any non-2xx answer. */
function check(res: Response, data: unknown, what: string): void {
  if (res.ok) return;
  const hint =
    res.status === 503 ? ' (safe-stop engaged: brain offline)' : res.status === 401 ? ' (set DEVICE_TOKEN to match the server)' : '';
  throw new CliError(`${what} → ${res.status}${hint}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

async function savePcm(prefix: string, pcm: Buffer, sampleRate: number): Promise<string> {
  const file = join(OUT_DIR, `ghosty-${prefix}-${stamp()}.pcm`);
  await writeFile(file, pcm);
  console.log(`saved ${pcm.length} bytes PCM s16le ${sampleRate} Hz mono (${(pcm.length / 2 / sampleRate).toFixed(2)} s) → ${file}`);
  console.log(`play: ffplay -autoexit -f s16le -ar ${sampleRate} -ac 1 ${file}`);
  return file;
}

async function say(text: string | undefined): Promise<void> {
  if (!text) throw new CliError('say needs text: npm run pod -- say "what is moving gold?"');
  const { res, data, ms } = await request('POST', '/voice/text', { text });
  check(res, data, 'POST /voice/text');
  const { audioBase64, ...rest } = data as { audioBase64: string; sampleRate: number } & Record<string, unknown>;
  print({ ...rest, latencyMs: ms });
  await savePcm('say', Buffer.from(audioBase64, 'base64'), rest.sampleRate);
}

async function wav(file: string | undefined): Promise<void> {
  if (!file) throw new CliError('wav needs a file: npm run pod -- wav sample.wav');
  const body = await readFile(file);
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}/voice`, { method: 'POST', headers: headers({ 'content-type': 'audio/wav' }), body });
  } catch (err) {
    throw new CliError(`cannot reach ${SERVER_URL}: ${(err as Error).message}`);
  }
  const reply = Buffer.from(await res.arrayBuffer());
  const ms = Math.round(performance.now() - started);
  console.log(`POST /voice ${body.length} bytes → ${res.status} in ${ms} ms`);
  for (const name of ['content-type', 'content-length', 'x-sample-rate', 'x-request-id', 'x-signal']) {
    console.log(`  ${name}: ${res.headers.get(name) ?? '-'}`);
  }
  check(res, reply.toString('utf8'), 'POST /voice');
  await savePcm('reply', reply, Number(res.headers.get('x-sample-rate')) || 16000);
}

async function press(action: string | undefined): Promise<void> {
  if (action !== 'confirm' && action !== 'cancel') throw new CliError('press needs confirm or cancel');
  const { res, data, ms } = await request('POST', '/button', { action });
  check(res, data, 'POST /button');
  print({ ...(data as object), latencyMs: ms });
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

async function inject(args: string[]): Promise<void> {
  const source = flag(args, 'source');
  const url = flag(args, 'url');
  const title = args.join(' ').trim();
  if (!title) throw new CliError('inject needs a headline: npm run pod -- inject "Missile strike near Hormuz" --source Reuters');
  const { res, data, ms } = await request('POST', '/news/inject', { title, ...(source ? { source } : {}), ...(url ? { url } : {}) });
  check(res, data, 'POST /news/inject');
  print({ ...(data as object), latencyMs: ms });
}

async function state(): Promise<void> {
  const { res, data } = await request('GET', '/state');
  check(res, data, 'GET /state');
  print(data);
}

async function next(): Promise<void> {
  const { res, data } = await request('GET', '/alerts/next');
  check(res, data, 'GET /alerts/next');
  if (res.status === 204) console.log('204 no pending alert');
  else print(data);
}

async function ack(id: string | undefined): Promise<void> {
  if (!id) throw new CliError('ack needs an alert id, e.g. alert-1');
  const { res, data } = await request('POST', `/alerts/${encodeURIComponent(id)}/ack`);
  check(res, data, 'POST /alerts/:id/ack');
  print(data);
}

async function safeStop(mode: string | undefined): Promise<void> {
  if (mode !== 'on' && mode !== 'off') throw new CliError('safe-stop needs on or off');
  const { res, data } = await request('POST', '/sim/safe-stop', { enabled: mode === 'on' });
  check(res, data, 'POST /sim/safe-stop');
  print(data);
}

/** One line per event. */
function describe(type: string, d: Record<string, unknown>): string {
  switch (type) {
    case 'news': {
      const c = d.credibility as { level: string; handle: string } | null;
      return `${String(d.title)}${c ? ` [${c.handle}: ${c.level}]` : ''}`;
    }
    case 'decision':
      return `${String(d.signal)} conf=${String(d.confidence)} via ${String(d.trigger)} ${String(d.requestId)}`;
    case 'alert':
      return `${String(d.id)} ${String(d.signal)}: ${String(d.text)}`;
    case 'order':
      return `${String(d.orderId)} ${d.isBuy ? 'buy' : 'sell'} ${String(d.coin)} $${String(d.sizeUsd)} ${String(d.status)}`;
    case 'episode':
      return `#${String(d.seq)} ${String(d.outcome)} ${String(d.requestId)}`;
    case 'sim': {
      const s = d as { status: string; simTime: string; progress: number; pnlUsd: number; baselinePnlUsd: number };
      return `${s.status} ${s.simTime} ${Math.round(s.progress * 100)}% pnl=$${s.pnlUsd} hold=$${s.baselinePnlUsd}`;
    }
    case 'state': {
      const s = d as { news: unknown[]; alerts: Array<{ status: string }>; orders: unknown[]; safeStop: boolean };
      const pending = s.alerts.filter((a) => a.status === 'pending').length;
      return `news=${s.news.length} alerts_pending=${pending} orders=${s.orders.length} safeStop=${s.safeStop}`;
    }
    default:
      return JSON.stringify(d);
  }
}

async function watch(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}/events`, { headers: { accept: 'text/event-stream' } });
  } catch (err) {
    throw new CliError(`cannot reach ${SERVER_URL}: ${(err as Error).message}`);
  }
  if (!res.ok || !res.body) throw new CliError(`GET /events → ${res.status}`);
  console.log(`watching ${SERVER_URL}/events (Ctrl-C to stop)`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let type = 'message';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue; // retry hint or ping
      const time = new Date().toLocaleTimeString();
      console.log(`${time}  ${type.padEnd(8)} ${describe(type, JSON.parse(dataLines.join('\n')) as Record<string, unknown>)}`);
    }
  }
  console.log('stream closed by server');
}

async function sim(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'list') {
    const { res, data } = await request('GET', '/sim/scenarios');
    check(res, data, 'GET /sim/scenarios');
    for (const s of (data as { scenarios: Array<{ id: string; title: string; start: string; end: string; headlines: unknown[] }> }).scenarios) {
      console.log(`${s.id.padEnd(28)} ${s.title}  [${s.start} → ${s.end}, ${s.headlines.length} headlines]`);
    }
    return;
  }
  if (sub === 'run') {
    const noAutoPause = rest.includes('--no-autopause');
    const args2 = rest.filter((a) => a !== '--no-autopause');
    const speed = flag(args2, 'speed');
    const scenarioId = args2[0];
    if (!scenarioId) throw new CliError('sim run needs a scenario id: npm run pod -- sim list');
    const body = { scenarioId, ...(speed ? { speed: Number(speed) } : {}), ...(noAutoPause ? { autoPauseOnAlert: false } : {}) };
    const { res, data } = await request('POST', '/sim/run', body);
    check(res, data, 'POST /sim/run');
    print(data);
    console.log('follow it with: npm run pod -- sim status   (or: npm run pod -- watch)');
    return;
  }
  if (sub === 'pause' || sub === 'resume' || sub === 'stop') {
    const { res, data } = await request('POST', '/sim/control', { action: sub });
    check(res, data, 'POST /sim/control');
    const s = data as { status: string; simTime: string };
    console.log(`${s.status} at sim time ${s.simTime}`);
    return;
  }
  if (sub === 'status') {
    const { res, data } = await request('GET', '/sim/run');
    check(res, data, 'GET /sim/run');
    const { episodeList: _episodes, ...s } = data as Record<string, unknown>;
    print(s);
    return;
  }
  throw new CliError('sim needs list | run <id> [--speed N] | pause | resume | stop | status');
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'say':
      return say(args.join(' ').trim() || undefined);
    case 'wav':
      return wav(args[0]);
    case 'press':
      return press(args[0]);
    case 'inject':
      return inject(args);
    case 'state':
      return state();
    case 'watch':
      return watch();
    case 'next':
      return next();
    case 'ack':
      return ack(args[0]);
    case 'safe-stop':
      return safeStop(args[0]);
    case 'sim':
      return sim(args);
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      console.log(USAGE);
      return;
    default:
      throw new CliError(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof CliError ? `error: ${err.message}` : err);
  process.exitCode = 1;
});
