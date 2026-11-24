import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { clip, COLOURS, esc } from '../discord/helpers.js';
import { RANKS } from '../game/gameConfig.js';
import { standing } from '../game/points.js';
import { Tier } from '../permissions/tiers.js';
import type { GroupRole } from '../roblox/groups.js';
import { defineCommand, type Services } from '../types.js';
import { mapLimit, TtlCache } from '../util/cache.js';
import { UserFacingError } from '../util/errors.js';

interface Candidate {
  userId: number;
  rank: number;
  roleName: string;
  next: string;
  points: number;
  trainings: number;
}

interface Scan {
  ready: Candidate[];
  checked: number;
  capped: boolean;
  at: number;
}

const cache = new TtlCache<string, Scan>(10 * 60_000, 20);

/**
 * Unlike ;eligible in game (players on that server only), this checks the whole army group:
 * every member at a rank that has a next step in ServiceConfig.Ranks, reading each profile.
 * Capped by ELIGIBLE_MAX_PROFILES and cached for ELIGIBLE_CACHE_MIN.
 */
async function scan(services: Services, onlyRank: number | null): Promise<Scan> {
  const { config } = services;
  const roles: GroupRole[] = await services.groups.listRoles(config.roblox.armyGroupId);
  const wanted = roles.filter((r) => RANKS[r.rank] && (onlyRank === null || r.rank === onlyRank));
  if (!wanted.length) throw new UserFacingError('No army group roles match the ranks on the points record.');

  const members: { userId: number; role: GroupRole }[] = [];
  let capped = false;
  for (const role of wanted) {
    const left = config.eligible.maxProfiles - members.length;
    if (left <= 0) {
      capped = true;
      break;
    }
    const ids = await services.groups.membersWithRole(config.roblox.armyGroupId, role.id, left);
    if (ids.length >= left) capped = true;
    for (const userId of ids) members.push({ userId, role });
  }

  const results = await mapLimit(members, 5, async ({ userId, role }) => {
    const p = await services.profiles.get(userId).catch(() => null);
    if (!p) return null;
    const st = standing(p.data, role.rank);
    if (!st.eligible || !st.next) return null;
    return { userId, rank: role.rank, roleName: role.name, next: st.next.next, points: st.points, trainings: st.next.haveTrainings } satisfies Candidate;
  });
  return {
    ready: results.filter((c): c is Candidate => c !== null).sort((a, b) => a.rank - b.rank || b.points - a.points),
    checked: members.length,
    capped,
    at: Date.now(),
  };
}

export default defineCommand({
  tier: Tier.TrialModerator, // ;eligible is tier 1 in game
  help: 'Who in the army group has the points and trainings for their next rank.',
  data: new SlashCommandBuilder()
    .setName('eligible')
    .setDescription('List soldiers ready for promotion (points and trainings met)')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) =>
      o
        .setName('rank')
        .setDescription('Only check one current rank')
        .addChoices(...Object.entries(RANKS).map(([rank, r]) => ({ name: `rank ${rank} → ${r.next}`, value: Number(rank) }))),
    )
    .addBooleanOption((o) => o.setName('refresh').setDescription('Ignore the cached result')),

  async execute(ctx) {
    const { interaction, services } = ctx;
    await interaction.deferReply();
    const rank = interaction.options.getInteger('rank');
    const key = String(rank ?? 'all');
    if (interaction.options.getBoolean('refresh')) cache.delete(key);
    const result = await cache.getOrLoad(key, () => scan(services, rank), services.config.eligible.cacheMinutes * 60_000);

    const names = await mapLimit(result.ready.slice(0, 40), 5, (c) => services.users.getById(c.userId).catch(() => null));
    const lines = result.ready.slice(0, 40).map((c, i) => {
      const u = names[i];
      return `**${esc(u?.name ?? String(c.userId))}** · ${esc(c.roleName)} → ${c.next} · ${c.points} pts · ${c.trainings} trainings`;
    });
    const embed = new EmbedBuilder()
      .setColor(result.ready.length ? COLOURS.ok : COLOURS.khaki)
      .setTitle(`Eligible for promotion (${result.ready.length})`)
      .setDescription(clip(lines.join('\n') || 'Nobody meets the requirements for their next rank right now.', 4000))
      .setFooter({
        text: `Checked ${result.checked} member${result.checked === 1 ? '' : 's'}${result.capped ? ' (capped: raise ELIGIBLE_MAX_PROFILES or pick a rank)' : ''} · use /promote to act`,
      })
      .setTimestamp(new Date(result.at));
    await interaction.editReply({ embeds: [embed] });
  },
});
