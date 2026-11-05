/** Small fetch helpers shared by the news providers. No dependencies beyond global fetch. */

export const USER_AGENT = 'ghosty/0.1 (+https://github.com/codeakki/ghosty)';
export const DEFAULT_TIMEOUT_MS = 8_000;

export type FetchLike = typeof fetch;

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  init?: RequestInit;
}

async function request(url: string, opts: RequestOptions): Promise<Response> {
  const fetchImpl = opts.fetch ?? fetch;
  const init = opts.init ?? {};
  const res = await fetchImpl(url, {
    ...init,
    headers: { 'user-agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
    signal: init.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new HttpError(`${init.method ?? 'GET'} ${redact(url)} -> ${res.status} ${detail}`, res.status);
  }
  return res;
}

export async function fetchText(url: string, opts: RequestOptions = {}): Promise<string> {
  return (await request(url, opts)).text();
}

export async function fetchJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  return (await (await request(url, opts)).json()) as T;
}

/** Hide secrets passed as query params (CryptoPanic auth_token) in error messages and logs. */
export function redact(url: string): string {
  return url.replace(/(auth_token|api_key|token)=[^&]+/gi, '$1=***');
}

/** Hostname without "www.", lowercased. undefined for unparseable urls. */
export function domainOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** Run a promise with a deadline; rejects with a TimeoutError-like message after `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Split "a, b ,c" into trimmed non-empty parts. */
export function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
