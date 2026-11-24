import { describe, expect, it } from 'vitest';
import type { Interaction } from 'discord.js';
import { handleInteraction } from '../src/discord/dispatch.js';
import { loadCommands } from '../src/loaders/commands.js';
import { fakeInteraction, IDS, profileStoreValue, replyText, SAMPLE_PROFILE, testServices } from './helpers/fixtures.js';
import { json, type Route } from './helpers/mockFetch.js';

const UNIVERSE = 10772680614;
const ARMY = 409406376;

/** Roblox as these tests see it: one player (Pte_Target, 99) and one staff account (Maj_Test, 42). */
function robloxRoutes(extra: Route[] = []): Route[] {
  return [
    ...extra,
    [
      'POST',
      'users.roblox.com/v1/usernames/users',
      (_url, call) => {
        const name = (call.body as { usernames: string[] }).usernames[0]!.toLowerCase();
        const data = name === 'pte_target' ? [{ id: 99, name: 'Pte_Target', displayName: 'Target' }] : [];
        return json({ data });
      },
    ],
    ['GET', 'users.roblox.com/v1/users/99', json({ id: 99, name: 'Pte_Target', displayName: 'Target', description: '' })],
    ['GET', 'users.roblox.com/v1/users/42', json({ id: 42, name: 'Maj_Test', displayName: 'Major', description: '' })],
    ['GET', 'groups.roblox.com/v2/users/99/groups/roles', json({ data: [{ group: { id: ARMY }, role: { id: 2, name: 'Private', rank: 2 } }] })],
    ['GET', 'groups.roblox.com/v2/users/42/groups/roles', json({ data: [{ group: { id: ARMY }, role: { id: 11, name: 'Major', rank: 11 } }] })],
    ['GET', 'thumbnails.roblox.com', json({ data: [{ targetId: 99, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/x.png' }] })],
    [
      'GET',
      `datastores/v1/universes/${UNIVERSE}/standard-datastores/datastore/entries/entry`,
      (url) =>
        url.searchParams.get('entryKey') === 'u99'
          ? json(profileStoreValue(SAMPLE_PROFILE))
          : json({ error: 'NOT_FOUND' }, 404),
    ],
  ];
}

async function setup(routes: Route[], env: Record<string, string> = {}) {
  const { services, calls } = testServices(robloxRoutes(routes), env);
  services.commands = await loadCommands();
  return { services, calls };
}

async function linkStaff(services: Awaited<ReturnType<typeof setup>>['services']) {
  // as if /link verify had already run for the staff member
  await (services.links as unknown as { deps: { store: { set(l: unknown): Promise<void> } } }).deps.store.set({
    discordId: IDS.staffUser,
    robloxId: 42,
    robloxName: 'Maj_Test',
    method: 'blurb',
    linkedAt: 0,
  });
}

describe('/record', () => {
  it('shows points, next rank and medals from the profile', async () => {
    const { services } = await setup([]);
    const { interaction, replies } = fakeInteraction({ commandName: 'record', strings: { user: 'Pte_Target' }, roles: [IDS.modRole] });
    await handleInteraction(services, interaction as unknown as Interaction);
    const text = replyText(replies.at(-1));
    expect(text).toContain('203 points');
    expect(text).toContain('Corporal');
    expect(text).toContain('ELIGIBLE');
    expect(text).toContain('Military Cross');
    expect(text).toContain('Marksman');
    expect(text).toContain('Arrests on record: 1'); // Moderators see the MP line
  });

  it("stops non-staff reading someone else's record", async () => {
    const { services } = await setup([]);
    const { interaction, replies } = fakeInteraction({ commandName: 'record', strings: { user: 'Pte_Target' } });
    await handleInteraction(services, interaction as unknown as Interaction);
    expect(replyText(replies.at(-1))).toMatch(/needs Trial Moderator/);
  });

  it('says so when someone has no record', async () => {
    const { services } = await setup([]);
    const { interaction, replies } = fakeInteraction({ commandName: 'record', strings: { user: '42' }, roles: [IDS.modRole] });
    await handleInteraction(services, interaction as unknown as Interaction);
    expect(replyText(replies.at(-1))).toMatch(/no service record yet/);
  });
});

describe('dispatcher', () => {
  it('refuses commands above the caller tier', async () => {
    const { services, calls } = await setup([]);
    const { interaction, replies } = fakeInteraction({ commandName: 'ban', strings: { user: 'Pte_Target', duration: '1d' }, roles: [IDS.modRole] });
    await handleInteraction(services, interaction as unknown as Interaction);
    expect(replyText(replies.at(-1))).toBe('/ban needs Senior Moderator (3) or above.');
    expect(calls).toHaveLength(0);
  });

  it('turns Roblox API failures into a short message with a reference', async () => {
    const { services } = await setup([['GET', 'datastores/v1/', json({ message: 'Invalid API Key' }, 403)]]);
    const { interaction, replies } = fakeInteraction({ commandName: 'record', strings: { user: 'Pte_Target' }, roles: [IDS.modRole] });
    await handleInteraction(services, interaction as unknown as Interaction);
    expect(replyText(replies.at(-1))).toMatch(/Roblox refused the request .*\(ref [0-9a-f]{6}\)/);
  });
});

describe('live actions', () => {
  const PUBLISH = `messaging-service/v1/universes/${UNIVERSE}/topics/HK1941Discord`;

  it('/ban needs a linked account before anything is sent', async () => {
    const { services, calls } = await setup([]);
    const { interaction, replies } = fakeInteraction({ commandName: 'ban', strings: { user: 'Pte_Target', duration: '1d' }, roles: [IDS.seniorRole] });
    await handleInteraction(services, interaction as unknown as Interaction);
    expect(replyText(replies.at(-1))).toMatch(/Link your Roblox account first/);
    expect(calls.some((c) => c.url.includes(PUBLISH))).toBe(false);
  });

  it('/ban holds Senior Moderators to 7 days', async () => {
    const { services } = await setup([]);
    await linkStaff(services);
    const { interaction, replies } = fakeInteraction({ commandName: 'ban', strings: { user: 'Pte_Target', duration: 'perm' }, roles: [IDS.seniorRole] });
    await handleInteraction(services, interaction as unknown as Interaction);
    expect(replyText(replies.at(-1))).toMatch(/up to 7 days/);
  });

  it('/ban publishes to the bridge and reports the server answer', async () => {
    let sent: { act: string; tgt: number; by: { r: number; t: number }; a: { secs: number } } | undefined;
    const { services } = await setup(
      [
        [
          'POST',
          PUBLISH,
          (_u, call) => {
            sent = JSON.parse((call.body as { message: string }).message);
            return json({});
          },
        ],
        ['GET', 'memory-store/sorted-maps/HK1941_DiscordBridge/items/', () => json({ value: { s: 'done', ok: true, m: 'Banned Pte_Target until 25 Nov 2026 18:00 UTC.', job: 'job12345678' } })],
      ],
      { TIER_FROM_ROBLOX_RANK: 'false' },
    );
    await linkStaff(services);
    const { interaction, replies } = fakeInteraction({ commandName: 'ban', strings: { user: 'Pte_Target', duration: '1d', reason: 'spawn killing' }, roles: [IDS.seniorRole] });
    await handleInteraction(services, interaction as unknown as Interaction);
    expect(sent).toMatchObject({ act: 'ban', tgt: 99, by: { r: 42, t: 3 }, a: { secs: 86400 } });
    expect(replyText(replies.at(-1))).toMatch(/✓ Banned Pte_Target/);
  });

  it('/points caps Moderators at 50', async () => {
    const { services } = await setup([]);
    await linkStaff(services);
    const { interaction, replies } = fakeInteraction({ commandName: 'points', sub: 'add', strings: { user: 'Pte_Target' }, integers: { amount: 80 }, roles: [IDS.modRole] });
    await handleInteraction(services, interaction as unknown as Interaction);
    expect(replyText(replies.at(-1))).toMatch(/up to 50 at a time/);
  });
});

describe('/setup', () => {
  const newRole = { id: '888888888888888888', name: 'Staff' };

  it('lets an owner map a role, which then counts in this server', async () => {
    const { services } = await setup([], { OWNER_DISCORD_IDS: IDS.otherUser });
    const { interaction, replies } = fakeInteraction({ commandName: 'setup', sub: 'staff-role', userId: IDS.otherUser, discordRoles: { role: newRole }, integers: { tier: 3 } });
    await handleInteraction(services, interaction as unknown as Interaction);
    expect(replyText(replies.at(-1))).toMatch(/Senior Moderator \(3\) in this server/);
    expect((await services.guilds.get(IDS.guild)).staffRoles[newRole.id]).toBe(3);
    const tier = await services.permissions.resolve({ discordId: IDS.staffUser, roleIds: [newRole.id], guildId: IDS.guild });
    expect(tier.tier).toBe(3);
  });

  it('is refused below Administrator, so a server admin cannot make themselves game staff', async () => {
    const { services } = await setup([]);
    const { interaction, replies } = fakeInteraction({ commandName: 'setup', sub: 'staff-role', discordRoles: { role: newRole }, integers: { tier: 5 }, roles: [IDS.seniorRole] });
    await handleInteraction(services, interaction as unknown as Interaction);
    expect(replyText(replies.at(-1))).toMatch(/needs Administrator \(4\)/);
    expect((await services.guilds.get(IDS.guild)).staffRoles).toEqual({});
  });

  it('only lets Administrators give tiers below their own', async () => {
    const { services } = await setup([], { TIER4_ROLE_IDS: '777777777777777777' });
    const run = async (tier: number) => {
      const { interaction, replies } = fakeInteraction({ commandName: 'setup', sub: 'staff-role', discordRoles: { role: newRole }, integers: { tier }, roles: ['777777777777777777'] });
      await handleInteraction(services, interaction as unknown as Interaction);
      return replyText(replies.at(-1));
    };
    expect(await run(4)).toMatch(/only give tiers below your own/);
    expect(await run(3)).toMatch(/now Senior Moderator/);
  });

  it('refuses @everyone', async () => {
    const { services } = await setup([], { OWNER_DISCORD_IDS: IDS.staffUser });
    const { interaction, replies } = fakeInteraction({ commandName: 'setup', sub: 'staff-role', discordRoles: { role: { id: IDS.guild, name: '@everyone' } }, integers: { tier: 1 } });
    await handleInteraction(services, interaction as unknown as Interaction);
    expect(replyText(replies.at(-1))).toMatch(/@everyone/);
  });

  it('sets the audit channel after a test post', async () => {
    const { services } = await setup([], { OWNER_DISCORD_IDS: IDS.staffUser });
    const { interaction, replies } = fakeInteraction({ commandName: 'setup', sub: 'audit-channel', channels: { channel: { id: '121212121212121212' } } });
    await handleInteraction(services, interaction as unknown as Interaction);
    expect(replyText(replies.at(-1))).toMatch(/posted in <#121212121212121212>/);
    expect((await services.guilds.get(IDS.guild)).auditChannelId).toBe('121212121212121212');
  });
});
