import { vi } from 'vitest';
import type { FetchLike } from '../../src/roblox/http.js';

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export type Reply = Response | { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
export type Handler = (url: URL, call: Call) => Reply | Promise<Reply>;
export type Route = [method: string, match: string | RegExp, handler: Handler | Reply];

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function toResponse(r: Reply): Response {
  if (r instanceof Response) return r;
  if (r.text !== undefined) return new Response(r.text, { status: r.status ?? 200, headers: r.headers });
  return json(r.json ?? null, r.status ?? 200, r.headers);
}

/**
 * A strict fake fetch: every request must match a route (method + URL substring or regex, matched
 * against the URL without its query string), otherwise the test fails. Nothing reaches the network.
 */
export function mockFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = { method, url: input, headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const url = new URL(input);
    const bare = url.origin + url.pathname;
    for (const [m, match, handler] of routes) {
      if (m !== method) continue;
      const hit = typeof match === 'string' ? bare.includes(match) : match.test(bare);
      if (!hit) continue;
      const reply = typeof handler === 'function' ? await handler(url, call) : handler;
      return toResponse(reply);
    }
    throw new Error(`Unexpected request in test: ${method} ${input}`);
  });
  return { fetch: fetch as unknown as FetchLike & typeof fetch, calls };
}
