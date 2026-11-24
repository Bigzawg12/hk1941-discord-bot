import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { arrestLogEmbed, playerArrestsEmbed } from '../discord/embeds.js';
import { resolveRobloxTarget } from '../discord/helpers.js';
import { Tier } from '../permissions/tiers.js';
import { defineCommand } from '../types.js';

export default defineCommand({
  tier: Tier.TrialModerator, // ;arrests is tier 1 in game
  help: 'Latest arrests from the provost log, or one player\'s arrest record.',
  data: new SlashCommandBuilder()
    .setName('arrests')
    .setDescription('Military police arrests: the latest log, or one player')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('user').setDescription('Roblox username or ID (leave empty for the latest log)').setMaxLength(100))
    .addUserOption((o) => o.setName('member').setDescription('…or a Discord member with a linked account'))
    .addIntegerOption((o) => o.setName('count').setDescription('How many to show (default 10)').setMinValue(1).setMaxValue(25)),

  async execute(ctx) {
    const { interaction, services } = ctx;
    await interaction.deferReply();
    const count = interaction.options.getInteger('count') ?? 10;
    if (!interaction.options.getString('user') && !interaction.options.getUser('member')) {
      await interaction.editReply({ embeds: [arrestLogEmbed(await services.global.arrestLog(), count)] });
      return;
    }
    const { user } = await resolveRobloxTarget(ctx, { allowSelf: false });
    await interaction.editReply({ embeds: [playerArrestsEmbed(user, await services.profiles.get(user.id), count)] });
  },
});
