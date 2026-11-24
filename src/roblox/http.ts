import type { Logger } from '../logger.js';
import { RobloxApiError } from '../util/errors.js';
import { sleep as realSleep } from '../util/cache.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RobloxHttpOptions {
  /** Open Cloud API key. Sent only as the x-api-key header to apis.roblox.com, never logged. */
  apiKey?: string;
  fetch?: FetchLike;
  logger?: Logger;
  maxRetries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Send the Open Cloud key. Public web APIs (users, groups, thumbnails) don't need it. */
  auth?: boolean;
  /** Return null instead of throwing on 404. */
  allowNotFound?: boolean;
  headers?: Record<string, string>;
}

export interface HttpResult<T> {
  status: number;
  data: T;
  headers: Headers;
}

export const OPEN_CLOUD = 'https://apis.roblox.com';

/**
 * Thin fetch wrapper for Roblox APIs: JSON in and out, retries on 429 / 5xx with backoff
 * (honouring Retry-After), a timeout per attempt, and errors that never contain the key.
 */
export class RobloxHttp {
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: RobloxHttpOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.sleep = opts.sleep ?? realSleep;
  }

  get hasKey(): boolean {
    return Boolean(this.opts.apiKey);
  }

  async get<T>(url: string, options: RequestOptions & { allowNotFound: true }): Promise<HttpResult<T> | null>;
  async get<T>(url: string, options?: RequestOptions): Promise<HttpResult<T>>;
  async get<T>(url: string, options: RequestOptions = {}): Promise<HttpResult<T> | null> {
    return this.request<T>('GET', url, options);
  }

  async post<T>(url: string, options: RequestOptions = {}): Promise<HttpResult<T>> {
    return (await this.request<T>('POST', url, options))!;
  }

  async patch<T>(url: string, options: RequestOptions = {}): Promise<HttpResult<T>> {
    return (await this.request<T>('PATCH', url, options))!;
  }

  async request<T>(method: string, url: string, options: RequestOptions = {}): Promise<HttpResult<T> | null> {
    const full = withQuery(url, options.query);
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.auth) {
      if (!this.opts.apiKey) throw new RobloxApiError('No Open Cloud key configured (HK_OPEN_CLOUD_KEY).', 401, redactUrl(full));
      if (!full.startsWith(OPEN_CLOUD + '/')) throw new Error(`Refusing to send the Open Cloud key to ${redactUrl(full)}`);
      headers['x-api-key'] = this.opts.apiKey;
    }

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(full, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new RobloxApiError(`Network error calling ${method} ${redactUrl(full)}: ${(err as Error).message}`, 0, redactUrl(full));
      }

      if (res.status === 404 && options.allowNotFound) return null;

      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const wait = retryAfterMs(res.headers) ?? this.backoff(attempt);
        this.opts.logger?.debug({ status: res.status, url: redactUrl(full), wait }, 'roblox api retry');
        await this.sleep(wait);
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        throw new RobloxApiError(
          `${method} ${redactUrl(full)} failed with ${res.status}`,
          res.status,
          redactUrl(full),
          text.slice(0, 500),
        );
      }
      return { status: res.status, data: parseBody(text) as T, headers: res.headers };
    }
  }

  private backoff(attempt: number): number {
    return this.baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 100);
  }
}

function parseBody(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function retryAfterMs(h: Headers): number | null {
  const ra = h.get('retry-after');
  if (ra && /^\d+(\.\d+)?$/.test(ra)) return Math.min(Number(ra) * 1000, 30_000);
  const reset = h.get('x-ratelimit-reset');
  if (reset && /^\d+(\.\d+)?$/.test(reset)) return Math.min(Number(reset) * 1000, 30_000);
  return null;
}

export function withQuery(url: string, query?: Record<string, string | number | undefined>): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}

/** URLs never contain the key, but strip query strings from logs anyway (they can hold usernames). */
function redactUrl(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i) + '?…';
}
