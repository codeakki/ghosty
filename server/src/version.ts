import { readFileSync } from 'node:fs';

/** package.json version. Works from both src/ (tsx) and dist/ (node), which are one level below server/. */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
