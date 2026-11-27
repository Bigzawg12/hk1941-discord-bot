import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDashboard } from '../src/web/server.js';
import { fakeClient, IDS, testServices } from './helpers/fixtures.js';
import { json } from './helpers/mockFetch.js';
import { fakeGuild } from './helpers/guild.js';

const ADMIN = '123456789012345678';
const GAME_LOG = [
  { t: 1_795_700_300, by: 'Pte_Target', text: ';kick Pte_X spawn killing' },
  { t: 1_795_700_200, by: 'Sgt_Mod (Discord)', text: 'ban 123 1 day (griefing)' },
  { t: 1_795_700_100, by: 'server', text: 'battle lock lifted automatically' },
  { t: 1_795_700_000, by: 'Someone', text: ';announce =cmd|hello' },
];
const WEB_ENV = {
  DISCORD_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: 'x'.repeat(40),
  DASHBOARD_ADMIN_IDS: ADMIN,
};

/** Discord's OAuth endpoints as the dashboard sees them; `who` is the account that signs in. */
function discordFetch(who: { id: string }) {
  return async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/oauth2/token')) return json({ access_token: 'tok', token_type: 'Bearer' });
    if (url.endsWith('/users/@me')) return json({ id: who.id, username: 'owner', global_name: 'The Owner', avatar: null });
    throw new Error(`unexpected ${url}`);
  };
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((d) => d.close()));
});

async function start(who = { id: ADMIN }) {
  const { services } = testServices(
    [
      ['GET', 'memory-store/sorted-maps/HK1941_Servers/items', json({ memoryStoreSortedMapItems: [] })],
      ['GET', 'games.roblox.com/v1/games/77901932829123/servers/Public', json({ data: [] })],
      ['GET', '/cloud/v2/groups/409406376/roles', json({ groupRoles: [{ id: '5', displayName: 'Corporal', rank: 5 }] })],
      ['POST', 'users.roblox.com/v1/usernames/users', json({ data: [{ id: 99, name: 'Pte_Target', displayName: 'T' }] })],
      ['GET', 'groups.roblox.com/v2/users/99/groups/roles', json({ data: [] })],
      // HK1941_Global: the in-game admin log and staff list
      ['GET', 'standard-datastores/datastore/entries/entry', (url) => {
        const key = url.searchParams.get('entryKey');
        if (key === 'HK1941_AdminLog/recent') return json(GAME_LOG);
        if (key === 'HK1941_Staff/list') return json({ '77': { tier: 2, name: 'Sgt_Mod' } });
        return { status: 404, json: { error: 'NOT_FOUND' } };
      }],
    ],
    WEB_ENV,
  );
  const fc = fakeClient();
  const { guild } = fakeGuild();
  fc.client.guilds.cache.set(IDS.guild, guild);
  const dash = createDashboard({ services, client: () => fc.client as never, fetch: discordFetch(who) as never, gameLogPollMs: 0 });
  open.push(dash);
  const port = await dash.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const req = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), cookie } });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return res;
  };
  /** Sign in through the (fake) Discord round trip. */
  const signIn = async () => {
    const go = await req('/auth/discord');
    const state = new URL(go.headers.get('location')!).searchParams.get('state')!;
    return req(`/auth/discord/callback?code=abc&state=${state}`);
  };
  const csrf = async (path: string) => /name="_csrf" value="([^"]+)"/.exec(await (await req(path)).text())?.[1] ?? '';
  const post = async (path: string, body: Record<string, string>) =>
    req(path, { method: 'POST', body: new URLSearchParams(body).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return { services, req, signIn, csrf, post, fc };
}

describe('admin dashboard', () => {
  it('is off unless the secrets are set, and needs an admin list', () => {
    const base = { DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: IDS.client, HK_OPEN_CLOUD_KEY: 'k', OWNER_DISCORD_IDS: ADMIN };
    expect(loadConfig(base).web.enabled).toBe(false);
    const on = loadConfig({ ...base, DISCORD_CLIENT_SECRET: 's', SESSION_SECRET: 'y'.repeat(32) }).web;
    expect(on).toMatchObject({ enabled: true, host: '127.0.0.1', port: 8080, publicUrl: 'http://localhost:8080', adminIds: [ADMIN] });
    expect(() => loadConfig({ ...base, OWNER_DISCORD_IDS: '', TIER_FROM_ROBLOX_RANK: 'true', DISCORD_CLIENT_SECRET: 's', SESSION_SECRET: 'y'.repeat(32) })).toThrow(/DASHBOARD_ADMIN_IDS/);
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('sends visitors to sign in, with safe headers', async () => {
    const { req } = await start();
    const res = await req('/');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax/);
  });

  it('lets an admin in after Discord sign-in', async () => {
    const { req, signIn } = await start();
    const back = await signIn();
    expect(back.status).toBe(303);
    const page = await req('/');
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('Overview');
    expect(text).toContain('The Owner');
  });

  it('keeps everyone else out', async () => {
    const { req, signIn } = await start({ id: IDS.otherUser });
    const res = await signIn();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("isn't on the dashboard's admin list");
    expect((await req('/')).headers.get('location')).toBe('/login');
  });

  it('refuses a forged sign-in (wrong state)', async () => {
    const { req } = await start();
    await req('/auth/discord');
    const res = await req('/auth/discord/callback?code=abc&state=wrong');
    expect(res.headers.get('location')).toBe('/login');
    expect((await req('/')).headers.get('location')).toBe('/login');
  });

  it('refuses forms without the CSRF token', async () => {
    const { signIn, post, services } = await start();
    await signIn();
    const res = await post(`/servers/${IDS.guild}`, { action: 'bind', roleId: '700000000000000003', min: '5' });
    expect(res.status).toBe(403);
    expect((await services.guilds.get(IDS.guild)).rankBinds).toBeUndefined();
  });

  it('changes server settings: a rank bind and the approval channel', async () => {
    const { signIn, csrf, post, req, services } = await start();
    await signIn();
    const token = await csrf(`/servers/${IDS.guild}`);
    const page = await (await req(`/servers/${IDS.guild}?tab=binds`)).text();
    expect(page).toContain('HK1941 Test');
    expect(page).toContain('5 Corporal');
    await post(`/servers/${IDS.guild}`, { _csrf: token, action: 'bind', roleId: '700000000000000003', min: '5', max: '6', groupId: '409406376' });
    await post(`/servers/${IDS.guild}`, { _csrf: token, action: 'channels', approvalChannelId: '800000000000000001', auditChannelId: 'not-a-channel' });
    const s = await services.guilds.get(IDS.guild);
    expect(s.rankBinds).toEqual([{ roleId: '700000000000000003', groupId: 409406376, min: 5, max: 6 }]);
    expect(s.approvalChannelId).toBe('800000000000000001');
    expect(s.auditChannelId).toBeUndefined(); // only channels in that server are accepted
    expect(await (await req(`/servers/${IDS.guild}`)).text()).toContain('Channels saved');
    // forms return to the tab they came from
    const back = await post(`/servers/${IDS.guild}`, { _csrf: token, action: 'unbind', tab: 'binds', roleId: '700000000000000003', groupId: '409406376' });
    expect(back.headers.get('location')).toBe(`/servers/${IDS.guild}?tab=binds`);
  });

  it('links and unlinks accounts by hand', async () => {
    const { signIn, csrf, post, req, services } = await start();
    await signIn();
    const token = await csrf('/links');
    await post('/links', { _csrf: token, action: 'link', discordId: IDS.staffUser, roblox: 'Pte_Target' });
    expect((await services.links.get(IDS.staffUser))?.method).toBe('manual');
    expect(await (await req('/links?q=pte')).text()).toContain('Pte_Target');
    await post('/links', { _csrf: token, action: 'unlink', discordId: IDS.staffUser });
    expect(await services.links.get(IDS.staffUser)).toBeNull();
  });

  it('escapes names from Discord and Roblox', async () => {
    const { signIn, req, services } = await start();
    await signIn();
    await services.links.linkVerified(IDS.staffUser, { id: 5, name: '<script>x</script>' }, 'manual');
    const text = await (await req('/links')).text();
    expect(text).not.toContain('<script>x');
    expect(text).toContain('&lt;script&gt;x');
  });

  it('returns to the page asked for after sign-in, never to /favicon.ico', async () => {
    const { req, signIn } = await start();
    await req('/game-log');
    await req('/favicon.ico'); // the browser asks for this in the background
    const back = await signIn();
    expect(back.headers.get('location')).toBe('/game-log');
    const icon = await req('/favicon.ico');
    expect(icon.headers.get('content-type')).toBe('image/png'); // the group's crest
  });

  it('is dark by default, can switch to light, and serves the crest', async () => {
    const { signIn, csrf, post, req } = await start();
    await signIn();
    const dark = await (await req('/game-log')).text();
    expect(dark).toContain('data-theme="dark"');
    expect(dark).toContain('src="/static/logo.png"');
    const token = await csrf('/');
    const res = await post('/theme', { _csrf: token, theme: 'light', back: '/game-log?src=game' });
    expect(res.headers.get('location')).toBe('/game-log?src=game');
    expect(await (await req('/')).text()).toContain('data-theme="light"');
    expect((await post('/theme', { _csrf: token, theme: 'dark', back: '//evil.example' })).headers.get('location')).toBe('/');
    const logo = await req('/static/logo.png');
    expect(logo.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await logo.arrayBuffer()).subarray(1, 4).toString()).toBe('PNG');
  });

  it('panels: preview keeps the text, posting sends it, and it can be edited and deleted', async () => {
    const { signIn, csrf, post, req, services, fc } = await start();
    await signIn();
    expect(await (await req('/panels')).text()).toContain('No panels yet');
    const token = await csrf('/panels/new');
    const form = {
      _csrf: token,
      guildId: IDS.guild,
      channelId: '800000000000000001',
      title: 'Server <Rules>',
      body: '# Rules\n1. Be **nice**\n2. See #general',
      buttons: 'Rulebook | https://example.com/rules',
      footer: '',
      colour: 'red',
      imageUrl: '',
    };
    // preview: shown, not posted, text kept and escaped
    const prev = await post('/panels/new', { ...form, action: 'preview' });
    expect(prev.status).toBe(200);
    const prevHtml = await prev.text();
    expect(prevHtml).toContain('Server &lt;Rules&gt;');
    expect(prevHtml).toContain('<strong>nice</strong>');
    expect(prevHtml).toContain('<span class="md-mention">#general</span>');
    expect(prevHtml).toContain('dc-embed c-red');
    expect(fc.sent).toHaveLength(0);
    // a bad button line: shown again with the text kept
    const bad = await post('/panels/new', { ...form, buttons: 'Rulebook', action: 'save' });
    const badHtml = await bad.text();
    expect(badHtml).toContain('no &quot;|&quot;');
    expect(badHtml).toContain('1. Be **nice**');
    expect(fc.sent).toHaveLength(0);
    // post it
    const posted = await post('/panels/new', { ...form, action: 'save' });
    expect(fc.sent).toHaveLength(1);
    const sent = fc.sent[0]!;
    expect(sent.channelId).toBe('800000000000000001');
    const embed = (sent.payload.embeds as { toJSON(): { title: string; description: string; color: number; footer: { text: string } } }[])[0]!.toJSON();
    expect(embed.title).toBe('Server <Rules>');
    expect(embed.description).toContain('See <#800000000000000001>');
    expect(embed.color).toBe(0xa33b3b);
    expect(embed.footer.text).toBe('HK1941 Test');
    expect(sent.payload.allowedMentions).toEqual({ parse: [] });
    const [rec] = await services.panels.list();
    expect(rec).toMatchObject({ guildId: IDS.guild, channelId: '800000000000000001', title: 'Server <Rules>', updatedBy: 'The Owner' });
    expect(posted.headers.get('location')).toBe(`/panels/${rec!.messageId}`);
    // the list and the editor (channel link shown as #general again)
    expect(await (await req('/panels')).text()).toContain('Server &lt;Rules&gt;');
    const editor = await (await req(`/panels/${rec!.messageId}`)).text();
    expect(editor).toContain('2. See #general');
    expect(editor).toContain('Rulebook | https://example.com/rules');
    // edit in place
    await post(`/panels/${rec!.messageId}`, { ...form, title: 'Rules v2', action: 'save' });
    expect(fc.sent).toHaveLength(1);
    expect(fc.edited).toHaveLength(1);
    expect(fc.messages.get(rec!.messageId)!.embeds[0]!.title).toBe('Rules v2');
    expect((await services.panels.get(rec!.messageId))?.title).toBe('Rules v2');
    // delete needs the box ticked
    await post(`/panels/${rec!.messageId}`, { _csrf: token, action: 'delete' });
    expect(fc.deleted).toHaveLength(0);
    await post(`/panels/${rec!.messageId}`, { _csrf: token, action: 'delete', confirm: '1' });
    expect(fc.deleted).toEqual([rec!.messageId]);
    expect(await services.panels.list()).toHaveLength(0);
  });

  it('panels: adds one already in Discord, only if the bot posted it', async () => {
    const { signIn, csrf, post, req, services, fc } = await start();
    await signIn();
    const ch = await fc.client.channels.fetch('800000000000000001');
    const old = await ch.send({ embeds: [{ title: 'Old rules', description: 'Be kind.', color: 1 }] });
    const token = await csrf('/panels');
    const res = await post('/panels', { _csrf: token, action: 'adopt', link: `https://discord.com/channels/${IDS.guild}/800000000000000001/${old.id}` });
    expect(res.headers.get('location')).toBe(`/panels/${old.id}`);
    expect((await services.panels.get(old.id))?.title).toBe('Old rules');
    expect(await (await req(`/panels/${old.id}`)).text()).toContain('Be kind.');
    old.author.id = '1';
    await services.panels.remove(old.id);
    await post('/panels', { _csrf: token, action: 'adopt', link: `https://discord.com/channels/${IDS.guild}/800000000000000001/${old.id}` });
    expect(await services.panels.get(old.id)).toBeNull();
    expect(await (await req('/panels')).text()).toContain('wasn’t posted by the bot');
  });

  it('shows waiting posts on the Approvals tab and rejects from there', async () => {
    const { signIn, csrf, post, req, services } = await start();
    await signIn();
    await services.posts.put({
      id: 'abc123', guildId: IDS.guild, channelId: '800000000000000001', authorId: IDS.staffUser, createdAt: Date.now() - 60_000, status: 'pending',
      draft: { type: 'post', kind: 'recruitment', title: 'Join the <b>Grenadiers</b>', body: 'We are recruiting.', buttons: [{ label: 'Apply', url: 'javascript:alert(1)' }], colour: 1, ping: { kind: 'here' } },
    });
    const page = await (await req('/approvals')).text();
    expect(page).toContain('Join the &lt;b&gt;Grenadiers&lt;/b&gt;');
    expect(page).toContain('We are recruiting.');
    expect(page).toContain('@here');
    expect(page).not.toContain('javascript:alert');
    expect(page).toMatch(/class="count">1</); // the sidebar count
    const token = await csrf('/approvals');
    const res = await post('/approvals', { _csrf: token, action: 'decide', id: 'abc123', decision: 'reject', reason: 'Too long' });
    expect(res.headers.get('location')).toBe('/approvals');
    expect((await services.posts.get('abc123'))?.status).toBe('rejected');
    const after = await (await req('/approvals')).text();
    expect(after).toContain('All caught up');
    expect(after).toContain('Rejected');
  });

  it('shows the in-game admin log with linked Discord accounts, filters and CSV', async () => {
    const { signIn, req, services } = await start();
    await signIn();
    await services.links.linkVerified(IDS.staffUser, { id: 99, name: 'Pte_Target' }, 'game');
    await services.links.linkVerified(IDS.otherUser, { id: 77, name: 'Sgt_Renamed' }, 'game'); // matched by the staff list's user id
    const page = await (await req('/game-log')).text();
    expect(page).toContain('Pte_Target');
    expect(page).toContain(IDS.staffUser);
    expect(page).toContain(IDS.otherUser);
    expect(page).toContain('via Discord');
    expect(page).toContain('Game (automatic)');
    expect(page).toContain('spawn killing');
    expect((await services.adminLog.list()).length).toBe(4);

    const kicks = await (await req('/game-log?cmd=kick')).text();
    expect(kicks).toContain('spawn killing');
    expect(kicks).not.toContain('griefing');
    const fromDiscord = await (await req('/game-log?src=discord')).text();
    expect(fromDiscord).toContain('griefing');
    expect(fromDiscord).not.toContain('spawn killing');

    const csv = await req('/game-log.csv');
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const text = await csv.text();
    const lines = text.split(String.fromCharCode(13, 10));
    expect(lines[0]).toBe('time_utc,roblox_name,roblox_id,discord_id,command,text,run_from');
    expect(text).toContain(`Pte_Target,99,${IDS.staffUser},kick,;kick Pte_X spawn killing,game`);
    expect(lines.find((l) => l.includes('announce'))).toContain(',announce,;announce =cmd|hello,game');
  });
});
