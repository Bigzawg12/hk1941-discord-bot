import { afterEach, describe, expect, it } from 'vitest';
import { progressOf, rosterFor } from '../src/game/promotions.js';
import { createDashboard } from '../src/web/server.js';
import { handleInteraction } from '../src/discord/dispatch.js';
import { loadCommands } from '../src/loaders/commands.js';
import { fakeButton, fakeClient, fakeInteraction, fakeModal, IDS, profileStoreValue, replyText, SAMPLE_PROFILE, testServices } from './helpers/fixtures.js';
import { fakeGuild, VERIFIED } from './helpers/guild.js';
import { json, type Call } from './helpers/mockFetch.js';

const ADMIN = '123456789012345678';
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

async function start(over: { bannedUntil?: number; patchStatus?: number } = {}) {
  const patches: Call[] = [];
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
          return json({ groupMemberships: f.includes('roles/2') || f.includes('users/99') ? [MEMBERSHIP] : [] });
        },
      ],
      [
        'PATCH',
        `/cloud/v2/groups/${ARMY}/memberships/m99`,
        (_u, call) => (over.patchStatus ? json({ code: 'PERMISSION_DENIED', message: 'Insufficient permissions.' }, over.patchStatus) : (patches.push(call), json({}))),
      ],
      ['GET', 'groups.roblox.com/v2/users/99/groups/roles', () => json({ data: [{ group: { id: ARMY }, role: { id: 2, name: 'Private', rank: 2 } }, { group: { id: DIV }, role: { id: 51, name: 'Rifleman', rank: 1 } }] })],
      ['POST', 'users.roblox.com/v1/usernames/users', () => json({ data: [{ id: 99, name: 'Pte_Target', displayName: 'Target' }] })],
      ['POST', 'users.roblox.com/v1/users', () => json({ data: [{ id: 99, name: 'Pte_Target', displayName: 'Target' }] })],
      ['GET', 'users.roblox.com/v1/users/99', () => json({ id: 99, name: 'Pte_Target', displayName: 'Target', description: '' })],
      ['GET', 'thumbnails.roblox.com', () => json({ data: [{ targetId: 99, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/head.png' }] })],
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
    { DISCORD_CLIENT_SECRET: 's', SESSION_SECRET: 'x'.repeat(40), DASHBOARD_ADMIN_IDS: ADMIN, OWNER_DISCORD_IDS: IDS.otherUser },
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
  return { services, req, post, patches, fc };
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
    expect(await (await req('/members/99')).text()).toContain('Discord roles updated');
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
