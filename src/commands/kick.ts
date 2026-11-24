import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { resolveRobloxTarget } from '../discord/helpers.js';
import { runLiveAction } from '../discord/liveAction.js';
import { Tier, TIER_NAMES } from '../permissions/tiers.js';
import { defineCommand } from '../types.js';
import { UserFacingError } from '../util/errors.js';

export default defineCommand({
  tier: Tier.Moderator, // ;kick
  help: 'Kick a player from whichever server they are in.',
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a player from the live server they are in')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('user').setDescription('Roblox username or ID').setRequired(true).setMaxLength(100))
    .addStringOption((o) => o.setName('reason').setDescription('Shown to them').setMaxLength(200)),

  async execute(ctx) {
    const { interaction, services } = ctx;
    await interaction.deferReply();
    const { user } = await resolveRobloxTarget(ctx, { allowSelf: false });
    const theirs = await services.permissions.robloxUserTier(user.id);
    if (theirs >= ctx.caller.tier) throw new UserFacingError(`You can't kick someone at or above your level (${user.name} is ${TIER_NAMES[theirs]}).`);
    const reason = interaction.options.getString('reason')?.trim() || 'No reason given';
    const r = await runLiveAction(ctx, 'kick', { reason }, {
      target: user,
      label: 'Kick',
      detail: `Reason: ${reason}`,
      noAckHint: `${user.name} may not be in any server right now.`,
    });
    await interaction.editReply(r.text);
  },
});
