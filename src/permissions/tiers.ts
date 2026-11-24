import type { ArmyRankTier, BotConfig, TierNumber } from '../config.js';

/**
 * Staff tiers, the same numbers HKAdmin uses in game (ServerStorage.HKAdminConfig.Tiers).
 * A Discord member's tier is the highest of: their Discord roles, the owner list, and (optionally)
 * the army rank of their linked Roblox account, exactly like HKAdmin works out a player's level.
 */
export const Tier = {
  Everyone: 0,
  TrialModerator: 1,
  Moderator: 2,
  SeniorModerator: 3,
  Administrator: 4,
  Owner: 5,
} as const;
export type Tier = TierNumber;

export const TIER_NAMES: Record<Tier, string> = {
  0: 'Everyone',
  1: 'Trial Moderator',
  2: 'Moderator',
  3: 'Senior Moderator',
  4: 'Administrator',
  5: 'Owner',
};

export function tierLabel(t: Tier): string {
  return `${TIER_NAMES[t]} (${t})`;
}

/** Longest ban each tier may give, in seconds (HKAdminConfig.BanCaps). Tiers not listed have no cap. */
export const BAN_CAPS: Partial<Record<Tier, number>> = {
  3: 7 * 86400,
};

/** Can this tier give a ban of `seconds` (0 = permanent)? Returns the refusal text, or null if allowed. */
export function banCapProblem(tier: Tier, seconds: number): string | null {
  const cap = BAN_CAPS[tier];
  if (cap === undefined) return null;
  if (seconds === 0 || seconds > cap) {
    const days = Math.round((cap / 86400) * 10) / 10;
    return `${TIER_NAMES[tier]}s can ban for up to ${days} days. Ask an Administrator for longer.`;
  }
  return null;
}

const clampTier = (n: number): Tier => Math.max(0, Math.min(5, Math.floor(n))) as Tier;

export interface TierSource {
  tier: Tier;
  why: string;
}

/** Tier from the member's Discord roles and the owner list. */
export function tierFromDiscord(
  discordId: string,
  roleIds: Iterable<string>,
  perms: BotConfig['permissions'],
): TierSource {
  if (perms.ownerDiscordIds.includes(discordId)) return { tier: 5, why: 'owner list' };
  const roles = new Set(roleIds);
  for (const t of [5, 4, 3, 2, 1] as const) {
    const match = perms.roleTiers[t].find((r) => roles.has(r));
    if (match) return { tier: t, why: `Discord role ${match}` };
  }
  return { tier: 0, why: 'no staff role' };
}

/** Tier from army rank, like HKAdmin's levelOf (ArmyRanks, then OwnerGroup at OwnerRank = 5). */
export function tierFromArmyRank(
  armyRank: number,
  ownerGroupRank: number,
  rankTiers: ArmyRankTier[],
  ownerRank: number,
): TierSource {
  if (ownerGroupRank >= ownerRank) return { tier: 5, why: 'owns the Canada 1940s group' };
  let tier: Tier = 0;
  for (const rt of rankTiers) if (armyRank >= rt.rank && rt.tier > tier) tier = rt.tier;
  return { tier, why: tier > 0 ? `army rank ${armyRank}` : 'army rank below staff' };
}

export function highest(...sources: TierSource[]): TierSource {
  return sources.reduce((best, s) => (s.tier > best.tier ? s : best), { tier: 0 as Tier, why: 'none' });
}

/**
 * The tier a command (or one of its subcommands) needs. Order:
 * COMMAND_TIERS "name.subcommand" > COMMAND_TIERS "name" (whole command) > the command's own subTiers > its tier.
 */
export function requiredTier(
  command: { data: { name: string }; tier: Tier; subTiers?: Record<string, Tier> },
  subcommand: string | null,
  overrides: Record<string, Tier>,
): Tier {
  const name = command.data.name.toLowerCase();
  const sub = subcommand?.toLowerCase();
  if (sub && overrides[`${name}.${sub}`] !== undefined) return clampTier(overrides[`${name}.${sub}`]!);
  if (overrides[name] !== undefined) return clampTier(overrides[name]!);
  if (sub && command.subTiers?.[sub] !== undefined) return command.subTiers[sub]!;
  return command.tier;
}
