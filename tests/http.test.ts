import { describe, expect, it } from 'vitest';
import { RobloxHttp } from '../src/roblox/http.js';
import { RobloxApiError } from '../src/util/errors.js';
import { json, mockFetch } from './helpers/mockFetch.js';

const KEY = 'test-open-cloud-key';
const noSleep = async () => undefined;

describe('RobloxHttp', () => {
  it('sends the key only when asked, and only to apis.roblox.com', async () => {
    const { fetch, calls } = mockFetch([
      ['GET', 'apis.roblox.com', json({ ok: 1 })],
      ['GET', 'users.roblox.com', json({ ok: 2 })],
    ]);
    const http = new RobloxHttp({ apiKey: KEY, fetch, sleep: noSleep });
    await http.get('https://apis.roblox.com/x', { auth: true });
    await http.get('https://users.roblox.com/v1/users/1');
    expect(calls[0]!.headers['x-api-key']).toBe(KEY);
    expect(calls[1]!.headers['x-api-key']).toBeUndefined();
    await expect(http.get('https://evil.example.com/x', { auth: true })).rejects.toThrow(/Refusing to send the Open Cloud key/);
  });

  it('retries 429 and 5xx, honouring Retry-After', async () => {
    let n = 0;
    const waits: number[] = [];
    const { fetch } = mockFetch([
      ['GET', 'apis.roblox.com', () => (++n < 3 ? json({ error: 'slow down' }, n === 1 ? 429 : 503, { 'retry-after': '2' }) : json({ done: true }))],
    ]);
    const http = new RobloxHttp({ apiKey: KEY, fetch, sleep: async (ms) => void waits.push(ms) });
    const res = await http.get<{ done: boolean }>('https://apis.roblox.com/x', { auth: true });
    expect(res.data.done).toBe(true);
    expect(waits).toEqual([2000, 2000]);
  });

  it('returns null on 404 when allowed', async () => {
    const { fetch } = mockFetch([['GET', 'apis.roblox.com', json({ error: 'NOT_FOUND' }, 404)]]);
    const http = new RobloxHttp({ apiKey: KEY, fetch, sleep: noSleep });
    expect(await http.get('https://apis.roblox.com/x', { auth: true, allowNotFound: true })).toBeNull();
  });

  it('throws a RobloxApiError that never contains the key', async () => {
    const { fetch } = mockFetch([['GET', 'apis.roblox.com', json({ message: 'Invalid API Key' }, 401)]]);
    const http = new RobloxHttp({ apiKey: KEY, fetch, sleep: noSleep });
    const err = (await http.get('https://apis.roblox.com/x?entryKey=u1', { auth: true }).catch((e: unknown) => e)) as RobloxApiError;
    expect(err).toBeInstanceOf(RobloxApiError);
    expect(err.status).toBe(401);
    expect(err.describe()).toMatch(/refused/);
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain(KEY);
    expect(err.url).not.toContain('entryKey'); // query strings are dropped from errors
  });

  it('fails clearly when no key is configured', async () => {
    const { fetch } = mockFetch([]);
    const http = new RobloxHttp({ fetch, sleep: noSleep });
    await expect(http.get('https://apis.roblox.com/x', { auth: true })).rejects.toThrow(/No Open Cloud key/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
