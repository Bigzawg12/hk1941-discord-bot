import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { clip, COLOURS, esc } from '../discord/helpers.js';
import { RANKS } from '../game/gameConfig.js';
import { rosterFor } from '../game/promotions.js';
import { Tier } from '../permissions/tiers.js';
import { defineCommand } from '../types.js';
import { mapLimit } from '../util/cache.js';

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
    const roster = await rosterFor(services).load(rank, { force: !!interaction.options.getBoolean('refresh') });
    const result = { ...roster, ready: roster.entries.filter((e) => e.eligible && e.next).sort((a, b) => a.rank - b.rank || b.points - a.points) };

    const names = await mapLimit(result.ready.slice(0, 40), 5, (c) => services.users.getById(c.userId).catch(() => null));
    const lines = result.ready.slice(0, 40).map((c, i) => {
      const u = names[i];
      return `**${esc(u?.name ?? String(c.userId))}** · ${esc(c.roleName)} → ${c.next!.next} · ${c.points} pts · ${c.trainings} trainings`;
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
