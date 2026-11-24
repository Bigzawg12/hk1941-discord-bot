import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { runLiveAction } from '../discord/liveAction.js';
import { Tier } from '../permissions/tiers.js';
import { defineCommand } from '../types.js';

export default defineCommand({
  // reaches every server, like ;gannounce (tier 4). Lower it with COMMAND_TIERS=announce:2 if you want.
  tier: Tier.Administrator,
  help: 'Announce to every live server (filtered in game under your Roblox account).',
  data: new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Show an announcement in every live Hong Kong 1941 server')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('message').setDescription('What to say').setRequired(true).setMaxLength(300)),

  async execute(ctx) {
    const text = ctx.interaction.options.getString('message', true).trim();
    const r = await runLiveAction(ctx, 'announce', { text }, { label: 'Announce', detail: text });
    await ctx.interaction.editReply(`📢 ${r.text}`);
  },
});
