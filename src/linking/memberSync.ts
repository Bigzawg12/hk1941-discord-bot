import type { Client, Guild, GuildMember } from 'discord.js';
import type { GuildSettings } from '../guilds/settings.js';
import type { UserRank } from '../roblox/groups.js';
import type { Services } from '../types.js';
import { mapLimit } from '../util/cache.js';
import type { AccountLink } from './store.js';

/**
 * Bloxlink-style updates: once someone is linked, every server the bot shares with them gives them
 * its verified role, the roles bound to their Roblox group ranks, and a nickname from the server's
 * template. Unlinked members lose those roles and get the unverified role instead.
 */

export interface MemberPlan {
  add: string[];
  remove: string[];
  /** undefined: leave the nickname alone */
  nickname?: string;
}

export const NICKNAME_TOKENS = ['{roblox}', '{display}', '{rank}', '{discord}'] as const;

export function renderNickname(
  template: string,
  v: { roblox: string; display?: string; rank?: string; discord?: string },
): string {
  const out = template
    .replace(/\{roblox\}/g, v.roblox)
    .replace(/\{display\}/g, v.display || v.roblox)
    .replace(/\{rank\}/g, v.rank || '')
    .replace(/\{discord\}/g, v.discord || '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s|·-]+|[\s|·-]+$/g, '')
    .trim();
  return out.slice(0, 32);
}

export function planMember(
  settings: Pick<GuildSettings, 'verifiedRoleId' | 'unverifiedRoleId' | 'nicknameTemplate' | 'rankBinds'>,
  link: Pick<AccountLink, 'robloxName'> | null,
  ranks: UserRank[],
  has: Iterable<string>,
  names: { display?: string; rankName?: string; discord?: string } = {},
): MemberPlan {
  const current = new Set(has);
  const want = new Set<string>();
  const drop = new Set<string>();
  const binds = settings.rankBinds ?? [];
  if (link) {
    if (settings.verifiedRoleId) want.add(settings.verifiedRoleId);
    if (settings.unverifiedRoleId) drop.add(settings.unverifiedRoleId);
    for (const b of binds) {
      const rank = ranks.find((r) => r.groupId === b.groupId)?.rank ?? 0;
      if (rank >= b.min && rank <= b.max) want.add(b.roleId);
      else drop.add(b.roleId);
    }
  } else {
    if (settings.verifiedRoleId) drop.add(settings.verifiedRoleId);
    if (settings.unverifiedRoleId) want.add(settings.unverifiedRoleId);
    for (const b of binds) drop.add(b.roleId);
  }
  for (const r of want) drop.delete(r); // two binds for one role: having either keeps it
  const plan: MemberPlan = {
    add: [...want].filter((r) => !current.has(r)),
    remove: [...drop].filter((r) => current.has(r)),
  };
  if (link && settings.nicknameTemplate?.trim()) {
    plan.nickname = renderNickname(settings.nicknameTemplate, { roblox: link.robloxName, display: names.display, rank: names.rankName, discord: names.discord });
  }
  return plan;
}

export interface SyncResult {
  guildId: string;
  guildName: string;
  added: string[];
  removed: string[];
  nickname?: string;
  /** things the bot wasn't allowed to do */
  problems: string[];
}

async function memberOf(guild: Guild, discordId: string): Promise<GuildMember | null> {
  try {
    return await guild.members.fetch(discordId);
  } catch {
    return null;
  }
}

/** Update one member in one server. Null when they aren't in it. */
export async function syncMember(services: Services, client: Client, guildId: string, discordId: string, reason: string): Promise<SyncResult | null> {
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return null;
  const member = await memberOf(guild, discordId);
  if (!member) return null;
  const settings = await services.guilds.get(guildId);
  // VERIFIED_ROLE_ID from .env still counts in the server it belongs to
  const fallback = services.config.discord.verifiedRoleId;
  if (!settings.verifiedRoleId && fallback && guild.roles.cache.has(fallback)) settings.verifiedRoleId = fallback;

  const link = await services.links.get(discordId);
  const problems: string[] = [];
  let ranks: UserRank[] = [];
  let display: string | undefined;
  if (link) {
    try {
      ranks = await services.groups.userRanks(link.robloxId, { fresh: true });
    } catch (err) {
      services.logger.warn({ err, robloxId: link.robloxId }, 'could not read group ranks for an update');
      problems.push("Couldn't read Roblox group ranks right now, so rank roles weren't changed.");
      settings.rankBinds = [];
    }
    if (settings.nicknameTemplate?.includes('{display}')) display = (await services.users.getById(link.robloxId).catch(() => null))?.displayName;
  }
  const rankName = ranks.find((r) => r.groupId === services.config.roblox.armyGroupId)?.roleName;
  const plan = planMember(settings, link, ranks, member.roles.cache.keys(), {
    display,
    rankName: rankName && rankName !== 'Guest' ? rankName : undefined,
    discord: member.user.username,
  });

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const top = me?.roles.highest.position ?? 0;
  const canManage = (roleId: string) => {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      problems.push(`A role set up here no longer exists (${roleId}).`);
      return false;
    }
    if (role.managed || role.position >= top || !me?.permissions.has('ManageRoles')) {
      problems.push(`I can't give or take <@&${roleId}>: move my role above it and give me Manage Roles.`);
      return false;
    }
    return true;
  };
  const add = plan.add.filter(canManage);
  const remove = plan.remove.filter(canManage);
  try {
    if (add.length) await member.roles.add(add, reason);
    if (remove.length) await member.roles.remove(remove, reason);
  } catch (err) {
    services.logger.warn({ err, guildId, discordId }, 'role update failed');
    problems.push('Discord refused a role change.');
  }

  let nickname: string | undefined;
  if (plan.nickname !== undefined && plan.nickname !== (member.nickname ?? member.user.globalName ?? member.user.username)) {
    if (member.id === guild.ownerId) problems.push("Discord doesn't let bots change the server owner's nickname.");
    else if (!me?.permissions.has('ManageNicknames') || member.roles.highest.position >= top) problems.push("I can't change this nickname: give me Manage Nicknames and move my role above theirs.");
    else {
      try {
        await member.setNickname(plan.nickname, reason);
        nickname = plan.nickname;
      } catch (err) {
        services.logger.warn({ err, guildId, discordId }, 'nickname update failed');
        problems.push('Discord refused the nickname change.');
      }
    }
  }
  return { guildId, guildName: guild.name, added: add, removed: remove, nickname, problems };
}

/** Update someone in every server the bot shares with them (after linking or unlinking). */
export async function syncEverywhere(services: Services, client: Client, discordId: string, reason: string): Promise<SyncResult[]> {
  const ids = [...client.guilds.cache.keys()];
  const results = await mapLimit(ids, 3, (id) => syncMember(services, client, id, discordId, reason).catch((err) => {
    services.logger.warn({ err, guildId: id }, 'member update failed');
    return null;
  }));
  return results.filter((r): r is SyncResult => !!r);
}

/** One line per server for a reply. */
export function describeSync(results: SyncResult[]): string {
  if (!results.length) return '';
  return results
    .map((r) => {
      const bits = [
        r.added.length ? `+${r.added.map((id) => `<@&${id}>`).join(' ')}` : '',
        r.removed.length ? `−${r.removed.map((id) => `<@&${id}>`).join(' ')}` : '',
        r.nickname ? `nickname “${r.nickname}”` : '',
      ].filter(Boolean);
      const line = `**${r.guildName}**: ${bits.join(', ') || 'already up to date'}`;
      return r.problems.length ? `${line}\n  ⚠️ ${r.problems.join(' ')}` : line;
    })
    .join('\n');
}
