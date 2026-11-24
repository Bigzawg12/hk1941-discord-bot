import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type APIInteractionGuildMember,
} from 'discord.js';
import type { BridgeActor } from '../bridge/schema.js';
import { TIER_NAMES, type Tier } from '../permissions/tiers.js';
import type { RobloxUser } from '../roblox/users.js';
import type { CommandContext } from '../types.js';
import { UserFacingError } from '../util/errors.js';

export const COLOURS = {
  khaki: 0x8a7a4a,
  ok: 0x3b7d3b,
  warn: 0xc08a2a,
  bad: 0xa33b3b,
  info: 0x3a5f8a,
} as const;

/** Role IDs from either a cached GuildMember or the raw API member Discord sends with an interaction. */
export function memberRoleIds(member: GuildMember | APIInteractionGuildMember | null | undefined): string[] {
  if (!member) return [];
  const roles = (member as { roles: unknown }).roles;
  if (Array.isArray(roles)) return roles as string[];
  const cache = (roles as { cache?: Map<string, unknown> } | undefined)?.cache;
  return cache ? [...cache.keys()] : [];
}

/**
 * The Roblox account a command is about: the `user` option (username, ID or profile link), else the
 * linked account of the `member` option, else (when allowed) the caller's own linked account.
 */
export async function resolveRobloxTarget(
  ctx: CommandContext<ChatInputCommandInteraction>,
  { userOption = 'user', memberOption = 'member', allowSelf = true } = {},
): Promise<{ user: RobloxUser; isSelf: boolean }> {
  const { interaction, services } = ctx;
  const query = interaction.options.getString(userOption);
  if (query) {
    const user = await services.users.resolve(query);
    if (!user) throw new UserFacingError(`No Roblox user called "${query.slice(0, 40)}".`);
    return { user, isSelf: user.id === ctx.caller.robloxId };
  }
  const member = interaction.options.getUser(memberOption);
  if (member) {
    const link = await services.links.get(member.id);
    if (!link) throw new UserFacingError(`${member.username} hasn't linked a Roblox account (/link).`);
    const user = await services.users.getById(link.robloxId);
    if (!user) throw new UserFacingError('Their linked Roblox account no longer exists.');
    return { user, isSelf: member.id === interaction.user.id };
  }
  if (!allowSelf) throw new UserFacingError('Say which Roblox user.');
  if (!ctx.caller.robloxId) throw new UserFacingError('Give a Roblox username, or link your own account with /link start.');
  const user = await services.users.getById(ctx.caller.robloxId);
  if (!user) throw new UserFacingError('Your linked Roblox account no longer exists. Link again with /link start.');
  return { user, isSelf: true };
}

/**
 * The staff member as the game will see them. Live actions need a linked Roblox account: the game
 * filters staff text under that account (Roblox rules) and logs it as the actor.
 */
export function requireActor(ctx: CommandContext<ChatInputCommandInteraction | ButtonInteraction>): BridgeActor {
  const { caller, interaction } = ctx;
  if (!caller.robloxId || !caller.robloxName) {
    throw new UserFacingError('Link your Roblox account first (/link start). In-game actions are filtered and logged under it.');
  }
  return { d: interaction.user.id, r: caller.robloxId, n: caller.robloxName, t: caller.tier };
}

export function needTier(ctx: CommandContext<unknown>, tier: Tier, what: string): void {
  if (ctx.caller.tier < tier) throw new UserFacingError(`${what} needs ${TIER_NAMES[tier]} or above.`);
}

export const ephemeral = { flags: MessageFlags.Ephemeral } as const;

/** Cut text to Discord's field limit. */
export function clip(text: string, max = 1024): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/** Escape Discord markdown in user-provided text. */
export function esc(text: string): string {
  return text.replace(/([\\*_`~|>])/g, '\\$1');
}
