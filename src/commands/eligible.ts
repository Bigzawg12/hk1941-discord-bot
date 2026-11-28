import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, InteractionContextType, SlashCommandBuilder, type ButtonInteraction } from 'discord.js';
import { clip, COLOURS, ephemeral, esc } from '../discord/helpers.js';
import { RANKS } from '../game/gameConfig.js';
import { bulkPromote, describeBulk, nextRole, rosterFor } from '../game/promotions.js';
import { Tier } from '../permissions/tiers.js';
import { defineCommand, type CommandContext } from '../types.js';
import { mapLimit } from '../util/cache.js';

/** most promoted by one press of Promote all */
const BULK_MAX = 25;

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
    const key = rank ?? 'all';
    const canPromote = ctx.caller.tier >= Tier.Administrator && result.ready.length > 0;
    const row = canPromote
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`eligible:all:${key}:${interaction.user.id}`)
              .setLabel(`Promote ${result.ready.length > BULK_MAX ? `the first ${BULK_MAX}` : `all ${result.ready.length}`}`)
              .setStyle(ButtonStyle.Primary),
          ),
        ]
      : [];
    await interaction.editReply({ embeds: [embed], components: row });
  },

  async button(ctx: CommandContext<ButtonInteraction>) {
    const { interaction, services, caller } = ctx;
    const [, action, key = 'all', requester] = interaction.customId.split(':');
    if (requester !== interaction.user.id) {
      await interaction.reply({ content: 'Only the person who ran /eligible can use this.', ...ephemeral });
      return;
    }
    if (caller.tier < Tier.Administrator) {
      await interaction.reply({ content: 'Promoting needs Administrator (4) or above.', ...ephemeral });
      return;
    }
    const rank = key === 'all' ? null : Number(key);
    const roster = rosterFor(services).cached(rank);
    const ready = (roster?.entries ?? []).filter((e) => e.eligible && e.next).sort((a, b) => a.rank - b.rank || b.points - a.points).slice(0, BULK_MAX);
    if (!ready.length) {
      await interaction.reply({ content: 'That list is out of date. Run /eligible again.', ...ephemeral });
      return;
    }
    if (action === 'all') {
      await interaction.reply({
        content: `Promote **${ready.length}** ${ready.length === 1 ? 'person' : 'people'} one rank each, as listed? Their rank is checked again first, and anyone whose rank changed is skipped.`,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`eligible:go:${key}:${interaction.user.id}`).setLabel('Yes, promote them').setStyle(ButtonStyle.Success),
          ),
        ],
        ...ephemeral,
      });
      return;
    }
    if (action !== 'go') return;
    await interaction.deferUpdate();
    const roles = await services.groups.listRoles(services.config.roblox.armyGroupId);
    const picks = ready.flatMap((e) => {
      const to = nextRole(roles, e.rank);
      return to ? [{ userId: e.userId, from: e.roleId, to: to.id }] : [];
    });
    const result = await bulkPromote(services, picks, {
      actor: { robloxId: caller.robloxId, tier: caller.tier },
      audit: { actorId: interaction.user.id, actorName: `${interaction.user.username}${caller.robloxName ? ` / ${caller.robloxName}` : ''}`, guildId: interaction.guildId },
      reason: 'Met the points and trainings (/eligible)',
      client: interaction.client,
    });
    await interaction.editReply({ content: clip(`${result.failed.length ? '⚠️' : '✅'} ${describeBulk(result)}`, 1900), components: [] });
  },
});
