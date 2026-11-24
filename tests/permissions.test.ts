import { describe, expect, it, vi } from 'vitest';
import { PermissionResolver } from '../src/permissions/resolver.js';
import { banCapProblem, highest, requiredTier, tierFromArmyRank, tierFromDiscord } from '../src/permissions/tiers.js';
import type { LinkService } from '../src/linking/service.js';
import type { GroupsClient } from '../src/roblox/groups.js';
import { IDS, testConfig } from './helpers/fixtures.js';

const rankTiers = testConfig().permissions.armyRankTiers;

describe('tiers', () => {
  it('maps Discord roles to the highest matching tier', () => {
    const perms = testConfig().permissions;
    expect(tierFromDiscord(IDS.staffUser, [], perms).tier).toBe(0);
    expect(tierFromDiscord(IDS.staffUser, [IDS.modRole], perms).tier).toBe(2);
    expect(tierFromDiscord(IDS.staffUser, [IDS.modRole, IDS.seniorRole], perms).tier).toBe(3);
  });

  it('gives owners tier 5 from the owner list', () => {
    const perms = testConfig({ OWNER_DISCORD_IDS: IDS.staffUser }).permissions;
    expect(tierFromDiscord(IDS.staffUser, [], perms)).toMatchObject({ tier: 5, why: 'owner list' });
  });

  it('mirrors HKAdmin army ranks: 5 Sgt=1, 9 Lt=2, 11 Maj=3, 13 Col=4, group owner=5', () => {
    expect(tierFromArmyRank(4, 0, rankTiers, 255).tier).toBe(0);
    expect(tierFromArmyRank(5, 0, rankTiers, 255).tier).toBe(1);
    expect(tierFromArmyRank(10, 0, rankTiers, 255).tier).toBe(2);
    expect(tierFromArmyRank(11, 0, rankTiers, 255).tier).toBe(3);
    expect(tierFromArmyRank(200, 0, rankTiers, 255).tier).toBe(4);
    expect(tierFromArmyRank(0, 255, rankTiers, 255).tier).toBe(5);
  });

  it('picks the highest source', () => {
    expect(highest({ tier: 2, why: 'a' }, { tier: 3, why: 'b' }, { tier: 1, why: 'c' }).why).toBe('b');
  });

  it('works out the tier a command needs, with overrides', () => {
    const cmd = { data: { name: 'event' }, tier: 0 as const, subTiers: { schedule: 2 as const } };
    expect(requiredTier(cmd, 'list', {})).toBe(0);
    expect(requiredTier(cmd, 'schedule', {})).toBe(2);
    expect(requiredTier(cmd, 'schedule', { event: 4 })).toBe(4); // a command-wide override covers every subcommand
    expect(requiredTier(cmd, 'schedule', { event: 4, 'event.schedule': 3 })).toBe(3);
    expect(requiredTier(cmd, 'list', { 'event.schedule': 3 })).toBe(0);
    expect(requiredTier(cmd, null, { event: 1 })).toBe(1);
  });

  it('caps Senior Moderator bans at 7 days like HKAdminConfig.BanCaps', () => {
    expect(banCapProblem(3, 7 * 86400)).toBeNull();
    expect(banCapProblem(3, 8 * 86400)).toMatch(/up to 7 days/);
    expect(banCapProblem(3, 0)).toMatch(/up to 7 days/);
    expect(banCapProblem(4, 0)).toBeNull();
  });
});

describe('PermissionResolver', () => {
  const link = { discordId: IDS.staffUser, robloxId: 42, robloxName: 'Sgt_Test', method: 'blurb' as const, linkedAt: 0 };

  it('raises the tier from the linked account army rank', async () => {
    const links = { get: vi.fn(async () => link) } as unknown as LinkService;
    const groups = {
      rankIn: vi.fn(async (g: number) => ({ groupId: g, rank: g === 409406376 ? 11 : 0, roleId: 1, roleName: 'Major' })),
    } as unknown as GroupsClient;
    const r = new PermissionResolver(testConfig({ TIER_FROM_ROBLOX_RANK: 'true' }), { links, groups });
    const res = await r.resolve({ discordId: IDS.staffUser, roleIds: [IDS.modRole] });
    expect(res).toMatchObject({ tier: 3, robloxId: 42, robloxName: 'Sgt_Test' });
  });

  it('keeps the Discord tier when Roblox is down', async () => {
    const links = { get: vi.fn(async () => link) } as unknown as LinkService;
    const groups = { rankIn: vi.fn(async () => Promise.reject(new Error('down'))) } as unknown as GroupsClient;
    const r = new PermissionResolver(testConfig({ TIER_FROM_ROBLOX_RANK: 'true' }), { links, groups });
    expect((await r.resolve({ discordId: IDS.staffUser, roleIds: [IDS.modRole] })).tier).toBe(2);
  });

  it('does not look up ranks when TIER_FROM_ROBLOX_RANK is off', async () => {
    const links = { get: vi.fn(async () => link) } as unknown as LinkService;
    const groups = { rankIn: vi.fn() } as unknown as GroupsClient;
    const r = new PermissionResolver(testConfig(), { links, groups });
    expect((await r.resolve({ discordId: IDS.staffUser, roleIds: [] })).tier).toBe(0);
    expect(groups.rankIn).not.toHaveBeenCalled();
  });
});
