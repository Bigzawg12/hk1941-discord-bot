import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { statusEmbed } from '../discord/embeds.js';
import { Tier } from '../permissions/tiers.js';
import { defineCommand } from '../types.js';

export default defineCommand({
  tier: Tier.Everyone,
  help: 'Live servers and player counts (plus names and objectives when the bridge is installed).',
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Live Hong Kong 1941 servers')
    .setContexts(InteractionContextType.Guild)
    .addBooleanOption((o) => o.setName('names').setDescription('Show who is in each server (staff only)')),

  async execute(ctx) {
    const { interaction, services } = ctx;
    await interaction.deferReply();
    const list = await services.servers.list();
    const showNames = interaction.options.getBoolean('names') === true && ctx.caller.tier >= Tier.TrialModerator;
    if (!showNames) for (const s of list.servers) delete s.names;
    await interaction.editReply({ embeds: [statusEmbed(list, services.config.roblox.placeId)] });
  },
});
