import { describe, expect, it } from 'vitest';
import { GroupsClient } from '../src/roblox/groups.js';
import { RobloxHttp } from '../src/roblox/http.js';
import { SortedMapReader } from '../src/roblox/memoryStore.js';
import { ServerDirectory } from '../src/roblox/servers.js';
import { UsersClient } from '../src/roblox/users.js';
import { json, mockFetch, type Route } from './helpers/mockFetch.js';

const ARMY = 409406376;
const UNIVERSE = 10772680614;

function http(routes: Route[]) {
  const { fetch, calls } = mockFetch(routes);
  return { http: new RobloxHttp({ apiKey: 'test-open-cloud-key', fetch, sleep: async () => undefined }), calls };
}

describe('GroupsClient', () => {
  it('reads a rank from the public groups API, without the key', async () => {
    const { http: h, calls } = http([
      ['GET', 'groups.roblox.com/v2/users/42/groups/roles', json({ data: [{ group: { id: ARMY }, role: { id: 7, name: 'Sergeant', rank: 5 } }] })],
    ]);
    const g = new GroupsClient(h);
    expect(await g.rankIn(ARMY, 42)).toEqual({ groupId: ARMY, rank: 5, roleId: 7, roleName: 'Sergeant' });
    expect(await g.rankIn(668236881, 42)).toMatchObject({ rank: 0, roleName: 'Guest' });
    expect(calls).toHaveLength(1); // cached
    expect(calls[0]!.headers['x-api-key']).toBeUndefined();
  });

  it('lists roles across pages, lowest rank first', async () => {
    const { http: h } = http([
      [
        'GET',
        `/cloud/v2/groups/${ARMY}/roles`,
        (url) =>
          url.searchParams.get('pageToken')
            ? json({ groupRoles: [{ id: '30', displayName: 'Lieutenant', rank: 9 }] })
            : json({ groupRoles: [{ id: '20', displayName: 'Corporal', rank: 3 }, { path: `groups/${ARMY}/roles/10`, displayName: 'Private', rank: 2 }], nextPageToken: 'p2' }),
      ],
    ]);
    const roles = await new GroupsClient(h).listRoles(ARMY);
    expect(roles.map((r) => [r.id, r.rank])).toEqual([
      [10, 2],
      [20, 3],
      [30, 9],
    ]);
  });

  it('changes a role by patching the membership found for the user', async () => {
    const { http: h, calls } = http([
      ['GET', `/cloud/v2/groups/${ARMY}/memberships`, json({ groupMemberships: [{ path: `groups/${ARMY}/memberships/abc`, user: 'users/42', role: `groups/${ARMY}/roles/10` }] })],
      ['PATCH', `/cloud/v2/groups/${ARMY}/memberships/abc`, json({})],
    ]);
    await new GroupsClient(h).setRole(ARMY, 42, 20);
    expect(new URL(calls[0]!.url).searchParams.get('filter')).toBe("user == 'users/42'");
    expect(calls[1]).toMatchObject({ method: 'PATCH', body: { role: `groups/${ARMY}/roles/20` } });
    expect(calls[1]!.headers['x-api-key']).toBe('test-open-cloud-key');
  });

  it('lists members holding a role', async () => {
    const { http: h, calls } = http([
      ['GET', `/cloud/v2/groups/${ARMY}/memberships`, json({ groupMemberships: [{ user: 'users/1' }, { user: 'users/2' }] })],
    ]);
    expect(await new GroupsClient(h).membersWithRole(ARMY, 20)).toEqual([1, 2]);
    expect(new URL(calls[0]!.url).searchParams.get('filter')).toBe(`role == 'groups/${ARMY}/roles/20'`);
  });
});

describe('UsersClient', () => {
  const routes: Route[] = [
    ['POST', 'users.roblox.com/v1/usernames/users', json({ data: [{ id: 42, name: 'Maj_Test', displayName: 'Major' }] })],
    ['GET', 'users.roblox.com/v1/users/42', json({ id: 42, name: 'Maj_Test', displayName: 'Major', description: 'hello' })],
    ['GET', 'users.roblox.com/v1/users/404', json({ errors: [] }, 404)],
    ['GET', 'thumbnails.roblox.com', json({ errors: [] }, 500)],
  ];

  it('resolves usernames, @names, ids and profile links', async () => {
    const { http: h, calls } = http(routes);
    const u = new UsersClient(h);
    expect((await u.resolve('Maj_Test'))?.id).toBe(42);
    expect(calls[0]!.body).toEqual({ usernames: ['Maj_Test'], excludeBannedUsers: false });
    expect((await u.resolve('@maj_test'))?.id).toBe(42);
    expect((await u.resolve('42'))?.description).toBe('hello');
    expect((await u.resolve('https://www.roblox.com/users/42/profile'))?.name).toBe('Maj_Test');
    expect(await u.resolve('404')).toBeNull();
    expect(await u.resolve('not a name!')).toBeNull();
  });

  it('never fails a command over a missing picture', async () => {
    const { http: h } = http(routes);
    expect(await new UsersClient(h).headshotUrl(42)).toBeNull();
  });
});

describe('SortedMapReader and ServerDirectory', () => {
  const MAP = `/cloud/v2/universes/${UNIVERSE}/memory-store/sorted-maps/HK1941_Servers/items`;
  const now = 1_800_000_000_000;

  it('uses the bridge heartbeats, dropping stale ones', async () => {
    const { http: h } = http([
      [
        'GET',
        MAP,
        json({
          memoryStoreSortedMapItems: [
            { id: 'srv_a', value: JSON.stringify({ job: 'aaaa-1111', n: 12, max: 40, names: ['A', 'B'], up: 3700, t: now / 1000 - 10 }) },
            { id: 'srv_b', value: { job: 'bbbb-2222', n: 30, t: now / 1000 - 20, cap: 'A Hill: CDN' } },
            { id: 'srv_c', value: JSON.stringify({ job: 'cccc-3333', n: 5, t: now / 1000 - 600 }) },
          ],
        }),
      ],
    ]);
    const dir = new ServerDirectory({ http: h, sortedMaps: new SortedMapReader(h, UNIVERSE), serverMap: 'HK1941_Servers', placeId: 1, now: () => now });
    const list = await dir.list();
    expect(list.source).toBe('bridge');
    expect(list.servers.map((s) => [s.jobId, s.players])).toEqual([
      ['bbbb-2222', 30],
      ['aaaa-1111', 12],
    ]);
    expect(list.servers[0]!.capture).toBe('A Hill: CDN');
  });

  it('falls back to the public server list', async () => {
    const { http: h } = http([
      ['GET', MAP, json({ memoryStoreSortedMapItems: [] })],
      ['GET', 'games.roblox.com/v1/games/77901932829123/servers/Public', json({ data: [{ id: 'pub-1', playing: 8, maxPlayers: 40 }], nextPageCursor: null })],
    ]);
    const dir = new ServerDirectory({ http: h, sortedMaps: new SortedMapReader(h, UNIVERSE), serverMap: 'HK1941_Servers', placeId: 77901932829123, now: () => now });
    expect(await dir.list()).toMatchObject({ source: 'public', servers: [{ jobId: 'pub-1', players: 8 }] });
  });
});
