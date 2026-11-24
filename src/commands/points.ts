import { InteractionContextType, SlashCommandBuilder, type SlashCommandSubcommandBuilder } from 'discord.js';
import { resolveRobloxTarget } from '../discord/helpers.js';
import { runLiveAction } from '../discord/liveAction.js';
import { ADJUST_CAP, ADJUST_TIER } from '../game/gameConfig.js';
import { Tier } from '../permissions/tiers.js';
import { defineCommand } from '../types.js';
import { UserFacingError } from '../util/errors.js';

const opts = (s: SlashCommandSubcommandBuilder) =>
  s
    .addStringOption((o) => o.setName('user').setDescription('Roblox username or ID').setRequired(true).setMaxLength(100))
    .addIntegerOption((o) => o.setName('amount').setDescription('How many points').setRequired(true).setMinValue(1).setMaxValue(10000))
    .addStringOption((o) => o.setName('reason').setDescription('Kept on their record').setMaxLength(150));

export default defineCommand({
  tier: ADJUST_TIER as Tier, // ;addpoints / ;removepoints
  help: `Add or remove service points (Moderators up to ${ADJUST_CAP} at a time).`,
  data: new SlashCommandBuilder()
    .setName('points')
    .setDescription('Add or remove service points by hand')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => opts(s.setName('add').setDescription('Award points')))
    .addSubcommand((s) => opts(s.setName('remove').setDescription('Take points away'))),

  async execute(ctx) {
    const { interaction } = ctx;
    const sub = interaction.options.getSubcommand(true);
    const amount = interaction.options.getInteger('amount', true);
    // ServiceConfig: Moderators can move at most AdjustCap at once; Senior Moderators and up have no cap
    if (ctx.caller.tier < Tier.SeniorModerator && amount > ADJUST_CAP) {
      throw new UserFacingError(`Moderators can change points by up to ${ADJUST_CAP} at a time.`);
    }
    await interaction.deferReply();
    const { user } = await resolveRobloxTarget(ctx, { allowSelf: false });
    const n = sub === 'remove' ? -amount : amount;
    const reason = interaction.options.getString('reason')?.trim() ?? '';
    const r = await runLiveAction(ctx, 'points', { n, reason }, {
      target: user,
      label: n >= 0 ? 'Add points' : 'Remove points',
      detail: `${n >= 0 ? '+' : ''}${n}${reason ? ` · ${reason}` : ''}`,
      noAckHint: 'No live server picked it up, so nothing changed. Try again when a server is up.',
    });
    ctx.services.profiles.get(user.id, { fresh: true }).catch(() => undefined);
    await interaction.editReply(r.text);
  },
});
