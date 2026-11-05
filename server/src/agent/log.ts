/** Minimal pino-compatible logger so Fastify's `app.log` can be passed straight in. */
export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const noopLogger: Logger = { info() {}, warn() {}, error() {} };

/** One JSON line per event on stdout/stderr. Used when no logger is injected. */
export const consoleLogger: Logger = {
  info: (obj, msg) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
  warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
