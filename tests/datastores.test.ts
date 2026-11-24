import { describe, expect, it } from 'vitest';
import { normalizeProfile, unwrapProfileStore } from '../src/game/profile.js';
import { DataStoreReader } from '../src/roblox/datastores.js';
import { GlobalData, isBanActive, pruneEvents } from '../src/roblox/globalData.js';
import { RobloxHttp } from '../src/roblox/http.js';
import { ProfileReader } from '../src/roblox/profiles.js';
import { profileStoreValue, SAMPLE_PROFILE } from './helpers/fixtures.js';
import { json, mockFetch, type Route } from './helpers/mockFetch.js';

const UNIVERSE = 10772680614;
const ENTRY = `apis.roblox.com/datastores/v1/universes/${UNIVERSE}/standard-datastores/datastore/entries/entry`;

/** Answers DataStore reads from a fake store: { "<datastore>|<key>": value } */
function dataStoreRoute(store: Record<string, unknown>): Route {
  return [
    'GET',
    ENTRY,
    (url) => {
      const k = `${url.searchParams.get('datastoreName')}|${url.searchParams.get('entryKey')}`;
      if (!(k in store)) return json({ error: 'NOT_FOUND', message: 'Entry not found in the datastore.' }, 404);
      return json(store[k], 200, { 'roblox-entry-version': '08DD-1', 'roblox-entry-version-created-time': '2026-11-24T10:00:00Z' });
    },
  ];
}

function reader(store: Record<string, unknown>) {
  const { fetch, calls } = mockFetch([dataStoreRoute(store)]);
  const ds = new DataStoreReader(new RobloxHttp({ apiKey: 'test-open-cloud-key', fetch, sleep: async () => undefined }), UNIVERSE);
  return { ds, calls };
}

describe('DataStoreReader', () => {
  it('reads one entry with the key as a query parameter (slashes kept)', async () => {
    const { ds, calls } = reader({ 'HK1941_Global|HK1941_MP/log': [{ who: 'A' }] });
    const e = await ds.getEntry('HK1941_Global', 'HK1941_MP/log');
    expect(e?.value).toEqual([{ who: 'A' }]);
    expect(e?.version).toBe('08DD-1');
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('entryKey')).toBe('HK1941_MP/log');
    expect(url.searchParams.get('scope')).toBe('global');
    expect(calls[0]!.method).toBe('GET');
  });

  it('returns null for a missing key', async () => {
    const { ds } = reader({});
    expect(await ds.getEntry('HK1941_Global', 'nope')).toBeNull();
  });

  it('has no way to write', () => {
    const { ds } = reader({});
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(ds));
    expect(methods.filter((m) => /set|update|remove|delete|increment|write/i.test(m))).toEqual([]);
  });
});

describe('profiles', () => {
  it('unwraps the ProfileStore record (.Data) from HK1941_Profiles u<userId>', async () => {
    const { ds, calls } = reader({ 'HK1941_Profiles|u42': profileStoreValue(SAMPLE_PROFILE, [77901932829123, 'job-abc-123', 'uid']) });
    const p = await new ProfileReader(ds, 'HK1941_Profiles').get(42);
    expect(p?.data.training.attended).toBe(5);
    expect(p?.data.medals.a.MC?.c).toBe('Held the bridge');
    expect(p?.activeSession).toEqual({ placeId: 77901932829123, jobId: 'job-abc-123' });
    expect(new URL(calls[0]!.url).searchParams.get('entryKey')).toBe('u42');
  });

  it('returns null for someone who never played', async () => {
    const { ds } = reader({});
    expect(await new ProfileReader(ds, 'HK1941_Profiles').get(1)).toBeNull();
  });

  it('caches reads for a short while', async () => {
    const { ds, calls } = reader({ 'HK1941_Profiles|u42': profileStoreValue(SAMPLE_PROFILE) });
    const pr = new ProfileReader(ds, 'HK1941_Profiles');
    await pr.get(42);
    await pr.get(42);
    expect(calls).toHaveLength(1);
    await pr.get(42, { fresh: true });
    expect(calls).toHaveLength(2);
  });

  it('refuses a value that is not a ProfileStore record', () => {
    expect(() => unwrapProfileStore({ training: {} }, 1)).toThrow(/ProfileStore/);
  });

  it('fills template defaults like Reconcile()', () => {
    const p = normalizeProfile({ service: { kills: 3 }, medals: { wear: false } });
    expect(p.service.kills).toBe(3);
    expect(p.service.deaths).toBe(0);
    expect(p.training.history).toEqual([]);
    expect(p.mp.arrests).toEqual([]);
    expect(p.medals).toEqual({ a: {}, q: {}, wear: false });
  });
});

describe('GlobalData', () => {
  it('reads "<area>/<key>" from HK1941_Global', async () => {
    const { ds } = reader({ 'HK1941_Global|HK1941_MP/log': [{ who: 'Pte_A', minutes: 5 }] });
    const g = new GlobalData(ds, 'HK1941_Global');
    expect(await g.arrestLog()).toEqual([{ who: 'Pte_A', minutes: 5 }]);
  });

  it('falls back to the old per-system store for keys the game has not migrated yet', async () => {
    const { ds, calls } = reader({ 'HK1941_Bans|u9': { untilT: 0, reason: 'cheating', by: 'Admin' } });
    const g = new GlobalData(ds, 'HK1941_Global');
    expect(await g.ban(9)).toMatchObject({ untilT: 0, reason: 'cheating' });
    expect(calls.map((c) => new URL(c.url).searchParams.get('datastoreName'))).toEqual(['HK1941_Global', 'HK1941_Bans']);
  });

  it('prunes events like HKAdmin (3 hours after the start) and sorts them', async () => {
    const now = 1_800_000_000;
    const list = [
      { id: '2', title: 'Later', detail: '', start: now + 7200, host: 'B' },
      { id: '1', title: 'Old', detail: '', start: now - 4 * 3600, host: 'A' },
      { id: '3', title: 'Running', detail: '', start: now - 3600, host: 'C' },
    ];
    expect(pruneEvents(list, now).map((e) => e.id)).toEqual(['3', '2']);
    const { ds } = reader({ 'HK1941_Global|HK1941_Events/list': list });
    expect((await new GlobalData(ds, 'HK1941_Global', () => now).events()).map((e) => e.id)).toEqual(['3', '2']);
  });

  it('knows when a ban is active', () => {
    expect(isBanActive(null, 100)).toBe(false);
    expect(isBanActive({ untilT: 0 }, 100)).toBe(true);
    expect(isBanActive({ untilT: 50 }, 100)).toBe(false);
    expect(isBanActive({ untilT: 150 }, 100)).toBe(true);
  });
});
