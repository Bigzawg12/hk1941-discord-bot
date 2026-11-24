import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BloxlinkProvider } from '../src/linking/providers.js';
import { blurbHasCode, LinkService, makeCode } from '../src/linking/service.js';
import { JsonFileLinkStore, MemoryLinkStore } from '../src/linking/store.js';
import { RobloxHttp } from '../src/roblox/http.js';
import { UsersClient } from '../src/roblox/users.js';
import { UserFacingError } from '../src/util/errors.js';
import { json, mockFetch } from './helpers/mockFetch.js';

const DISCORD = '444444444444444444';

function setup(description: () => string, nowRef = { t: 1_800_000_000_000 }) {
  const { fetch } = mockFetch([['GET', 'users.roblox.com/v1/users/42', () => json({ id: 42, name: 'Maj_Test', displayName: 'Major', description: description() })]]);
  const users = new UsersClient(new RobloxHttp({ fetch, sleep: async () => undefined }));
  const store = new MemoryLinkStore();
  const svc = new LinkService({ store, users, codeTtlMinutes: 15, now: () => nowRef.t, makeCode: () => 'hk1941 jade lantern otter peak' });
  return { svc, store, nowRef };
}

const user = { id: 42, name: 'Maj_Test', displayName: 'Major' };

describe('profile-blurb linking', () => {
  it('makes word codes without digits beyond the prefix', () => {
    let i = 0;
    expect(makeCode(() => i++)).toBe('hk1941 anchor badger bamboo banner');
  });

  it('matches the code loosely (case and spacing)', () => {
    expect(blurbHasCode('Hi!\nHK1941  Jade lantern OTTER peak\nbye', 'hk1941 jade lantern otter peak')).toBe(true);
    expect(blurbHasCode('hk1941 jade lantern', 'hk1941 jade lantern otter peak')).toBe(false);
  });

  it('links once the code is in the About section', async () => {
    let about = 'nothing here';
    const { svc, store } = setup(() => about);
    const { code } = await svc.start(DISCORD, user);
    await expect(svc.verify(DISCORD, null)).rejects.toBeInstanceOf(UserFacingError);
    about = `Canada 1940s! ${code}`;
    const link = await svc.verify(DISCORD, null);
    expect(link).toMatchObject({ discordId: DISCORD, robloxId: 42, robloxName: 'Maj_Test', method: 'blurb' });
    expect(await store.get(DISCORD)).toMatchObject({ robloxId: 42 });
  });

  it('expires codes', async () => {
    const nowRef = { t: 1_800_000_000_000 };
    const { svc } = setup(() => 'hk1941 jade lantern otter peak', nowRef);
    await svc.start(DISCORD, user);
    nowRef.t += 16 * 60_000;
    await expect(svc.verify(DISCORD, null)).rejects.toThrow(/No link in progress/);
  });

  it('keeps one Discord account per Roblox account', async () => {
    const store = new MemoryLinkStore();
    await store.set({ discordId: 'a', robloxId: 1, robloxName: 'x', method: 'manual', linkedAt: 0 });
    await store.set({ discordId: 'b', robloxId: 1, robloxName: 'x', method: 'manual', linkedAt: 0 });
    expect(await store.get('a')).toBeNull();
    expect((await store.findByRoblox(1))?.discordId).toBe('b');
  });
});

describe('JsonFileLinkStore', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('persists links across restarts', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hk1941-links-'));
    const file = join(dir, 'sub', 'links.json');
    const a = new JsonFileLinkStore(file);
    await a.set({ discordId: DISCORD, robloxId: 42, robloxName: 'Maj_Test', method: 'blurb', linkedAt: 1 });
    expect(JSON.parse(await readFile(file, 'utf8')).links).toHaveLength(1);
    const b = new JsonFileLinkStore(file);
    expect((await b.get(DISCORD))?.robloxName).toBe('Maj_Test');
    expect(await b.remove(DISCORD)).toBe(true);
    expect(await new JsonFileLinkStore(file).all()).toEqual([]);
  });
});

describe('external providers', () => {
  it('Bloxlink: looks up the member and links without a code', async () => {
    const { fetch, calls } = mockFetch([
      ['GET', 'api.blox.link/v4/public/guilds/222/discord-to-roblox/444444444444444444', json({ robloxID: '42' })],
      ['GET', 'users.roblox.com/v1/users/42', json({ id: 42, name: 'Maj_Test', displayName: 'Major' })],
    ]);
    const web = new RobloxHttp({ fetch, sleep: async () => undefined });
    const svc = new LinkService({ store: new MemoryLinkStore(), users: new UsersClient(web), provider: new BloxlinkProvider(web, 'test-bloxlink-key'), codeTtlMinutes: 15 });
    expect(svc.mode).toBe('bloxlink');
    await expect(svc.start(DISCORD, user)).rejects.toThrow(/Bloxlink/);
    expect(await svc.verify(DISCORD, '222')).toMatchObject({ robloxId: 42, method: 'bloxlink' });
    expect(calls[0]!.headers.authorization).toBe('test-bloxlink-key');
    expect(calls[0]!.headers['x-api-key']).toBeUndefined();
  });
});
