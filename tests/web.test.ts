import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDashboard } from '../src/web/server.js';
import { fakeClient, IDS, testServices } from './helpers/fixtures.js';
import { json } from './helpers/mockFetch.js';
import { fakeGuild } from './helpers/guild.js';

const ADMIN = '123456789012345678';
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
    ],
    WEB_ENV,
  );
  const fc = fakeClient();
  const { guild } = fakeGuild();
  fc.client.guilds.cache.set(IDS.guild, guild);
  const dash = createDashboard({ services, client: () => fc.client as never, fetch: discordFetch(who) as never });
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
    const page = await (await req(`/servers/${IDS.guild}`)).text();
    expect(page).toContain('HK1941 Test');
    expect(page).toContain('5 Corporal');
    await post(`/servers/${IDS.guild}`, { _csrf: token, action: 'bind', roleId: '700000000000000003', min: '5', max: '6', groupId: '409406376' });
    await post(`/servers/${IDS.guild}`, { _csrf: token, action: 'channels', approvalChannelId: '800000000000000001', auditChannelId: 'not-a-channel' });
    const s = await services.guilds.get(IDS.guild);
    expect(s.rankBinds).toEqual([{ roleId: '700000000000000003', groupId: 409406376, min: 5, max: 6 }]);
    expect(s.approvalChannelId).toBe('800000000000000001');
    expect(s.auditChannelId).toBeUndefined(); // only channels in that server are accepted
    expect(await (await req(`/servers/${IDS.guild}`)).text()).toContain('Channels saved');
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
});
