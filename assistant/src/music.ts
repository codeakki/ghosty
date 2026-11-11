import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';

/**
 * The music library: audio files in the user's folders on this PC, found by name.
 * Folders: MUSIC_DIRS (separated by ;) or Music, Desktop and Downloads (plain and OneDrive).
 */

const AUDIO = new Set(['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.aac', '.opus', '.wma']);
const MAX_DEPTH = 4;
const RESCAN_MS = 60_000;

export interface Track {
  path: string;
  /** Cleaned-up name for speaking and matching: "Imran Khan - Amplifier". */
  title: string;
}

export function musicDirs(): string[] {
  const fromEnv = process.env.MUSIC_DIRS?.split(';').map((d) => d.trim()).filter(Boolean);
  if (fromEnv?.length) return fromEnv;
  const home = homedir();
  return ['Music', 'Desktop', 'Downloads', 'OneDrive\\Music', 'OneDrive\\Desktop', 'OneDrive\\Downloads'].map((d) => join(home, d));
}

/** "Imran Khan - Amplifier (Official Music Video) - imrankhanworld" -> "Imran Khan - Amplifier". */
export function cleanTitle(file: string): string {
  return basename(file, extname(file))
    .replace(/[([](official|lyrics?|audio|video|hd|4k|music video|full song)[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+[a-z0-9_.]+$/i, (m) => (/\s/.test(m.trim().slice(1).trim()) ? m : ''))  // trailing "- channelname"
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !['the', 'song', 'by', 'music', 'play', 'track'].includes(w));

export class MusicLibrary {
  private tracks: Track[] = [];
  private scannedAt = 0;

  private scan() {
    if (Date.now() - this.scannedAt < RESCAN_MS) return;
    const found: Track[] = [];
    const walk = (dir: string, depth: number) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name.startsWith('.') || name === 'node_modules') continue;
        const path = join(dir, name);
        let st;
        try {
          st = statSync(path);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (depth < MAX_DEPTH) walk(path, depth + 1);
        } else if (AUDIO.has(extname(name).toLowerCase())) {
          found.push({ path, title: cleanTitle(name) });
        }
      }
    };
    for (const d of musicDirs()) walk(d, 0);
    const seen = new Set<string>();
    this.tracks = found.filter((t) => (seen.has(t.path) ? false : (seen.add(t.path), true)));
    this.scannedAt = Date.now();
  }

  all(): Track[] {
    this.scan();
    return this.tracks;
  }

  /** Best match for a spoken request, or undefined. An empty query picks a random track. */
  find(query: string): Track | undefined {
    const tracks = this.all();
    if (!tracks.length) return undefined;
    const q = words(query);
    if (!q.length) return tracks[Math.floor(Math.random() * tracks.length)];
    let best: { t: Track; score: number } | undefined;
    for (const t of tracks) {
      const tw = new Set(words(t.title + ' ' + basename(t.path)));
      const hits = q.filter((w) => tw.has(w) || [...tw].some((x) => x.startsWith(w) || w.startsWith(x))).length;
      const score = hits / q.length;
      if (!best || score > best.score) best = { t, score };
    }
    return best && best.score >= 0.5 ? best.t : undefined;
  }
}

/**
 * Decode any audio file to the pod's format: raw PCM s16le, mono, 16 kHz.
 * gain: the pod boosts everything 4x for speech, and music is mastered loud, so it is turned down here.
 */
export function decodeForPod(path: string, gain: number, from?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', ...(from ? ['-ss', from] : []), '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-af', `volume=${gain}`, '-f', 's16le', '-'];
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    ff.stdout.on('data', (c: Buffer) => chunks.push(c));
    ff.stderr.on('data', (c: Buffer) => (err += c));
    ff.on('error', (e) => reject(new Error(`ffmpeg could not start: ${e.message}`)));
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg failed: ${err.trim().slice(0, 200)}`))));
  });
}
