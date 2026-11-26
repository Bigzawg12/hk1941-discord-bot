import type { Interaction } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { handleInteraction } from '../src/discord/dispatch.js';
import { planMember, renderNickname, syncMember } from '../src/linking/memberSync.js';
import { GAME_CODE_TRIES, normaliseGameCode } from '../src/linking/service.js';
import { loadCommands } from '../src/loaders/commands.js';
import { fakeButton, fakeClient, fakeInteraction, fakeModal, IDS, replyText, testServices } from './helpers/fixtures.js';
import { CORPORAL, fakeGuild, OFFICER, UNVERIFIED, VERIFIED } from './helpers/guild.js';
import { json, type Route } from './helpers/mockFetch.js';

const ARMY = 409406376;

const ranks = (rank: number, name = 'Corporal'): Route => ['GET', 'groups.roblox.com/v2/users/99/groups/roles', json({ data: [{ group: { id: ARMY }, role: { id: 5, name, rank } }] })];

describe('member roles and nickname', () => {
  const settings = {
    verifiedRoleId: VERIFIED,
    unverifiedRoleId: UNVERIFIED,
    nicknameTemplate: '{rank} | {roblox}',
    rankBinds: [
      { roleId: CORPORAL, groupId: ARMY, min: 4, max: 6 },
      { roleId: OFFICER, groupId: ARMY, min: 10, max: 255 },
    ],
  };

  it('gives verified and rank roles, takes the unverified role, and names them', () => {
    const plan = planMember(settings, { robloxName: 'Pte_Target' }, [{ groupId: ARMY, rank: 5, roleId: 1, roleName: 'Corporal' }], [UNVERIFIED, OFFICER], { rankName: 'Corporal' });
    expect(plan.add.sort()).toEqual([CORPORAL, VERIFIED].sort());
    expect(plan.remove.sort()).toEqual([OFFICER, UNVERIFIED].sort());
    expect(plan.nickname).toBe('Corporal | Pte_Target');
  });

  it('takes everything back when unlinked and leaves nicknames alone', () => {
    const plan = planMember(settings, null, [], [VERIFIED, CORPORAL]);
    expect(plan.add).toEqual([UNVERIFIED]);
    expect(plan.remove.sort()).toEqual([CORPORAL, VERIFIED].sort());
    expect(plan.nickname).toBeUndefined();
  });

  it('keeps nicknames inside 32 characters and tidy without a rank', () => {
    expect(renderNickname('{rank} | {roblox}', { roblox: 'Pte_Target' })).toBe('Pte_Target');
    expect(renderNickname('{roblox} {display}', { roblox: 'A'.repeat(20), display: 'B'.repeat(20) })).toHaveLength(32);
  });

  it('changes roles and nickname in a real server, skipping roles above the bot', async () => {
    const { services } = testServices([ranks(5)]);
    await services.links.linkVerified(IDS.staffUser, { id: 99, name: 'Pte_Target' }, 'manual');
    await services.guilds.update(IDS.guild, 't', (s) => Object.assign(s, settings));
    const fc = fakeClient();
    const { guild, member } = fakeGuild([UNVERIFIED], { botTop: 7 }); // the bot sits below CORPORAL(7) and OFFICER(8)
    fc.client.guilds.cache.set(IDS.guild, guild);
    const r = await syncMember(services, fc.client as never, IDS.guild, IDS.staffUser, 'test');
    expect(r?.added).toEqual([VERIFIED]);
    expect(r?.removed).toEqual([UNVERIFIED]);
    expect(r?.problems.join(' ')).toMatch(/move my role above/);
    expect(member.nickname).toBe('Corporal | Pte_Target');
  });
});

describe('/verify', () => {
  it('profile phrase (with in-game verify off): username, phrase, Done', async () => {
    let about = '';
    const { services } = testServices([
      ['POST', 'users.roblox.com/v1/usernames/users', json({ data: [{ id: 99, name: 'Pte_Target', displayName: 'Target' }] })],
      ['GET', 'users.roblox.com/v1/users/99', () => json({ id: 99, name: 'Pte_Target', displayName: 'Target', description: about })],
      ranks(5),
    ], { GAME_VERIFY: 'false' });
    services.commands = await loadCommands();
    await services.guilds.update(IDS.guild, 't', (s) => {
      s.verifiedRoleId = VERIFIED;
      s.rankBinds = [{ roleId: CORPORAL, groupId: ARMY, min: 5, max: 5 }];
    });
    const fc = fakeClient();
    const { guild, member } = fakeGuild();
    fc.client.guilds.cache.set(IDS.guild, guild);
    const run = (i: unknown) => handleInteraction(services, i as Interaction);

    const cmd = fakeInteraction({ commandName: 'verify', client: fc });
    await run(cmd.interaction);
    expect((cmd.replies.at(-1) as { toJSON(): { custom_id: string } }).toJSON().custom_id).toBe('verify:username');

    const form = fakeModal({ customId: 'verify:username', fields: { username: 'Pte_Target' }, client: fc });
    await run(form.interaction);
    const text = replyText(form.replies.at(-1));
    const code = /hk1941(?: [a-z]+){4}/.exec(text)?.[0];
    expect(code).toBeTruthy();

    const early = fakeButton({ customId: 'verify:check', client: fc });
    await run(early.interaction);
    expect(replyText(early.replies.at(-1))).toMatch(/can't see the code/);

    about = `Hello! ${code}`;
    const done = fakeButton({ customId: 'verify:check', client: fc });
    await run(done.interaction);
    expect(replyText(done.replies.at(-1))).toContain('Verified as **Pte' + String.fromCharCode(92) + '_Target**');
    expect((await services.links.get(IDS.staffUser))?.robloxId).toBe(99);
    expect([...member.roles.cache.keys()].sort()).toEqual([CORPORAL, VERIFIED].sort());
  });

  it('shows linked members their account with an Update button', async () => {
    const { services } = testServices([]);
    services.commands = await loadCommands();
    await services.links.linkVerified(IDS.staffUser, { id: 99, name: 'Pte_Target' }, 'manual');
    const cmd = fakeInteraction({ commandName: 'verify' });
    await handleInteraction(services, cmd.interaction as unknown as Interaction);
    expect(replyText(cmd.replies.at(-1))).toContain('linked to **Pte' + String.fromCharCode(92) + '_Target**');
  });
});

describe('/update', () => {
  it('lets staff update someone else, but not members', async () => {
    const { services } = testServices([]);
    services.commands = await loadCommands();
    const cmd = fakeInteraction({ commandName: 'update', users: { member: { id: IDS.otherUser, username: 'x' } } });
    await handleInteraction(services, cmd.interaction as unknown as Interaction);
    expect(replyText(cmd.replies.at(-1))).toMatch(/needs Trial Moderator/);
    const staff = fakeInteraction({ commandName: 'update', users: { member: { id: IDS.otherUser, username: 'x' } }, roles: [IDS.modRole] });
    await handleInteraction(services, staff.interaction as unknown as Interaction);
    expect(replyText(staff.replies.at(-1))).toMatch(/not linked/);
  });
});

describe('/setup bind', () => {
  it("adds a rank bind, but won't bind a staff role", async () => {
    const { services } = testServices([], { OWNER_DISCORD_IDS: IDS.staffUser });
    services.commands = await loadCommands();
    const role = { id: CORPORAL, name: 'Corporal' };
    await handleInteraction(services, fakeInteraction({ commandName: 'setup', sub: 'bind', discordRoles: { role }, integers: { 'min-rank': 4, 'max-rank': 6 } }).interaction as unknown as Interaction);
    expect((await services.guilds.get(IDS.guild)).rankBinds).toEqual([{ roleId: CORPORAL, groupId: ARMY, min: 4, max: 6 }]);
    await services.guilds.update(IDS.guild, 't', (s) => {
      s.staffRoles[OFFICER] = 3;
    });
    const bad = fakeInteraction({ commandName: 'setup', sub: 'bind', discordRoles: { role: { id: OFFICER, name: 'Officer' } }, integers: { 'min-rank': 10 } });
    await handleInteraction(services, bad.interaction as unknown as Interaction);
    expect(replyText(bad.replies.at(-1))).toMatch(/staff role/);
  });
});

describe('verify in game', () => {
  const MAP = 'memory-store/sorted-maps/HK1941_Verify/items/';
  const codes: Record<string, unknown> = { v_QZTRKMPL: JSON.stringify({ u: 99, n: 'Pte_Target', d: 'Target', t: 1 }) };
  const routes: Route[] = [
    ['GET', MAP, (url) => {
      const key = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      return key in codes ? json({ id: key, value: codes[key] }) : json({ message: 'not found' }, 404);
    }],
    ranks(5),
  ];

  it('reads codes however they are typed', () => {
    expect(normaliseGameCode('qztr kmpl')).toBe('QZTRKMPL');
    expect(normaliseGameCode('QZTR-KMPL')).toBe('QZTRKMPL');
    expect(normaliseGameCode('QZTRKMP')).toBeNull();
    expect(normaliseGameCode('AZTRKMPL')).toBeNull(); // no vowels in real codes
  });

  it('Join game, /verify in game, Enter code: linked with roles', async () => {
    const { services } = testServices(routes);
    services.commands = await loadCommands();
    await services.guilds.update(IDS.guild, 't', (s) => {
      s.verifiedRoleId = VERIFIED;
    });
    const fc = fakeClient();
    const { guild, member } = fakeGuild();
    fc.client.guilds.cache.set(IDS.guild, guild);
    const run = (i: unknown) => handleInteraction(services, i as Interaction);

    const cmd = fakeInteraction({ commandName: 'verify', client: fc });
    await run(cmd.interaction);
    const first = JSON.stringify((cmd.replies.at(-1) as { components: { toJSON(): unknown }[] }).components.map((c) => c.toJSON()));
    expect(first).toContain('https://www.roblox.com/games/77901932829123');
    expect(first).toContain('verify:code');
    expect(first).toContain('verify:begin:phrase');

    const btn = fakeButton({ customId: 'verify:code', client: fc });
    await run(btn.interaction);
    expect((btn.replies.at(-1) as { toJSON(): { custom_id: string } }).toJSON().custom_id).toBe('verify:gamecode');

    const form = fakeModal({ customId: 'verify:gamecode', fields: { code: 'qztr kmpl' }, client: fc });
    await run(form.interaction);
    expect(replyText(form.replies.at(-1))).toContain('Verified as **Pte' + String.fromCharCode(92) + '_Target**');
    expect(await services.links.get(IDS.staffUser)).toMatchObject({ robloxId: 99, method: 'game' });
    expect(member.roles.cache.has(VERIFIED)).toBe(true);

    // a code works once
    const again = fakeModal({ customId: 'verify:gamecode', fields: { code: 'QZTRKMPL' }, userId: IDS.otherUser, client: fc });
    await run(again.interaction);
    expect(replyText(again.replies.at(-1))).toMatch(/already used/);
  });

  it('stops guessing after a few wrong codes', async () => {
    const { services } = testServices(routes);
    for (let i = 0; i < GAME_CODE_TRIES; i++) {
      await expect(services.links.verifyGameCode(IDS.otherUser, 'BBBBBBBB')).rejects.toThrow(/isn't right/);
    }
    await expect(services.links.verifyGameCode(IDS.otherUser, 'QZTRKMPL')).rejects.toThrow(/Too many wrong codes/);
  });
});

describe('game script and bot agree', () => {
  it('on the verify map name, code letters and length', async () => {
    const { readFile } = await import('node:fs/promises');
    const lua = await readFile(new URL('../roblox/DiscordBridge.server.luau', import.meta.url), 'utf8');
    const { services } = testServices([]);
    expect(lua).toContain(`local VERIFY_MAP = "${services.config.linking.verifyMap}"`);
    expect(lua).toContain('local CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ"');
    expect(lua).toMatch(/for i = 1, 8 do/);
    expect(lua).toContain('cmd.PrimaryAlias = "/verify"');
  });
});
