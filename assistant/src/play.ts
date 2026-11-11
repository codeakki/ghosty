import 'dotenv/config';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';

/**
 * Play a song or any audio file on the pod: npm run play -- "C:\path\to\song.mp3" [--from 1:40]
 * ffmpeg converts it to the pod's format (raw PCM s16le, mono, 16 kHz) and the server queues it.
 * The pod picks it up on its next check (within about 15 s).
 */
const args = process.argv.slice(2);
const fromAt = args.indexOf('--from');
const from = fromAt >= 0 ? args.splice(fromAt, 2)[1] : undefined;  // "1:40" or "100" (seconds)
const file = args.join(' ').trim().replace(/^"|"$/g, '');
if (!file) {
  console.error('usage: npm run play -- "C:\\path\\to\\song.mp3" [--from 1:40]');
  process.exit(1);
}
const token = process.env.GHOSTY_DEVICE_TOKEN?.trim();
const port = Number(process.env.PORT || 8787);

// The pod boosts everything 4x for speech (SPEAKER_GAIN). Music is mastered loud, so turn it down
// first or the pod's limiter squashes it. 0.3 plays at about the loudness of a spoken reply.
const VOLUME = Number(process.env.PLAY_VOLUME || 0.3);

const pcm = await new Promise<Buffer>((resolve, reject) => {
  const ff = spawn('ffmpeg', ['-v', 'error', ...(from ? ['-ss', from] : []), '-i', file, '-ac', '1', '-ar', '16000', '-af', `volume=${VOLUME}`, '-f', 's16le', '-'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  let err = '';
  ff.stdout.on('data', (c: Buffer) => chunks.push(c));
  ff.stderr.on('data', (c: Buffer) => (err += c));
  ff.on('error', reject);
  ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg failed: ${err.trim()}`))));
});

const res = await fetch(`http://127.0.0.1:${port}/play`, {
  method: 'POST',
  headers: { 'x-device-token': token ?? '', 'content-type': 'application/octet-stream', 'x-name': encodeURIComponent(basename(file)) },
  body: new Uint8Array(pcm),
});
if (!res.ok) {
  console.error(`server said ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const info = (await res.json()) as { seconds: number; position: number };
const min = Math.floor(info.seconds / 60);
console.log(`Queued "${basename(file)}" (${min}:${String(info.seconds % 60).padStart(2, '0')}), position ${info.position}. The pod plays it within about 15 s.`);
