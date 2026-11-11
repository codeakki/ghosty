import type Anthropic from '@anthropic-ai/sdk';
import type { MusicLibrary, Track } from './music.js';
import { describeDue, type Reminders } from './reminders.js';
import { loadJson, saveJson } from './store.js';

/**
 * Ghosty's own tools (run on this PC): music, reminders, notes, volume.
 * Web search and web fetch are Anthropic server tools, declared in brain.ts.
 */

export interface Note {
  text: string;
  at: number;
}

export class Notes {
  private list: Note[] = loadJson<Note[]>('notes.json', []);
  all() {
    return [...this.list];
  }
  add(text: string) {
    this.list.push({ text, at: Date.now() });
    saveJson('notes.json', this.list);
  }
  /** Remove notes containing all the given words. */
  forget(text: string): Note[] {
    const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    if (!words.length) return [];
    const hit = (n: Note) => words.every((w) => n.text.toLowerCase().includes(w));
    const gone = this.list.filter(hit);
    this.list = this.list.filter((n) => !hit(n));
    saveJson('notes.json', this.list);
    return gone;
  }
}

export interface Settings {
  /** 0-100, applied to everything the pod plays. */
  volume: number;
}

export class SettingsStore {
  private s: Settings = { volume: 100, ...loadJson<Partial<Settings>>('settings.json', {}) };
  get(): Settings {
    return { ...this.s };
  }
  set(patch: Partial<Settings>) {
    this.s = { ...this.s, ...patch };
    saveJson('settings.json', this.s);
  }
}

/** What the tools need from the server: the pod's play queue. */
export interface Player {
  queueTrack(track: Track): Promise<{ seconds: number; position: number }>;
  /** Clear the queue and stop the current song. */
  stop(): { cleared: number; stoppedCurrent: string | null };
  status(): { playing: string | null; queued: string[] };
}

export interface ToolDeps {
  music: MusicLibrary;
  player: Player;
  reminders: Reminders;
  notes: Notes;
  settings: SettingsStore;
}

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false,
});

export const TOOL_DEFS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'play_music',
    description:
      "Play a song from the user's music files on this PC through the pod. Use for any request to play a song, artist or music. The song starts right after your spoken reply. query: song title and/or artist as the user said it; empty string for any song.",
    input_schema: obj({ query: { type: 'string' } }, ['query']),
    strict: true,
  },
  {
    name: 'list_music',
    description: "Find which songs are in the user's music files. query: words to match, or empty string to list some of everything.",
    input_schema: obj({ query: { type: 'string' } }, ['query']),
    strict: true,
  },
  {
    name: 'stop_music',
    description: 'Stop the song that is playing and clear every song waiting in the queue.',
    input_schema: obj({}, []),
    strict: true,
  },
  {
    name: 'set_reminder',
    description:
      'Set a reminder or timer. At the due time the pod chimes and says the text. delay_seconds: seconds from now until it is due; work it out from the current time given in the message (for "at 7 pm", the seconds until 7 pm). text: what to remind, phrased to be spoken, e.g. "call mom" or "your five minute timer is done".',
    input_schema: obj({ text: { type: 'string' }, delay_seconds: { type: 'integer' } }, ['text', 'delay_seconds']),
    strict: true,
  },
  {
    name: 'list_reminders',
    description: 'List upcoming reminders and timers with their ids and due times.',
    input_schema: obj({}, []),
    strict: true,
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel reminders. Give the id from list_reminders, or 0 and words from its text.',
    input_schema: obj({ id: { type: 'integer' }, text: { type: 'string' } }, ['id', 'text']),
    strict: true,
  },
  {
    name: 'remember',
    description: 'Save a note the user wants you to remember for later (facts, preferences, where things are). Notes are shown to you in every later message.',
    input_schema: obj({ note: { type: 'string' } }, ['note']),
    strict: true,
  },
  {
    name: 'forget',
    description: 'Delete saved notes that contain all the given words.',
    input_schema: obj({ text: { type: 'string' } }, ['text']),
    strict: true,
  },
  {
    name: 'set_volume',
    description: 'Set the pod volume for replies and music, 0 to 100. For "louder" or "quieter", change the current volume (given in the message) by about 20.',
    input_schema: obj({ percent: { type: 'integer' } }, ['percent']),
    strict: true,
  },
];

export interface ToolResult {
  content: string;
  is_error?: boolean;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN);

export async function runTool(name: string, input: Record<string, unknown>, d: ToolDeps): Promise<ToolResult> {
  switch (name) {
    case 'play_music': {
      const tracks = d.music.all();
      if (!tracks.length) return { content: 'No music files found on this PC. The user can put songs in their Music, Desktop or Downloads folder.' };
      const track = d.music.find(str(input.query));
      if (!track) {
        const some = tracks.slice(0, 8).map((t) => t.title);
        return { content: `No song matches "${str(input.query)}". Some songs that are there: ${some.join('; ')}.` };
      }
      const q = await d.player.queueTrack(track);
      const len = `${Math.floor(q.seconds / 60)} min ${q.seconds % 60} s`;
      return { content: `Queued "${track.title}" (${len}), position ${q.position}. It starts right after your reply.` };
    }
    case 'list_music': {
      const tracks = d.music.all();
      const q = str(input.query).toLowerCase();
      const hits = q ? tracks.filter((t) => t.title.toLowerCase().includes(q)) : tracks;
      if (!hits.length) return { content: tracks.length ? `No songs match "${q}". ${tracks.length} songs in total.` : 'No music files found on this PC.' };
      return { content: `${hits.length} song(s): ${hits.slice(0, 15).map((t) => t.title).join('; ')}${hits.length > 15 ? '; and more' : ''}.` };
    }
    case 'stop_music': {
      const s = d.player.stop();
      return { content: s.stoppedCurrent || s.cleared ? `Stopped${s.stoppedCurrent ? ` "${s.stoppedCurrent}"` : ''}, cleared ${s.cleared} queued.` : 'Nothing was playing or queued.' };
    }
    case 'set_reminder': {
      const delay = int(input.delay_seconds);
      const text = str(input.text).trim();
      if (!text || !(delay > 0)) return { content: 'Need reminder text and a delay above zero seconds.', is_error: true };
      if (delay > 366 * 24 * 3600) return { content: 'That is more than a year away; ask for a closer time.', is_error: true };
      const r = d.reminders.add(text, delay);
      return { content: `Reminder ${r.id} set: "${r.text}", due ${describeDue(r.due)}.` };
    }
    case 'list_reminders': {
      const list = d.reminders.upcoming();
      if (!list.length) return { content: 'No upcoming reminders.' };
      return { content: list.map((r) => `id ${r.id}: "${r.text}", ${describeDue(r.due)}`).join('\n') };
    }
    case 'cancel_reminder': {
      const gone = d.reminders.cancel({ id: int(input.id), text: str(input.text) });
      return { content: gone.length ? `Cancelled: ${gone.map((r) => `"${r.text}"`).join(', ')}.` : 'No reminder matched; nothing cancelled.' };
    }
    case 'remember': {
      const note = str(input.note).trim();
      if (!note) return { content: 'Empty note.', is_error: true };
      d.notes.add(note);
      return { content: `Saved: "${note}".` };
    }
    case 'forget': {
      const gone = d.notes.forget(str(input.text));
      return { content: gone.length ? `Deleted ${gone.length} note(s): ${gone.map((n) => `"${n.text}"`).join(', ')}.` : 'No note matched.' };
    }
    case 'set_volume': {
      const p = Math.max(0, Math.min(100, int(input.percent)));
      if (Number.isNaN(p)) return { content: 'percent must be a number from 0 to 100.', is_error: true };
      d.settings.set({ volume: p });
      return { content: `Volume is now ${p} percent.` };
    }
    default:
      return { content: `Unknown tool ${name}.`, is_error: true };
  }
}

/** Live state for the user message: volume, notes, what is playing. Not in the system prompt (keeps its cache). */
export function contextLine(d: ToolDeps): string {
  const s = d.player.status();
  const notes = d.notes.all();
  return [
    `Pod volume: ${d.settings.get().volume} percent.`,
    s.playing ? `Now playing: "${s.playing}".` : '',
    s.queued.length ? `Queued: ${s.queued.join('; ')}.` : '',
    notes.length ? `Things the user asked you to remember: ${notes.map((n, i) => `${i + 1}. ${n.text}`).join(' ')}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
