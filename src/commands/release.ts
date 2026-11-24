import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { resolveRobloxTarget } from '../discord/helpers.js';
import { runLiveAction } from '../discord/liveAction.js';
import { Tier } from '../permissions/tiers.js';
import { defineCommand } from '../types.js';

export default defineCommand({
  tier: Tier.Moderator, // ;release
  help: 'Release a prisoner from the Provost cells (online now, or cleared for when they next join).',
  data: new SlashCommandBuilder()
    .setName('release')
    .setDescription('Release a prisoner from the cells')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('user').setDescription('Roblox username or ID').setRequired(true).setMaxLength(100)),

  async execute(ctx) {
    const { interaction, services } = ctx;
    await interaction.deferReply();
    const { user } = await resolveRobloxTarget(ctx, { allowSelf: false });
    const profile = await services.profiles.get(user.id, { fresh: true });
    const serving = profile ? Math.ceil(profile.data.mp.jailLeft / 60) : 0;
    const before = serving > 0 ? `${user.name} had ${serving} min left (${profile!.data.mp.jailCharges || 'no charge'}).` : `${user.name} has no time left on record.`;
    const r = await runLiveAction(ctx, 'release', {}, { target: user, label: 'Release prisoner', detail: before });
    await interaction.editReply(`${before}\n${r.text}`);
  },
});
