import type { BotConfig } from '../config.js';
import type { GuildSettingsStore } from '../guilds/settings.js';
import type { LinkService } from '../linking/service.js';
import type { Logger } from '../logger.js';
import type { GroupsClient } from '../roblox/groups.js';
import { TtlCache } from '../util/cache.js';
import { highest, tierFromArmyRank, tierFromDiscord, type Tier, type TierSource } from './tiers.js';

export interface MemberInfo {
  discordId: string;
  roleIds: Iterable<string>;
  /** the server the command was used in; its /setup staff roles count there */
  guildId?: string | null;
}

export interface ResolvedTier extends TierSource {
  /** the Roblox account linked to this member, if any */
  robloxId?: number;
  robloxName?: string;
}

/**
 * Works out a Discord member's staff tier, mirroring HKAdmin's levelOf: the highest of their
 * Discord staff roles, the owner list, and (if TIER_FROM_ROBLOX_RANK) their linked account's
 * army rank / ownership of the Canada 1940s group. Cached for a minute per member.
 */
export class PermissionResolver {
  private readonly cache = new TtlCache<string, ResolvedTier>(60_000, 2000);

  constructor(
    private readonly config: BotConfig,
    private readonly deps: { links: LinkService; groups: GroupsClient; guilds?: GuildSettingsStore; logger?: Logger },
  ) {}

  async resolve(member: MemberInfo): Promise<ResolvedTier> {
    const roles = [...member.roleIds];
    const key = `${member.guildId ?? '-'}:${member.discordId}:${roles.sort().join(',')}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const serverRoles = member.guildId && this.deps.guilds ? (await this.deps.guilds.get(member.guildId)).staffRoles : {};
    const fromDiscord = tierFromDiscord(member.discordId, roles, this.config.permissions, serverRoles);
    const link = await this.deps.links.get(member.discordId);
    let result: ResolvedTier = { ...fromDiscord };
    if (link) {
      result.robloxId = link.robloxId;
      result.robloxName = link.robloxName;
      if (this.config.permissions.tierFromRobloxRank && fromDiscord.tier < 5) {
        try {
          const [army, owner] = await Promise.all([
            this.deps.groups.rankIn(this.config.roblox.armyGroupId, link.robloxId),
            this.deps.groups.rankIn(this.config.roblox.ownerGroupId, link.robloxId),
          ]);
          const fromRank = tierFromArmyRank(army.rank, owner.rank, this.config.permissions.armyRankTiers, this.config.roblox.ownerRank);
          result = { ...highest(fromDiscord, fromRank), robloxId: link.robloxId, robloxName: link.robloxName };
        } catch (err) {
          // Roblox being down must not lock staff out of the Discord-role tier
          this.deps.logger?.warn({ err, discordId: member.discordId }, 'rank lookup failed; using Discord roles only');
        }
      }
    }
    this.cache.set(key, result);
    return result;
  }

  /** The tier a Roblox user would have in game from rank alone (used to stop kicking/banning someone senior). */
  async robloxUserTier(robloxId: number): Promise<Tier> {
    try {
      const [army, owner] = await Promise.all([
        this.deps.groups.rankIn(this.config.roblox.armyGroupId, robloxId),
        this.deps.groups.rankIn(this.config.roblox.ownerGroupId, robloxId),
      ]);
      return tierFromArmyRank(army.rank, owner.rank, this.config.permissions.armyRankTiers, this.config.roblox.ownerRank).tier;
    } catch {
      return 0;
    }
  }

  /** Drop cached tiers (after /link, or after /setup changes a server's staff roles). */
  forget(discordId?: string): void {
    // cheap and rare: drop everything rather than track keys per member
    void discordId;
    this.cache.clear();
  }
}
