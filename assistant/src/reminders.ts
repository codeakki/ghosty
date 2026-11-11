import { loadJson, saveJson } from './store.js';

/** Reminders and timers. Saved to data/reminders.json, so a server restart keeps them. */

export interface Reminder {
  id: number;
  text: string;
  /** When it fires, ms since epoch. */
  due: number;
  created: number;
}

const FILE = 'reminders.json';
/** A reminder that came due while the server was off is still spoken, if it is not older than this. */
const LATE_LIMIT_MS = 12 * 60 * 60_000;

export class Reminders {
  private list: Reminder[] = loadJson<Reminder[]>(FILE, []);
  private nextId = Math.max(0, ...this.list.map((r) => r.id)) + 1;
  private timer?: NodeJS.Timeout;

  /** fire() is called once per due reminder; it should queue the spoken reminder for the pod. */
  start(fire: (r: Reminder, lateMs: number) => void) {
    const tick = () => {
      const now = Date.now();
      const due = this.list.filter((r) => r.due <= now);
      if (!due.length) return;
      this.list = this.list.filter((r) => r.due > now);
      this.save();
      for (const r of due) if (now - r.due < LATE_LIMIT_MS) fire(r, now - r.due);
    };
    tick();
    this.timer = setInterval(tick, 1000);
    this.timer.unref();
  }

  add(text: string, delaySeconds: number): Reminder {
    const r: Reminder = { id: this.nextId++, text, due: Date.now() + Math.max(1, delaySeconds) * 1000, created: Date.now() };
    this.list.push(r);
    this.list.sort((a, b) => a.due - b.due);
    this.save();
    return r;
  }

  upcoming(): Reminder[] {
    return [...this.list];
  }

  /** Cancel by id, or by words in the text. Returns what was cancelled. */
  cancel(match: { id?: number; text?: string }): Reminder[] {
    const words = (match.text ?? '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const hit = (r: Reminder) =>
      match.id !== undefined && match.id > 0 ? r.id === match.id : words.length > 0 && words.every((w) => r.text.toLowerCase().includes(w));
    const gone = this.list.filter(hit);
    this.list = this.list.filter((r) => !hit(r));
    this.save();
    return gone;
  }

  private save() {
    saveJson(FILE, this.list);
  }
}

/** "in 5 minutes", "at 7:00 pm today" style, for Claude to read back. */
export function describeDue(due: number): string {
  const d = new Date(due);
  const mins = Math.round((due - Date.now()) / 60_000);
  const clock = d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
  const day = d.toDateString() === new Date().toDateString() ? 'today' : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return mins < 60 ? `in ${Math.max(0, mins)} minute(s), at ${clock}` : `${day} at ${clock}`;
}
