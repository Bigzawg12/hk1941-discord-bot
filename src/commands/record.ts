import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { recordEmbed } from '../discord/embeds.js';
import { needTier, resolveRobloxTarget } from '../discord/helpers.js';
import { ADJUST_TIER } from '../game/gameConfig.js';
import { Tier } from '../permissions/tiers.js';
import { defineCommand } from '../types.js';

export default defineCommand({
  tier: Tier.Everyone,
  help: 'Service record: points, next rank, trainings, medals, tabs (staff also see arrests).',
  data: new SlashCommandBuilder()
    .setName('record')
    .setDescription('Show a service record from Hong Kong 1941')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('user').setDescription('Roblox username, user ID or profile link (default: you)').setMaxLength(100))
    .addUserOption((o) => o.setName('member').setDescription('…or a Discord member with a linked account')),

  async execute(ctx) {
    const { interaction, services } = ctx;
    await interaction.deferReply();
    const { user, isSelf } = await resolveRobloxTarget(ctx);
    // in game, ;record for someone else needs tier 1 (Trial Moderator)
    if (!isSelf) needTier(ctx, Tier.TrialModerator, "Seeing someone else's record");

    const [profile, army, headshot] = await Promise.all([
      services.profiles.get(user.id),
      services.groups.rankIn(services.config.roblox.armyGroupId, user.id),
      services.users.headshotUrl(user.id),
    ]);
    if (!profile) {
      await interaction.editReply(`**${user.name}** has no service record yet (they haven't played since records started).`);
      return;
    }
    const staff = ctx.caller.tier >= ADJUST_TIER;
    await interaction.editReply({ embeds: [recordEmbed(user, profile, army, { headshot, showArrests: staff, showLog: staff || isSelf })] });
  },
});
