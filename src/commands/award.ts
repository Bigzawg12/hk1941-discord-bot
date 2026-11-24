import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { needTier, resolveRobloxTarget } from '../discord/helpers.js';
import { runLiveAction } from '../discord/liveAction.js';
import { CERT_BY_ID, CERTS, MEDAL_BY_ID, MEDALS, MIN_AWARD_TIER, MIN_CERT_TIER, TOP_AWARD_TIER } from '../game/gameConfig.js';
import { Tier } from '../permissions/tiers.js';
import { defineCommand } from '../types.js';

export default defineCommand({
  tier: MIN_CERT_TIER as Tier,
  subTiers: { medal: MIN_AWARD_TIER as Tier, tab: MIN_CERT_TIER as Tier },
  help: 'Award or revoke a medal (Senior Moderator; VC/GC Administrator) or a qualification tab (Moderator).',
  data: new SlashCommandBuilder()
    .setName('award')
    .setDescription('Award or remove medals and qualification tabs')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName('medal')
        .setDescription('Award (or revoke) a medal, like ;award')
        .addStringOption((o) => o.setName('user').setDescription('Roblox username or ID').setRequired(true).setMaxLength(100))
        .addStringOption((o) =>
          o
            .setName('medal')
            .setDescription('Which medal')
            .setRequired(true)
            .addChoices(...MEDALS.map((m) => ({ name: m.name.slice(0, 100), value: m.id }))),
        )
        .addStringOption((o) => o.setName('citation').setDescription('Citation (shown in game)').setMaxLength(200))
        .addBooleanOption((o) => o.setName('revoke').setDescription('Remove one instead of awarding')),
    )
    .addSubcommand((s) =>
      s
        .setName('tab')
        .setDescription('Give (or remove) a qualification tab, like ;certify')
        .addStringOption((o) => o.setName('user').setDescription('Roblox username or ID').setRequired(true).setMaxLength(100))
        .addStringOption((o) =>
          o
            .setName('tab')
            .setDescription('Which qualification')
            .setRequired(true)
            .addChoices(...CERTS.map((c) => ({ name: c.name, value: c.id }))),
        )
        .addBooleanOption((o) => o.setName('remove').setDescription('Remove the tab instead')),
    ),

  async execute(ctx) {
    const { interaction } = ctx;
    const sub = interaction.options.getSubcommand(true);
    if (sub === 'medal') {
      const medal = MEDAL_BY_ID.get(interaction.options.getString('medal', true))!;
      if (medal.top) needTier(ctx, TOP_AWARD_TIER as Tier, `The ${medal.name}`);
      await interaction.deferReply();
      const { user } = await resolveRobloxTarget(ctx, { allowSelf: false });
      const remove = interaction.options.getBoolean('revoke') === true;
      const cite = interaction.options.getString('citation')?.trim() ?? '';
      const r = await runLiveAction(ctx, 'award', { medal: medal.id, cite, remove }, {
        target: user,
        label: remove ? `Revoke ${medal.id}` : `Award ${medal.id}`,
        detail: cite ? `Citation: ${cite}` : undefined,
      });
      await interaction.editReply(r.text);
      return;
    }
    const tab = CERT_BY_ID.get(interaction.options.getString('tab', true))!;
    await interaction.deferReply();
    const { user } = await resolveRobloxTarget(ctx, { allowSelf: false });
    const remove = interaction.options.getBoolean('remove') === true;
    const r = await runLiveAction(ctx, 'certify', { tab: tab.id, remove }, { target: user, label: remove ? `Remove tab ${tab.id}` : `Tab ${tab.id}` });
    await interaction.editReply(r.text);
  },
});
