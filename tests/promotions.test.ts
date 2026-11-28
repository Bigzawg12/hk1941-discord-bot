import { afterEach, describe, expect, it } from 'vitest';
import { POINTS, RANKS } from '../src/game/gameConfig.js';
import { computePoints } from '../src/game/points.js';
import { progressOf, rosterFor } from '../src/game/promotions.js';
import { applySettings, cleanSettings } from '../src/game/serviceSettings.js';
import { ActivityTracker, statusOf } from '../src/game/activity.js';
import { createDashboard } from '../src/web/server.js';
import { handleInteraction } from '../src/discord/dispatch.js';
import { loadCommands } from '../src/loaders/commands.js';
import { fakeButton, fakeClient, fakeInteraction, fakeModal, IDS, profileStoreValue, replyText, SAMPLE_PROFILE, testServices } from './helpers/fixtures.js';
import { fakeGuild, VERIFIED } from './helpers/guild.js';
import { json, type Call } from './helpers/mockFetch.js';

const ADMIN = '123456789012345678';
const EVENT_START = Math.floor(Date.now() / 1000) + 3 * 3600;
const EVENTS = [{ id: '4821', title: 'Defence of the Gap', detail: 'Muster at HQ', start: EVENT_START, host: 'Maj_X' }];
const ARMY = 409406376;
const ROLES = [
  { id: '1', displayName: 'Recruit', rank: 1 },
  { id: '2', displayName: 'Private', rank: 2 },
  { id: '3', displayName: 'Corporal', rank: 3 },
  { id: '9', displayName: 'Lieutenant', rank: 9 },
  { id: '200', displayName: 'Developer', rank: 200 },
  { id: '255', displayName: 'Owner', rank: 255 },
];
const DIV = 555000111;
const DIV_ROLES = [
  { id: '51', displayName: 'Rifleman', rank: 1, memberCount: 30 },
  { id: '52', displayName: 'Lance Corporal', rank: 2, memberCount: 8 },
];
const MEMBERSHIP = { path: `groups/${ARMY}/memberships/m99`, user: 'users/99', role: `groups/${ARMY}/roles/2` };

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((d) => d.close()));
});

async function start(over: { bannedUntil?: number; patchStatus?: number; env?: Record<string, string> } = {}) {
  const patches: Call[] = [];
  const writes: Call[] = [];
  const published: Call[] = [];
  let saved: unknown = null;
  const { services } = testServices(
    [
      ['GET', `/cloud/v2/groups/${ARMY}/roles`, () => json({ groupRoles: ROLES })],
      ['GET', `/cloud/v2/groups/${DIV}/roles`, () => json({ groupRoles: DIV_ROLES })],
      ['GET', /\/cloud\/v2\/groups\/\d+$/, (url) => json({ id: url.pathname.split('/').pop(), displayName: url.pathname.endsWith(String(DIV)) ? 'Royal Rifles of Canada' : 'Canadian Army 1940s', memberCount: 42 })],
      [
        'GET',
        `/cloud/v2/groups/${DIV}/memberships`,
        () => json({ groupMemberships: [{ path: `groups/${DIV}/memberships/d99`, user: 'users/99', role: `groups/${DIV}/roles/51`, createTime: '2026-01-02T00:00:00Z' }], nextPageToken: 'tok2' }),
      ],
      ['PATCH', `/cloud/v2/groups/${DIV}/memberships/d99`, (_u, call) => (patches.push(call), json({}))],
      [
        'GET',
        `/cloud/v2/groups/${ARMY}/memberships`,
        (url) => {
          const f = url.searchParams.get('filter') ?? '';
          return json({ groupMemberships: !f || f.includes('roles/2') || f.includes('users/99') ? [MEMBERSHIP] : [] });
        },
      ],
      [
        'PATCH',
        `/cloud/v2/groups/${ARMY}/memberships/m99`,
        (_u, call) => (over.patchStatus ? json({ code: 'PERMISSION_DENIED', message: 'Insufficient permissions.' }, over.patchStatus) : (patches.push(call), json({}))),
      ],
      ['GET', 'groups.roblox.com/v2/users/42/groups/roles', () => json({ data: [{ group: { id: ARMY }, role: { id: 9, name: 'Lieutenant', rank: 9 } }] })],
      ['GET', 'groups.roblox.com/v2/users/99/groups/roles', () => json({ data: [{ group: { id: ARMY }, role: { id: 2, name: 'Private', rank: 2 } }, { group: { id: DIV }, role: { id: 51, name: 'Rifleman', rank: 1 } }] })],
      ['POST', 'users.roblox.com/v1/usernames/users', () => json({ data: [{ id: 99, name: 'Pte_Target', displayName: 'Target' }] })],
      ['POST', 'users.roblox.com/v1/users', () => json({ data: [{ id: 99, name: 'Pte_Target', displayName: 'Target' }] })],
      ['GET', 'users.roblox.com/v1/users/99', () => json({ id: 99, name: 'Pte_Target', displayName: 'Target', description: '' })],
      ['GET', 'thumbnails.roblox.com', () => json({ data: [{ targetId: 99, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/head.png' }] })],
      ['POST', 'standard-datastores/datastore/entries/entry', (_u, call) => ((saved = call.body), writes.push(call), json({}))],
      ['POST', 'messaging-service/v1', (_u, call) => (published.push(call), json({}))],
      [
        'GET',
        'standard-datastores/datastore/entries/entry',
        (url) => {
          const key = url.searchParams.get('entryKey');
          if (key === 'u99') return json(profileStoreValue(SAMPLE_PROFILE));
          if (key === 'HK1941_AdminLog/recent') return json([{ t: 1_795_700_000, by: 'Sgt_Mod', text: ';kick Pte_Target spamming the radio' }]);
          if (key === 'HK1941_Staff/list') return json({});
          if (key === 'HK1941_Events/list') return json(EVENTS);
          if (key === 'HK1941_Config/service' && saved) return json(saved);
          if (key === 'HK1941_Bans/u99' && over.bannedUntil !== undefined) return json({ untilT: over.bannedUntil, reason: 'Exploiting', by: 'Maj_X' });
          return json({ error: 'NOT_FOUND' }, 404);
        },
      ],
    ],
    { DISCORD_CLIENT_SECRET: 's', SESSION_SECRET: 'x'.repeat(40), DASHBOARD_ADMIN_IDS: ADMIN, OWNER_DISCORD_IDS: IDS.otherUser, ...over.env },
  );
  const fc = fakeClient();
  fc.client.guilds.cache.set(IDS.guild, fakeGuild().guild);
  // Discord sign-in: the code is the Discord ID that signs in
  const discord = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/oauth2/token')) return json({ access_token: new URLSearchParams(String(init.body)).get('code'), token_type: 'Bearer' });
    const id = String((init.headers as Record<string, string>).authorization ?? '').replace('Bearer ', '');
    return json({ id, username: id === ADMIN ? 'owner' : 'officer', global_name: id === ADMIN ? 'The Owner' : 'Lt Officer', avatar: null });
  };
  const dash = createDashboard({ services, client: () => fc.client as never, fetch: discord as never, gameLogPollMs: 0, scanWaitMs: 5000, accessFile: null });
  open.push(dash);
  const base = `http://127.0.0.1:${await dash.listen(0, '127.0.0.1')}`;
  /** A browser signed in as one Discord user. */
  const as = async (discordId: string) => {
    let cookie = '';
    const req = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(base + path, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), cookie } });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      return res;
    };
    const go = await req('/auth/discord');
    const signIn = await req(`/auth/discord/callback?code=${discordId}&state=${new URL(go.headers.get('location')!).searchParams.get('state')}`);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await req('/members')).text())?.[1] ?? '';
    const post = (path: string, body: Record<string, string>) =>
      req(path, { method: 'POST', body: new URLSearchParams({ _csrf: csrf, ...body }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    return { req, post, signIn };
  };
  const { req, post } = await as(ADMIN);
  await services.adminLog.refresh();
  return { services, req, post, patches, fc, writes, published, as };
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
    expect(text).not.toContain('200 · Developer'); // not obtainable
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
    await post('/members/99', { action: 'rank', roleId: '200', expectRoleId: '2' });
    expect(await (await req('/members/99')).text()).toContain('can’t be given out');
    expect(patches).toHaveLength(0);
  });

  it('finds a member by name', async () => {
    const { req } = await start();
    expect((await req('/members?q=Pte_Target')).headers.get('location')).toBe('/members/99');
  });
});

describe('groups (army and divisions)', () => {
  it('adds a division, lists its members with their rank, and changes a rank there', async () => {
    const { req, post, patches, services } = await start();
    expect(await (await req('/groups')).text()).toContain('Canadian Army 1940s');
    await post('/groups', { action: 'add', group: '668236881' }); // the main group gets its own tag
    expect(await (await req('/groups/668236881')).text()).toContain('Main group');
    const added = await post('/groups', { action: 'add', group: `https://www.roblox.com/groups/${DIV}/Royal-Rifles`, label: '' });
    expect(added.headers.get('location')).toBe(`/groups/${DIV}`);
    expect((await services.divisions.get(DIV))?.addedBy).toBe('The Owner');
    const members = await (await req(`/groups/${DIV}`)).text();
    expect(members).toContain('Royal Rifles of Canada');
    expect(members).toContain('href="https://www.roblox.com/groups/555000111"');
    expect(members).toContain('<b>Rifleman</b>');
    expect(members).toContain('2026-01-02');
    expect(members).toContain('after=tok2'); // next page
    const back = `/groups/${DIV}?tab=members`;
    const res = await post(`/groups/${DIV}`, { action: 'rank', userId: '99', roleId: '52', expectRoleId: '51', back });
    expect(res.headers.get('location')).toBe(back);
    expect(patches.at(-1)!.body).toEqual({ role: `groups/${DIV}/roles/52` });
    expect((await services.promotionLog.list(99))[0]).toMatchObject({ groupId: DIV, from: 'Rifleman', to: 'Lance Corporal' });
  });

  it('settings: Discord invite and server; bad invites refused; the army can’t be removed', async () => {
    const { req, post, services } = await start();
    await post('/groups', { action: 'add', group: String(DIV) });
    await post(`/groups/${DIV}`, { action: 'settings', label: 'RRC', discordInvite: 'https://discord.gg/rrc1941', guildId: IDS.guild });
    expect(await services.divisions.get(DIV)).toMatchObject({ label: 'RRC', discordInvite: 'https://discord.gg/rrc1941', guildId: IDS.guild });
    const page = await (await req(`/groups/${DIV}`)).text();
    expect(page).toContain('<h1>RRC</h1>');
    expect(page).toContain('href="https://discord.gg/rrc1941"');
    expect(page).toContain(`href="/servers/${IDS.guild}"`);
    await post(`/groups/${DIV}`, { action: 'settings', discordInvite: 'javascript:alert(1)' });
    expect((await services.divisions.get(DIV))?.discordInvite).toBe('https://discord.gg/rrc1941');
    await post(`/groups/${ARMY}`, { action: 'remove', confirm: '1' });
    expect(await (await req('/groups')).text()).toContain('The army group always stays');
    await post(`/groups/${DIV}`, { action: 'remove', confirm: '1' });
    expect(await services.divisions.get(DIV)).toBeNull();
  });

  it('member page: their rank in each division, changeable there', async () => {
    const { req, post } = await start();
    await post('/groups', { action: 'add', group: String(DIV) });
    const text = await (await req('/members/99')).text();
    expect(text).toContain('Divisions');
    expect(text).toContain('Rifleman (rank 1)');
    expect(text).toContain(`action="/groups/${DIV}"`);
  });
});

describe('after a rank change', () => {
  it('refreshes their Discord roles when they are linked', async () => {
    const { post, req, services } = await start();
    await services.links.linkVerified(IDS.staffUser, { id: 99, name: 'Pte_Target' }, 'manual');
    await services.guilds.update(IDS.guild, 'test', (s) => {
      s.verifiedRoleId = VERIFIED;
    });
    await post('/members/99', { action: 'rank', roleId: '3', expectRoleId: '2' });
    expect(await (await req('/members/99')).text()).toContain('Discord roles and nickname are updated');
  });

  it('says so when nothing changed in Discord, or they aren’t linked', async () => {
    const { post, req, services } = await start();
    await post('/members/99', { action: 'rank', roleId: '3', expectRoleId: '2' });
    expect(await (await req('/members/99')).text()).toContain('no linked Discord account');
    await services.links.linkVerified(IDS.staffUser, { id: 99, name: 'Pte_Target' }, 'manual');
    await post('/members/99', { action: 'rank', roleId: '3', expectRoleId: '2' });
    expect(await (await req('/members/99')).text()).toContain('no rank bind matches');
  });

  it('explains when Roblox refuses', async () => {
    const { post, req } = await start({ patchStatus: 403 });
    await post('/members/99', { action: 'rank', roleId: '3', expectRoleId: '2' });
    expect(await (await req('/members/99')).text()).toContain('isn&#39;t allowed to give Corporal');
  });
});

describe('/nominate and bulk promotions', () => {
  const APPROVAL = '600000000000000001';
  async function withCommands() {
    const t = await start();
    t.services.commands = await loadCommands();
    await t.services.guilds.update(IDS.guild, 'test', (s) => {
      s.approvalChannelId = APPROVAL;
    });
    return t;
  }

  it('a request waits with buttons; a Moderator can’t approve; an owner can, and the asker is told', async () => {
    const { services, fc, patches } = await withCommands();
    const cmd = fakeInteraction({ commandName: 'nominate', strings: { user: 'Pte_Target', rank: '3', reason: 'Led the patrol' }, roles: [IDS.modRole], client: fc });
    await handleInteraction(services, cmd.interaction as never);
    expect(replyText(cmd.replies.at(-1))).toMatch(/Sent for approval/);
    const q = fc.sent.at(-1)!;
    expect(q.channelId).toBe(APPROVAL);
    const embed = JSON.stringify((q.payload.embeds as { toJSON(): unknown }[])[0]!.toJSON());
    expect(embed).toContain('**Private** → **Corporal**');
    expect(embed).toContain('Led the patrol');
    const [req] = await services.promotionRequests.list({ status: 'pending' });
    expect(req).toMatchObject({ userId: 99, toName: 'Corporal', byId: IDS.staffUser });

    const mod = fakeButton({ customId: `nominate:approve:${req!.id}`, userId: '999999999999999999', roles: [IDS.modRole], client: fc });
    await handleInteraction(services, mod.interaction as never);
    expect(replyText(mod.replies.at(-1))).toMatch(/needs Administrator/);
    expect(patches).toHaveLength(0);

    const ok = fakeButton({ customId: `nominate:approve:${req!.id}`, userId: IDS.otherUser, client: fc });
    await handleInteraction(services, ok.interaction as never);
    expect(patches).toHaveLength(1);
    expect((await services.promotionRequests.get(req!.id))?.status).toBe('approved');
    expect(String(fc.dms.at(-1)?.payload.content)).toMatch(/promote Pte_Target to Corporal was approved/);
  });

  it('a request can be rejected with a note, from Discord or the dashboard', async () => {
    const { services, fc, post, patches } = await withCommands();
    const ask = async () => {
      const cmd = fakeInteraction({ commandName: 'nominate', strings: { user: 'Pte_Target', rank: '3', reason: 'r' }, roles: [IDS.modRole], client: fc });
      await handleInteraction(services, cmd.interaction as never);
      return (await services.promotionRequests.list({ status: 'pending' }))[0]!;
    };
    const a = await ask();
    const no = fakeModal({ customId: `nominate:why:${a.id}`, fields: { note: 'Not yet' }, userId: IDS.otherUser, client: fc });
    await handleInteraction(services, no.interaction as never);
    expect(await services.promotionRequests.get(a.id)).toMatchObject({ status: 'rejected', note: 'Not yet' });
    const b = await ask();
    await post('/promotions', { action: 'decide', id: b.id, decision: 'approve' });
    expect((await services.promotionRequests.get(b.id))?.status).toBe('approved');
    expect(patches).toHaveLength(1);
  });

  it('the dashboard promotes everyone ticked', async () => {
    const { post, req, patches } = await start();
    const queue = await (await req('/promotions')).text();
    expect(queue).toContain('name="pick_99" value="2:3"');
    await post('/promotions', { action: 'bulk', pick_99: '2:3', reason: 'Monthly promotions' });
    expect(patches).toHaveLength(1);
    expect(await (await req('/promotions')).text()).toContain('Promoted 1: Pte_Target → Corporal.');
  });
});

describe('point values and rank requirements', () => {
  afterEach(() => {
    applySettings({}); // back to the game's defaults for other tests
  });

  it('keeps only sensible values', () => {
    expect(cleanSettings({ points: { capture: 9, aiKillsPer: 0, bogus: 5, trainingAttended: -1 }, ranks: { 2: { points: 50 }, 99: { points: 1 } } })).toEqual({
      v: 1,
      points: { capture: 9 },
      ranks: { 2: { points: 50, trainings: undefined } },
    });
  });

  it('the dashboard saves them to the data store, tells live servers, and re-scores straight away', async () => {
    const { req, post, writes, published, services } = await start();
    const page = await (await req('/promotions?tab=settings')).text();
    expect(page).toContain('name="p_capture" id="p_capture" value="4"');
    expect(page).toContain('name="r_2_points" id="r_2_points" value="120"');
    const form: Record<string, string> = { action: 'settings' };
    for (const [k, v] of Object.entries(POINTS)) form[`p_${k}`] = String(v);
    for (const [k, v] of Object.entries(RANKS)) {
      form[`r_${k}_points`] = String(v.points);
      form[`r_${k}_trainings`] = String(v.trainings);
    }
    form.p_trainingAttended = '20';
    form.r_2_points = '500';
    await post('/promotions', form);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url).toContain('entryKey=HK1941_Config%2Fservice');
    expect(writes[0]!.headers['content-md5']).toMatch(/==$/);
    expect(writes[0]!.body).toMatchObject({ v: 1, points: { trainingAttended: 20 }, ranks: { 2: { points: 500, trainings: 4 } }, by: 'The Owner' });
    expect(published[0]!.url).toContain('/topics/HK1941Config');
    expect(POINTS.trainingAttended).toBe(20);
    expect(RANKS[2]!.points).toBe(500);
    expect(computePoints(SAMPLE_PROFILE as never).parts.find(([l]) => l === 'Trainings attended')![1]).toBe(5 * 20);
    // Pte_Target (rank 2) no longer has enough points, so isn't ready
    expect(await (await req('/promotions')).text()).not.toContain('pick_99');
    // a fresh start reads the saved values back
    applySettings({});
    await services.serviceSettings.load();
    expect(RANKS[2]!.points).toBe(500);
    await post('/promotions', { action: 'settings-reset' });
    expect(RANKS[2]!.points).toBe(120);
  });
});

describe('dashboard access levels', () => {
  const OFFICER = '777000000000000001';

  it('only owners get in until an owner opens it up', async () => {
    const { as, services } = await start();
    await services.links.linkVerified(OFFICER, { id: 42, name: 'Lt_Officer' }, 'manual');
    const shut = await as(OFFICER);
    expect(await shut.signIn.text()).toContain('not enough for dashboard access');
  });

  it('officers by army rank: see and change ranks below their own, but not admin pages', async () => {
    const { as, post, services, patches } = await start();
    await services.links.linkVerified(OFFICER, { id: 42, name: 'Lt_Officer' }, 'manual');
    await post('/access', { action: 'rules', officer_rank: '9', officer_tier: '', viewer_rank: '', viewer_tier: '', admin_rank: '', admin_tier: '' });
    await post(`/groups/${ARMY}`, { action: 'settings', managerRank: '9' }); // Lieutenants and up manage the army group
    const lt = await as(OFFICER);
    const home = await (await lt.req('/')).text();
    expect(home).toContain('Officer</small>');
    expect(home).not.toContain('href="/servers"');
    expect(home).not.toContain('href="/access"');
    expect((await lt.req('/servers')).status).toBe(403);
    expect((await lt.req('/access')).status).toBe(403);
    expect(await (await lt.req('/promotions')).text()).not.toContain('pick_99'); // no bulk for officers
    expect((await lt.post('/promotions', { action: 'settings' })).status).toBe(403);
    expect(await (await lt.req('/members/99')).text()).toContain('name="roleId"');
    // below their own rank: fine
    await lt.post('/members/99', { action: 'rank', roleId: '3', expectRoleId: '2' });
    expect(patches).toHaveLength(1);
    expect((await services.promotionLog.list(99))[0]?.by).toBe('Lt Officer (dashboard)');
    // their own rank or above: refused
    await lt.post('/members/99', { action: 'rank', roleId: '9', expectRoleId: '2' });
    expect(await (await lt.req('/members/99')).text()).toContain('only give ranks below your own');
    expect(patches).toHaveLength(1);
  });

  it('a person can be set or blocked by hand', async () => {
    const { as, post, req, services } = await start();
    await services.links.linkVerified(OFFICER, { id: 42, name: 'Lt_Officer' }, 'manual');
    await post('/access', { action: 'set', discordId: OFFICER, level: '1', note: 'Recruiter' });
    expect(await (await req('/access')).text()).toContain('Recruiter');
    const viewer = await as(OFFICER);
    expect(await (await viewer.req('/members/99')).text()).not.toContain('name="roleId"');
    expect((await viewer.post('/members/99', { action: 'rank', roleId: '3', expectRoleId: '2' })).status).toBe(403);
    await post('/access', { action: 'rules', viewer_rank: '1' });
    await post('/access', { action: 'set', discordId: OFFICER, level: '0' });
    expect(await (await as(OFFICER)).signIn.text()).toContain('Blocked by The Owner');
  });
});

describe('per-server checks and the audit log', () => {
  const ADMIN_ROLE = '700000000000000004';

  async function adminWithoutOwner(withStaffRole: boolean) {
    const t = await start();
    await t.services.links.linkVerified(IDS.staffUser, { id: 42, name: 'Lt_Officer' }, 'manual');
    await t.post('/access', { action: 'set', discordId: IDS.staffUser, level: '3' });
    if (withStaffRole) {
      await t.services.guilds.update(IDS.guild, 'test', (s) => {
        s.staffRoles = { [ADMIN_ROLE]: 4 };
      });
      const guild = t.fc.client.guilds.cache.get(IDS.guild) as { members: { fetch(id: string): Promise<{ roles: { cache: Map<string, unknown> } }> } };
      (await guild.members.fetch(IDS.staffUser)).roles.cache.set(ADMIN_ROLE, {});
    }
    return { ...t, admin: await t.as(IDS.staffUser) };
  }

  it('an Admin who isn’t staff in a Discord server can’t see or change it', async () => {
    const { admin } = await adminWithoutOwner(false);
    expect(await (await admin.req('/servers')).text()).not.toContain('HK1941 Test');
    expect((await admin.req(`/servers/${IDS.guild}`)).status).toBe(403);
    expect(await (await admin.req('/panels/new')).text()).toContain('Not in any server yet');
  });

  it('…and one with Administrator there can', async () => {
    const { admin } = await adminWithoutOwner(true);
    expect(await (await admin.req('/servers')).text()).toContain('HK1941 Test');
    expect((await admin.req(`/servers/${IDS.guild}`)).status).toBe(200);
  });

  it('keeps every action for the Audit log page, with filters and CSV', async () => {
    const { post, req } = await start();
    await post('/members/99', { action: 'rank', roleId: '3', expectRoleId: '2', reason: 'Good work' });
    const page = await (await req('/audit')).text();
    expect(page).toContain('Promotion');
    expect(page).toContain('Pte_Target (99)');
    expect(page).toContain('dashboard');
    expect(await (await req('/audit?src=discord')).text()).toContain('Nothing matches');
    const csv = await (await req('/audit.csv')).text();
    expect(csv.split('\r\n')[0]).toBe('time_utc,discord_id,name,action,target,detail,ok,server');
    expect(csv).toContain('Private (2) → Corporal (3)');
  });
});

describe('which groups an Officer can change ranks in', () => {
  const OFFICER = '777000000000000001';

  it('none until a group says which of its ranks can, or an owner adds the group for them', async () => {
    const { as, post, services, patches } = await start();
    await services.links.linkVerified(OFFICER, { id: 42, name: 'Lt_Officer' }, 'manual');
    await post('/groups', { action: 'add', group: String(DIV) });
    await post('/access', { action: 'rules', officer_rank: '9' });
    const lt = await as(OFFICER);
    // the army group has no "who can change ranks here" yet
    expect(await (await lt.req('/members/99')).text()).not.toContain('name="expectRoleId" value="2"');
    await lt.post('/members/99', { action: 'rank', roleId: '3', expectRoleId: '2' });
    expect(await (await lt.req('/members/99')).text()).toContain('can’t change ranks in this group');
    expect(patches).toHaveLength(0);
    // an owner gives them the division by hand
    await post('/access', { action: 'set', discordId: OFFICER, level: '2', [`g_${DIV}`]: '1' });
    const lt2 = await as(OFFICER);
    expect(await (await lt2.req(`/groups/${DIV}`)).text()).toContain('Change rank');
    expect(await (await lt2.req(`/groups/${ARMY}`)).text()).not.toContain('Change rank');
  });
});

describe('/apply', () => {
  it('a member applies; the answers go to the review channel; accepting gives the starting rank', async () => {
    const t = await start();
    t.services.commands = await loadCommands();
    const { services, fc, post, req, patches } = t;
    await post('/groups', { action: 'add', group: String(DIV) });
    await post(`/groups/${DIV}`, { action: 'apps-settings', open: '1', questions: 'Why do you want to join?\nHow many hours a week?', startRoleId: '52', channelId: '800000000000000001' });
    expect((await services.divisions.get(DIV))?.applications).toMatchObject({ open: true, startRoleId: 52, questions: ['Why do you want to join?', 'How many hours a week?'] });
    await services.links.linkVerified(IDS.staffUser, { id: 99, name: 'Pte_Target' }, 'manual');

    const cmd = fakeInteraction({ commandName: 'apply', strings: { division: String(DIV) }, client: fc });
    await handleInteraction(services, cmd.interaction as never);
    const form = (cmd.replies.at(-1) as { toJSON(): { custom_id: string; components: unknown[] } }).toJSON();
    expect(form.custom_id).toBe(`apply:form:${DIV}`);
    expect(form.components).toHaveLength(2);
    const sub = fakeModal({ customId: form.custom_id, fields: { q0: 'I like the Rifles', q1: '10' }, client: fc });
    await handleInteraction(services, sub.interaction as never);
    expect(replyText(sub.replies.at(-1))).toMatch(/application to \*\*Royal Rifles of Canada\*\* is in/);
    const review = fc.sent.at(-1)!;
    expect(review.channelId).toBe('800000000000000001');
    expect(JSON.stringify((review.payload.embeds as { toJSON(): unknown }[])[0]!.toJSON())).toContain('I like the Rifles');
    const [app] = await services.applications.list({ status: 'pending' });

    // a second application while one waits is refused
    const again = fakeInteraction({ commandName: 'apply', strings: { division: String(DIV) }, client: fc });
    await handleInteraction(services, again.interaction as never);
    expect(replyText(again.replies.at(-1))).toMatch(/already have an application/);

    const accept = fakeButton({ customId: `apply:accept:${app!.id}`, userId: IDS.otherUser, client: fc });
    await handleInteraction(services, accept.interaction as never);
    expect(patches.at(-1)!.body).toEqual({ role: `groups/${DIV}/roles/52` });
    expect((await services.applications.get(app!.id))?.status).toBe('accepted');
    expect(String(fc.dms.at(-1)?.payload.content)).toMatch(/application to \*\*Royal Rifles of Canada\*\* was accepted/);
    expect(await (await req(`/groups/${DIV}?tab=applications`)).text()).toContain('Accepted');
  });
});

describe('activity', () => {
  it('works out time played this week from daily checks, and the status from when they last played', async () => {
    let clock = Date.parse('2026-11-01T12:00:00Z');
    let play = 600;
    const fake = {
      config: { roblox: { armyGroupId: ARMY } },
      logger: { warn: () => undefined },
      divisions: { list: async () => [] },
      groups: { listMembers: async () => ({ members: [{ userId: 5, roleId: 2 }] }) },
      profiles: {
        get: async () => ({ data: { service: { lastJoin: clock / 1000 - 2 * 86400, playtime: play, deployedTime: 100 }, training: { history: [{ t: clock / 1000 - 86400 }, { t: clock / 1000 - 40 * 86400 }] } } }),
      },
    };
    const a = new ActivityTracker(fake as never, null, () => clock);
    await a.refreshGroup(ARMY);
    expect((await a.person(5)).week).toBeUndefined(); // no week-old check yet
    clock += 8 * 86400_000;
    play = 900;
    await a.refreshGroup(ARMY);
    const p = await a.person(5);
    expect(p.week).toBe(300);
    expect(p.row?.trainings30).toBe(1);
    expect(statusOf(p.row, clock)).toBe('active');
    expect(statusOf(p.row, clock + 10 * 86400_000)).toBe('quiet');
    expect(statusOf(p.row, clock + 30 * 86400_000)).toBe('inactive');
    expect((await a.group(ARMY)).members[0]).toMatchObject({ userId: 5, week: 300 });
  });

  it('the Activity tab lists members with their status', async () => {
    const { req, services } = await start();
    await services.activity.refreshGroup(ARMY);
    const page = await (await req(`/groups/${ARMY}?tab=activity`)).text();
    expect(page).toContain('Pte_Target');
    expect(page).toContain('Inactive'); // last played a year ago
    expect(page).toContain('Checked just now');
    expect(await (await req('/members/99')).text()).toContain('trainings in 30 days');
  });
});

describe('limiting what people see to their own groups', () => {
  const OFFICER = '777000000000000001';

  it('a person limited to one division sees nothing of the others', async () => {
    const { as, post, services } = await start();
    await services.links.linkVerified(OFFICER, { id: 42, name: 'Lt_Officer' }, 'manual');
    await post('/groups', { action: 'add', group: String(DIV) });
    await post('/access', { action: 'set', discordId: OFFICER, level: '2', [`s_${DIV}`]: '1' });
    const lt = await as(OFFICER);
    const groups = await (await lt.req('/groups')).text();
    expect(groups).toContain('Royal Rifles of Canada');
    expect(groups).not.toContain('Canadian Army 1940s');
    expect((await lt.req(`/groups/${ARMY}`)).status).toBe(403);
    expect((await lt.req('/promotions')).status).toBe(403);
    expect(await (await lt.req('/')).text()).not.toContain('href="/promotions"');
    const member = await (await lt.req('/members/99')).text(); // Pte_Target is in the division too
    expect(member).not.toContain('Next on the ladder');
    expect(member).toContain('Royal Rifles of Canada');
    expect((await lt.post(`/groups/${ARMY}`, { action: 'rank', userId: '99', roleId: '3', expectRoleId: '2' })).status).toBe(403);
  });

  it('or automatically, to the groups they are a member of', async () => {
    const { as, post, services } = await start();
    await services.links.linkVerified(OFFICER, { id: 42, name: 'Lt_Officer' }, 'manual');
    await post('/groups', { action: 'add', group: String(DIV) });
    await post('/access', { action: 'rules', officer_rank: '9', scopeByMembership: '1' });
    const lt = await as(OFFICER); // Lt_Officer is only in the army group
    const groups = await (await lt.req('/groups')).text();
    expect(groups).toContain('Canadian Army 1940s');
    expect(groups).not.toContain('Royal Rifles of Canada');
    expect((await lt.req(`/groups/${DIV}`)).status).toBe(403);
  });
});

describe('binding ranks to Discord roles by name', () => {
  it('matches exact names first, then a role that contains the rank, never the same role twice', async () => {
    const { matchRanksToRoles } = await import('../src/linking/autoBind.js');
    const out = matchRanksToRoles(
      [
        { rank: 3, name: 'Corporal' },
        { rank: 4, name: 'Master Corporal' },
        { rank: 5, name: 'Sergeant' },
        { rank: 9, name: 'Lieutenant' },
      ],
      [
        { id: 'a', name: 'Master Corporal' },
        { id: 'b', name: 'Cpl | Corporal' },
        { id: 'c', name: 'SGT – Sergeant' },
        { id: 'd', name: 'Sergeant Major' },
      ],
    );
    expect(out.map((m) => [m.rank, m.role?.id, m.how])).toEqual([
      [3, 'b', 'contains'],
      [4, 'a', 'exact'],
      [5, undefined, undefined], // two roles contain "sergeant": too unsure, left for you
      [9, undefined, undefined],
    ]);
  });

  it('treats company letters, phonetic names and army abbreviations alike', async () => {
    const { matchRanksToRoles, normName } = await import('../src/linking/autoBind.js');
    expect(normName('C Coy')).toBe(normName('Charlie Company'));
    expect(normName('Cpl')).toBe('corporal');
    expect(normName('X-Ray Company')).toBe('x company');
    const out = matchRanksToRoles(
      [
        { rank: 10, name: 'A Company' },
        { rank: 11, name: 'B Coy' },
        { rank: 12, name: 'C' },
        { rank: 3, name: 'Cpl' },
      ],
      [
        { id: 'able', name: 'Able Company' },
        { id: 'baker', name: 'Baker Company' },
        { id: 'charlie', name: 'Charlie Company' },
        { id: 'cpl', name: 'Corporal' },
        { id: 'chief', name: 'Chief of Army Staff' },
      ],
    );
    expect(out.map((m) => [m.rankName, m.role?.id])).toEqual([
      ['A Company', 'able'],
      ['B Coy', 'baker'],
      ['C', 'charlie'],
      ['Cpl', 'cpl'],
    ]);
  });

  it('previews on the Rank binds tab, then binds and creates the missing roles', async () => {
    const { req, post, services, fc } = await start();
    const guild = fc.client.guilds.cache.get(IDS.guild) as {
      roles: { cache: Map<string, { id: string; name: string; position: number; managed: boolean }>; create?: unknown };
    };
    const names: Record<string, string> = { '700000000000000001': 'Verified', '700000000000000002': 'Private', '700000000000000003': 'Cpl | Corporal', '700000000000000004': 'Lieutenant' };
    for (const [id, name] of Object.entries(names)) guild.roles.cache.get(id)!.name = name;
    guild.roles.create = async ({ name }: { name: string }) => {
      const role = { id: '700000000000000099', name, position: 1, managed: false };
      guild.roles.cache.set(role.id, role);
      return role;
    };
    const preview = await (await req(`/servers/${IDS.guild}?tab=binds&auto=${ARMY}&create=1`)).text();
    expect(preview).toContain('<option value="700000000000000003" selected>@Cpl | Corporal</option>');
    expect(preview).toContain('<option value="create" selected>+ Create @Recruit</option>');
    expect(preview).toContain('No role: will create one');
    expect(preview).not.toContain('<td>Developer</td>'); // never offered
    // save, changing one row by hand: Lieutenant goes to @Verified instead
    await post(`/servers/${IDS.guild}`, {
      action: 'autobind',
      tab: 'binds',
      groupId: String(ARMY),
      r_1: 'create',
      r_2: '700000000000000002',
      r_3: '700000000000000003',
      r_9: '700000000000000001',
    });
    const binds = (await services.guilds.get(IDS.guild)).rankBinds ?? [];
    expect(binds.map((b) => [b.roleId, b.min]).sort()).toEqual([
      ['700000000000000001', 9],
      ['700000000000000002', 2],
      ['700000000000000003', 3],
      ['700000000000000099', 1],
    ]);
    expect(await (await req(`/servers/${IDS.guild}?tab=binds&auto=${ARMY}`)).text()).toContain('Already bound');
  });
});

describe('events on the dashboard', () => {
  it('shows the calendar and list, and schedules and cancels through the bridge', async () => {
    const { req, post, services, published } = await start({ env: { BRIDGE_ACKS: 'false' } });
    const page = await (await req('/events')).text();
    expect(page).toContain('Defence of the Gap');
    expect(page).toContain('Muster at HQ');
    expect(page).toContain('class="cal-event"');
    // needs a linked Roblox account to post under
    await post('/events', { action: 'schedule', title: 'Night patrol', date: '2099-01-01', time: '20:00' });
    expect(await (await req('/events')).text()).toContain('Link your Roblox account first');
    await services.links.linkVerified(ADMIN, { id: 42, name: 'Maj_Owner' }, 'manual');
    const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    await post('/events', { action: 'schedule', title: 'Night patrol', detail: 'Bring lamps', date: tomorrow, time: '20:00' });
    const sent = JSON.stringify(published.at(-1)!.body);
    expect(sent).toContain('event_add');
    expect(sent).toContain('Night patrol');
    await post('/events', { action: 'cancel', id: '4821' });
    expect(JSON.stringify(published.at(-1)!.body)).toContain('event_cancel');
    const audit = await services.audit.list();
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['Schedule event', 'Cancel event #4821']));
  });

  it('Viewers see it but can’t schedule', async () => {
    const { as, post, services } = await start();
    const OFFICER = '777000000000000001';
    await services.links.linkVerified(OFFICER, { id: 42, name: 'Lt_Officer' }, 'manual');
    await post('/access', { action: 'set', discordId: OFFICER, level: '1' });
    const v = await as(OFFICER);
    const page = await (await v.req('/events')).text();
    expect(page).toContain('Defence of the Gap');
    expect(page).not.toContain('Schedule an event');
    expect((await v.post('/events', { action: 'cancel', id: '4821' })).status).toBe(403);
  });
});

describe('roles that cover several ranks', () => {
  it('suggests @Officer for the officer ranks and @Personnel for the enlisted ones, and saves them as ranges', async () => {
    const { req, post, services, fc } = await start();
    const guild = fc.client.guilds.cache.get(IDS.guild) as { roles: { cache: Map<string, { id: string; name: string; position: number; managed: boolean }> } };
    guild.roles.cache.set('700000000000000005', { id: '700000000000000005', name: 'Officer', position: 9, managed: false });
    guild.roles.cache.set('700000000000000006', { id: '700000000000000006', name: 'Personnel', position: 10, managed: false });
    const page = await (await req(`/servers/${IDS.guild}?tab=binds&auto=${ARMY}`)).text();
    const rows = page.slice(page.indexOf('Roles for several ranks'));
    // officers: above the points ladder (Lieutenant, 9); enlisted: Recruit (1) to Corporal (3) in this test group
    expect(rows).toMatch(/name="c_0_role"[\s\S]*?value="700000000000000005" selected/);
    expect(rows).toMatch(/name="c_0_min"[\s\S]*?value="9" selected/);
    expect(rows).toMatch(/name="c_1_role"[\s\S]*?value="700000000000000006" selected/);
    expect(rows).toMatch(/name="c_1_max"[\s\S]*?value="3" selected/);
    await post(`/servers/${IDS.guild}`, {
      action: 'autobind',
      tab: 'binds',
      groupId: String(ARMY),
      c_0_role: '700000000000000005',
      c_0_min: '9',
      c_0_max: '9',
      c_1_role: '700000000000000006',
      c_1_min: '1',
      c_1_max: '3',
    });
    const binds = (await services.guilds.get(IDS.guild)).rankBinds ?? [];
    expect(binds).toEqual(
      expect.arrayContaining([
        { roleId: '700000000000000005', groupId: ARMY, min: 9, max: 9 },
        { roleId: '700000000000000006', groupId: ARMY, min: 1, max: 3 },
      ]),
    );
    // next time the rows show what's bound
    const again = await (await req(`/servers/${IDS.guild}?tab=binds&auto=${ARMY}`)).text();
    expect(again.slice(again.indexOf('Roles for several ranks'))).toMatch(/name="c_1_min"[\s\S]*?value="1" selected/);
  });
});
