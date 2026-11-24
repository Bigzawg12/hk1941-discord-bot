import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { medalsEmbed } from '../discord/embeds.js';
import { resolveRobloxTarget } from '../discord/helpers.js';
import { Tier } from '../permissions/tiers.js';
import { defineCommand } from '../types.js';

export default defineCommand({
  tier: Tier.Everyone,
  help: 'Medals and qualification tabs on a record.',
  data: new SlashCommandBuilder()
    .setName('medals')
    .setDescription('Show the medals and qualification tabs someone holds')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('user').setDescription('Roblox username, user ID or profile link (default: you)').setMaxLength(100))
    .addUserOption((o) => o.setName('member').setDescription('…or a Discord member with a linked account')),

  async execute(ctx) {
    await ctx.interaction.deferReply();
    const { user } = await resolveRobloxTarget(ctx);
    const profile = await ctx.services.profiles.get(user.id);
    await ctx.interaction.editReply({ embeds: [medalsEmbed(user, profile)] });
  },
});
