import { afterEach, describe, expect, it } from 'vitest';
import { progressOf, rosterFor } from '../src/game/promotions.js';
import { createDashboard } from '../src/web/server.js';
import { fakeClient, IDS, profileStoreValue, SAMPLE_PROFILE, testServices } from './helpers/fixtures.js';
import { fakeGuild } from './helpers/guild.js';
import { json, type Call } from './helpers/mockFetch.js';

const ADMIN = '123456789012345678';
const ARMY = 409406376;
const ROLES = [
  { id: '1', displayName: 'Recruit', rank: 1 },
  { id: '2', displayName: 'Private', rank: 2 },
  { id: '3', displayName: 'Corporal', rank: 3 },
  { id: '9', displayName: 'Lieutenant', rank: 9 },
  { id: '255', displayName: 'Owner', rank: 255 },
];
const MEMBERSHIP = { path: `groups/${ARMY}/memberships/m99`, user: 'users/99', role: `groups/${ARMY}/roles/2` };

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((d) => d.close()));
});

async function start(over: { bannedUntil?: number } = {}) {
  const patches: Call[] = [];
  const { services } = testServices(
    [
      ['GET', `/cloud/v2/groups/${ARMY}/roles`, json({ groupRoles: ROLES })],
      [
        'GET',
        `/cloud/v2/groups/${ARMY}/memberships`,
        (url) => {
          const f = url.searchParams.get('filter') ?? '';
          return json({ groupMemberships: f.includes('roles/2') || f.includes('users/99') ? [MEMBERSHIP] : [] });
        },
      ],
      ['PATCH', `/cloud/v2/groups/${ARMY}/memberships/m99`, (_u, call) => (patches.push(call), json({}))],
      ['GET', 'groups.roblox.com/v2/users/99/groups/roles', json({ data: [{ group: { id: ARMY }, role: { id: 2, name: 'Private', rank: 2 } }] })],
      ['POST', 'users.roblox.com/v1/usernames/users', json({ data: [{ id: 99, name: 'Pte_Target', displayName: 'Target' }] })],
      ['POST', 'users.roblox.com/v1/users', json({ data: [{ id: 99, name: 'Pte_Target', displayName: 'Target' }] })],
      ['GET', 'users.roblox.com/v1/users/99', json({ id: 99, name: 'Pte_Target', displayName: 'Target', description: '' })],
      ['GET', 'thumbnails.roblox.com', json({ data: [{ targetId: 99, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/head.png' }] })],
      [
        'GET',
        'standard-datastores/datastore/entries/entry',
        (url) => {
          const key = url.searchParams.get('entryKey');
          if (key === 'u99') return json(profileStoreValue(SAMPLE_PROFILE));
          if (key === 'HK1941_AdminLog/recent') return json([{ t: 1_795_700_000, by: 'Sgt_Mod', text: ';kick Pte_Target spamming the radio' }]);
          if (key === 'HK1941_Staff/list') return json({});
          if (key === 'HK1941_Bans/u99' && over.bannedUntil !== undefined) return json({ untilT: over.bannedUntil, reason: 'Exploiting', by: 'Maj_X' });
          return json({ error: 'NOT_FOUND' }, 404);
        },
      ],
    ],
    { DISCORD_CLIENT_SECRET: 's', SESSION_SECRET: 'x'.repeat(40), DASHBOARD_ADMIN_IDS: ADMIN },
  );
  const fc = fakeClient();
  fc.client.guilds.cache.set(IDS.guild, fakeGuild().guild);
  const discord = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/oauth2/token')) return json({ access_token: 'tok', token_type: 'Bearer' });
    return json({ id: ADMIN, username: 'owner', global_name: 'The Owner', avatar: null });
  };
  const dash = createDashboard({ services, client: () => fc.client as never, fetch: discord as never, gameLogPollMs: 0, scanWaitMs: 5000 });
  open.push(dash);
  const base = `http://127.0.0.1:${await dash.listen(0, '127.0.0.1')}`;
  let cookie = '';
  const req = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), cookie } });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return res;
  };
  const go = await req('/auth/discord');
  await req(`/auth/discord/callback?code=x&state=${new URL(go.headers.get('location')!).searchParams.get('state')}`);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await req('/members')).text())?.[1] ?? '';
  const post = (path: string, body: Record<string, string>) =>
    req(path, { method: 'POST', body: new URLSearchParams({ _csrf: csrf, ...body }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  await services.adminLog.refresh();
  return { services, req, post, patches };
}

describe('promotions', () => {
  it('works out how far along someone is', () => {
    const next = { next: 'Corporal', nextRank: 3, points: 120, trainings: 4 };
    expect(progressOf({ points: 60, trainings: 4, next })).toBe(0.5);
    expect(progressOf({ points: 500, trainings: 1, next })).toBe(0.25);
    expect(progressOf({ points: 0, trainings: 0, next: null })).toBe(1);
  });

  it('queue: lists who is ready, with a link to review and promote', async () => {
    const { req } = await start();
    const text = await (await req('/promotions')).text();
    expect(text).toContain('Pte_Target');
    expect(text).toContain('Private → <b>Corporal</b>');
    expect(text).toContain('href="/members/99?promote=3"');
    expect(text).toContain('https://tr.rbxcdn.com/head.png');
  });

  it('progress: one rank, with bars toward the next', async () => {
    const { req } = await start();
    const text = await (await req('/promotions?tab=progress&rank=2')).text();
    expect(text).toContain('Private → Corporal');
    expect(text).toContain('<progress max="120" value="120">'); // capped at what's needed
    expect(text).toContain('Ready');
  });

  it('member page: rank, progress, medals, record and staff commands naming them', async () => {
    const { req } = await start({ bannedUntil: 0 });
    const text = await (await req('/members/99?promote=3')).text();
    expect(text).toContain('<h1>Pte_Target</h1>');
    expect(text).toContain('<b>Private</b> (rank 2)');
    expect(text).toContain('Promote <b>Pte_Target</b> from <b>Private</b> to <b>Corporal</b>?');
    expect(text).toContain('Military Cross');
    expect(text).toContain('Held the bridge');
    expect(text).toContain('Insubordination');
    expect(text).toContain(';kick Pte_Target spamming the radio');
    expect(text).toContain('Banned for good');
    expect(text).toContain('Good drill');
  });

  it('changes a rank from the member page, and records it', async () => {
    const { req, post, patches, services } = await start();
    const res = await post('/members/99', { action: 'rank', roleId: '3', expectRoleId: '2', reason: 'Met the requirements' });
    expect(res.headers.get('location')).toBe('/members/99');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ role: `groups/${ARMY}/roles/3` });
    const [h] = await services.promotionLog.list(99);
    expect(h).toMatchObject({ from: 'Private', to: 'Corporal', by: 'The Owner (dashboard)', reason: 'Met the requirements' });
    expect(rosterFor(services).cached(null)).toBeNull(); // the queue is checked again
    const history = await (await req('/promotions?tab=history')).text();
    expect(history).toContain('Private → <b>Corporal</b>');
    expect(history).toContain('Met the requirements');
  });

  it('refuses when their rank changed meanwhile, or the rank is the owner’s', async () => {
    const { req, post, patches } = await start();
    await post('/members/99', { action: 'rank', roleId: '3', expectRoleId: '1' });
    expect(await (await req('/members/99')).text()).toContain('Their rank changed in the meantime');
    await post('/members/99', { action: 'rank', roleId: '255', expectRoleId: '2' });
    expect(await (await req('/members/99')).text()).toContain('can’t be given out');
    expect(patches).toHaveLength(0);
  });

  it('finds a member by name', async () => {
    const { req } = await start();
    expect((await req('/members?q=Pte_Target')).headers.get('location')).toBe('/members/99');
  });
});
