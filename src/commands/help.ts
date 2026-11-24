import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { COLOURS, ephemeral } from '../discord/helpers.js';
import { requiredTier, Tier, tierLabel } from '../permissions/tiers.js';
import { defineCommand } from '../types.js';

export default defineCommand({
  tier: Tier.Everyone,
  help: 'This list.',
  data: new SlashCommandBuilder().setName('help').setDescription('What this bot can do for you').setContexts(InteractionContextType.Guild),

  async execute(ctx) {
    const { services, caller } = ctx;
    const overrides = services.config.permissions.commandTiers;
    const lines = [...services.commands.values()]
      .map((c) => ({ c, need: requiredTier(c, null, overrides) }))
      .filter(({ need }) => need <= caller.tier)
      .sort((a, b) => a.need - b.need || a.c.data.name.localeCompare(b.c.data.name))
      .map(({ c, need }) => `\`/${c.data.name}\`${need > 0 ? ` (${need})` : ''} ${c.help}`);
    const embed = new EmbedBuilder()
      .setColor(COLOURS.khaki)
      .setTitle('Hong Kong 1941 bot')
      .setDescription(lines.join('\n'))
      .addFields({
        name: 'You',
        value: `${tierLabel(caller.tier)} · ${caller.why}${caller.robloxName ? ` · linked to **${caller.robloxName}**` : ' · not linked (/link start)'}`,
      })
      .setFooter({ text: 'Some subcommands need a higher tier than the command itself.' });
    await ctx.interaction.reply({ embeds: [embed], ...ephemeral });
  },
});
