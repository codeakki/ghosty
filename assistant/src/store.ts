import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Small JSON files in assistant/data/ (gitignored): reminders, notes, settings. Survive restarts. */
export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export function loadJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write via a temp file and rename, so a crash mid-write never leaves half a file. */
export function saveJson(name: string, value: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, name);
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${file}.tmp`, file);
}
