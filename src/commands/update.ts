import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { needTier } from '../discord/helpers.js';
import { Tier } from '../permissions/tiers.js';
import { defineCommand } from '../types.js';
import { runUpdate } from './verify.js';

/** Like Bloxlink's /update: refresh roles and nickname from the linked Roblox account. */
export default defineCommand({
  tier: Tier.Everyone,
  help: 'Refresh your roles and nickname from your Roblox ranks (staff: someone else\'s).',
  data: new SlashCommandBuilder()
    .setName('update')
    .setDescription('Refresh roles and nickname from Roblox group ranks')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName('member').setDescription('Staff: update someone else')),

  async execute(ctx) {
    const member = ctx.interaction.options.getUser('member');
    if (member && member.id !== ctx.interaction.user.id) needTier(ctx, Tier.TrialModerator, 'Updating someone else');
    await runUpdate(ctx, member?.id ?? ctx.interaction.user.id);
  },
});
