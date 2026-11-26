import { ChannelType, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { ephemeral } from '../discord/helpers.js';
import { Tier } from '../permissions/tiers.js';
import { bannerFile, imageFromAttachment } from '../posts/images.js';
import { expandText, neutralise, SSU_COLOUR, type SsuDraft } from '../posts/render.js';
import { readPing, submit } from '../posts/workflow.js';
import { defineCommand } from '../types.js';
import { UserFacingError } from '../util/errors.js';

export const DEFAULT_SSU_MESSAGE = 'Servers are up! Head down to Hong Kong for a server start up.';

/**
 * /ssu: "Server Start Up" call to play, with a Join button, a ping, the game's current or next event
 * (from HK1941_Events) and how many servers are live (from the bridge heartbeats).
 */
export default defineCommand({
  tier: Tier.TrialModerator,
  help: 'Announce a server start up with a Join button, the current event and a ping (approved like /post).',
  data: new SlashCommandBuilder()
    .setName('ssu')
    .setDescription('Announce a server start up with a Join button')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('event').setDescription("Event on now (default: the game's current or next event)").setMaxLength(150))
    .addStringOption((o) => o.setName('message').setDescription('Line under the heading').setMaxLength(300))
    .addStringOption((o) =>
      o
        .setName('ping')
        .setDescription('Who to ping (default @here)')
        .addChoices({ name: '@here', value: 'here' }, { name: '@everyone', value: 'everyone' }, { name: 'Nobody', value: 'none' }),
    )
    .addRoleOption((o) => o.setName('ping-role').setDescription('Or ping this role instead'))
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Where it goes (default: /setup ssu-channel)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .addAttachmentOption((o) => o.setName('image').setDescription('Picture (default: /setup ssu-banner)')),

  async execute(ctx) {
    const { interaction, services } = ctx;
    const guildId = interaction.guildId!;
    const settings = await services.guilds.get(guildId);
    const channelId = interaction.options.getChannel('channel')?.id ?? settings.ssuChannelId ?? settings.postChannelId;
    if (!channelId) throw new UserFacingError('Pick a channel, or ask an Administrator to set one with /setup ssu-channel.');
    const image =
      imageFromAttachment(interaction.options.getAttachment('image'), 'ssu-image') ?? bannerFile(services.config.dataDir, settings.ssuBanner);
    await interaction.deferReply(ephemeral);
    const tidy = (s: string) => neutralise(expandText(s, interaction.guild));
    const draft: SsuDraft = {
      type: 'ssu',
      message: tidy(interaction.options.getString('message')?.trim() || DEFAULT_SSU_MESSAGE),
      event: tidy(interaction.options.getString('event')?.trim() ?? '') || undefined,
      colour: SSU_COLOUR,
      ping: readPing(interaction, 'here'),
      placeId: services.config.roblox.placeId,
    };
    await submit(ctx, draft, channelId, image);
  },
});
