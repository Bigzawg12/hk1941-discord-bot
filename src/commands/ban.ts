import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { resolveRobloxTarget } from '../discord/helpers.js';
import { runLiveAction } from '../discord/liveAction.js';
import { banCapProblem, Tier, TIER_NAMES } from '../permissions/tiers.js';
import { defineCommand } from '../types.js';
import { UserFacingError } from '../util/errors.js';
import { formatDuration, parseDuration } from '../util/time.js';

export default defineCommand({
  tier: Tier.SeniorModerator, // ;ban (Senior Moderators capped at 7 days, like HKAdminConfig.BanCaps)
  help: 'Ban from the game (30m / 12h / 7d / 2w / perm). Senior Moderators are capped at 7 days.',
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a player from Hong Kong 1941 (written by a live server, like ;ban)')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('user').setDescription('Roblox username or ID').setRequired(true).setMaxLength(100))
    .addStringOption((o) => o.setName('duration').setDescription('30m, 12h, 7d, 2w or perm').setRequired(true).setMaxLength(10))
    .addStringOption((o) => o.setName('reason').setDescription('Shown to them when they try to join').setMaxLength(200)),

  async execute(ctx) {
    const { interaction, services } = ctx;
    await interaction.deferReply();
    const secs = parseDuration(interaction.options.getString('duration', true));
    if (secs === null) throw new UserFacingError('Duration must be like 30m, 12h, 7d, 2w or perm.');
    const cap = banCapProblem(ctx.caller.tier, secs);
    if (cap) throw new UserFacingError(cap);
    const { user } = await resolveRobloxTarget(ctx, { allowSelf: false });
    const theirs = await services.permissions.robloxUserTier(user.id);
    if (theirs >= ctx.caller.tier) throw new UserFacingError(`You can't ban someone at or above your level (${user.name} is ${TIER_NAMES[theirs]}).`);

    const reason = interaction.options.getString('reason')?.trim() || 'No reason given';
    const r = await runLiveAction(ctx, 'ban', { secs, reason }, {
      target: user,
      label: 'Ban',
      detail: `${formatDuration(secs)} · Reason: ${reason}`,
      noAckHint: '⚠️ The ban is saved by a live server. With no server running it was NOT saved: try again when a server is up, or use ;ban in game.',
    });
    services.global.invalidate('HK1941_Bans', `u${user.id}`);
    await interaction.editReply(r.text);
  },
});
