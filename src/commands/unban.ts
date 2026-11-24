import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { resolveRobloxTarget } from '../discord/helpers.js';
import { runLiveAction } from '../discord/liveAction.js';
import { isBanActive } from '../roblox/globalData.js';
import { Tier } from '../permissions/tiers.js';
import { defineCommand } from '../types.js';
import { discordTime } from '../util/time.js';

export default defineCommand({
  tier: Tier.Administrator, // ;unban
  help: 'Lift a game ban (shows what the ban was).',
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Lift a Hong Kong 1941 ban')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('user').setDescription('Roblox username or ID').setRequired(true).setMaxLength(100)),

  async execute(ctx) {
    const { interaction, services } = ctx;
    await interaction.deferReply();
    const { user } = await resolveRobloxTarget(ctx, { allowSelf: false });
    const ban = await services.global.ban(user.id);
    const now = Math.floor(Date.now() / 1000);
    const was = isBanActive(ban, now)
      ? `Was banned ${ban!.untilT === 0 ? 'permanently' : `until ${discordTime(ban!.untilT)}`} by ${ban!.by ?? '?'}: ${ban!.reason ?? 'no reason'}`
      : 'No active ban was on record (sending the unban anyway).';
    const r = await runLiveAction(ctx, 'unban', {}, { target: user, label: 'Unban', detail: was, noAckHint: 'No live server picked it up, so the ban is still in place.' });
    services.global.invalidate('HK1941_Bans', `u${user.id}`);
    await interaction.editReply(`${was}\n${r.text}`);
  },
});
