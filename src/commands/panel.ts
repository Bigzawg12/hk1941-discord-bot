import { ChannelType, InteractionContextType, SlashCommandBuilder, type ButtonInteraction, type ModalSubmitInteraction } from 'discord.js';
import { ephemeral } from '../discord/helpers.js';
import { Tier } from '../permissions/tiers.js';
import { imageFromAttachment, type ImageFile } from '../posts/images.js';
import { readPanel, savePanel } from '../posts/panels.js';
import { collapseText, COLOUR_CHOICES, expandText, parseButtons, PANEL_COLOUR, type ColourName, type LinkButton } from '../posts/render.js';
import { field, formState, modal, newToken, retryReply } from '../posts/workflow.js';
import { defineCommand, type CommandContext } from '../types.js';
import { UserFacingError } from '../util/errors.js';

interface PanelForm {
  authorId: string;
  mode: 'create' | 'edit';
  channelId: string;
  messageId?: string;
  colour: number;
  image?: ImageFile;
  /** picture link, when the panel has one instead of a file */
  imageUrl?: string;
  values: Record<string, string>;
}

const COLOUR_OPTIONS = (Object.keys(COLOUR_CHOICES) as ColourName[]).map((c) => ({ name: c[0]!.toUpperCase() + c.slice(1), value: c }));

function panelModal(token: string, form: PanelForm) {
  const v = form.values;
  return modal(`panel:save:${token}`, form.mode === 'edit' ? 'Edit info panel' : 'New info panel', [
    field('title', 'Title', { required: true, max: 256, placeholder: 'Community Guidebook', value: v.title }),
    field('body', 'Text', { long: true, required: true, max: 4000, placeholder: 'Markdown works: **bold**, - lists, [links](https://…), #channel-name', value: v.body }),
    field('buttons', 'Link buttons (one per line)', { long: true, max: 600, placeholder: 'Community Guidebook | https://docs.google.com/…', value: v.buttons }),
    field('footer', 'Footer (default: server name)', { max: 200, value: v.footer }),
  ]);
}

/** "https://discord.com/channels/<guild>/<channel>/<message>" or a bare message ID in this channel. */
export function parseMessageRef(text: string, here: string): { channelId: string; messageId: string } | null {
  const link = /channels\/(\d{15,25}|@me)\/(\d{15,25})\/(\d{15,25})/.exec(text);
  if (link) return { channelId: link[2]!, messageId: link[3]! };
  const id = /^\s*(\d{15,25})\s*$/.exec(text);
  return id ? { channelId: here, messageId: id[1]! } : null;
}

/**
 * /panel: info panels like a "Community Guidebook" post: a titled box with text, the server's name
 * and icon at the bottom, and link buttons underneath. Panels can be edited later.
 */
export default defineCommand({
  tier: Tier.Administrator,
  help: 'Post or edit an info panel (guidebook, rules, how to join) with link buttons.',
  data: new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Info panels with link buttons, like a guidebook or how-to-join post')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Post a new info panel')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Where (default: this channel)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addAttachmentOption((o) => o.setName('image').setDescription('A picture in the panel (PNG, JPG, GIF or WebP)'))
        .addStringOption((o) => o.setName('colour').setDescription('Colour of the bar on the left').addChoices(...COLOUR_OPTIONS)),
    )
    .addSubcommand((s) =>
      s
        .setName('edit')
        .setDescription('Change a panel the bot posted')
        .addStringOption((o) => o.setName('message').setDescription('Message link (right-click the panel → Copy Message Link) or ID').setRequired(true))
        .addAttachmentOption((o) => o.setName('image').setDescription('Replace the picture'))
        .addStringOption((o) => o.setName('colour').setDescription('Change the colour').addChoices(...COLOUR_OPTIONS)),
    ),

  async execute(ctx) {
    const { interaction } = ctx;
    const sub = interaction.options.getSubcommand(true);
    const colourName = interaction.options.getString('colour') as ColourName | null;
    const newImage = imageFromAttachment(interaction.options.getAttachment('image'), 'panel-image');
    let form: PanelForm;
    if (sub === 'edit') {
      const ref = parseMessageRef(interaction.options.getString('message', true), interaction.channelId);
      if (!ref) throw new UserFacingError('Paste the message link (right-click the panel → Copy Message Link).');
      const ch = await interaction.client.channels.fetch(ref.channelId).catch(() => null);
      if (!ch || !('messages' in ch) || ('guildId' in ch && ch.guildId !== interaction.guildId)) throw new UserFacingError("I can't find that channel in this server.");
      const msg = await ch.messages.fetch(ref.messageId).catch(() => null);
      if (!msg) throw new UserFacingError("I can't find that message. I need Read Message History in its channel.");
      if (msg.author.id !== interaction.client.user.id) throw new UserFacingError('I can only edit panels I posted.');
      const current = readPanel(msg);
      form = {
        authorId: interaction.user.id,
        mode: 'edit',
        channelId: ref.channelId,
        messageId: ref.messageId,
        colour: colourName ? COLOUR_CHOICES[colourName] : current.colour,
        image: newImage ?? current.image,
        imageUrl: newImage ? undefined : current.imageUrl,
        values: { ...current.values, body: collapseText(current.values.body, interaction.guild) },
      };
    } else {
      form = {
        authorId: interaction.user.id,
        mode: 'create',
        channelId: interaction.options.getChannel('channel')?.id ?? interaction.channelId,
        colour: colourName ? COLOUR_CHOICES[colourName] : PANEL_COLOUR,
        image: newImage,
        values: {},
      };
    }
    const token = newToken();
    formState.set(token, form);
    await interaction.showModal(panelModal(token, form));
  },

  async modal(ctx: CommandContext<ModalSubmitInteraction>) {
    const { interaction, services } = ctx;
    const [, , id = ''] = interaction.customId.split(':');
    const form = formState.get(id) as PanelForm | undefined;
    if (!form || form.authorId !== interaction.user.id) {
      await interaction.reply({ content: 'This form expired. Run /panel again.', ...ephemeral });
      return;
    }
    const get = (k: string) => interaction.fields.getTextInputValue(k).trim();
    form.values = { title: get('title'), body: get('body'), buttons: get('buttons'), footer: get('footer') };
    let buttons: LinkButton[];
    try {
      buttons = parseButtons(form.values.buttons);
    } catch (err) {
      if (err instanceof UserFacingError) return retryReply(interaction, err.message, `panel:reopen:${id}`);
      throw err;
    }
    await interaction.deferReply(ephemeral);
    const tidy = (s: string) => expandText(s, interaction.guild);
    let url: string;
    try {
      ({ url } = await savePanel(services, interaction.client, {
        guild: interaction.guild ?? { id: interaction.guildId!, name: '' },
        channelId: form.channelId,
        messageId: form.mode === 'edit' ? form.messageId : undefined,
        draft: { title: tidy(form.values.title!), body: tidy(form.values.body!), footer: form.values.footer, buttons, colour: form.colour, imageUrl: form.imageUrl },
        image: form.image,
        by: { id: interaction.user.id, name: interaction.user.username },
      }));
    } catch (err) {
      if (err instanceof UserFacingError) return retryReply(interaction, err.message, `panel:reopen:${id}`);
      throw err;
    }
    formState.delete(id);
    await services.audit.record({
      actorId: interaction.user.id,
      actorName: interaction.user.username,
      action: form.mode === 'edit' ? 'Info panel edited' : 'Info panel posted',
      detail: `"${form.values.title}" in <#${form.channelId}>: ${url}`,
      ok: true,
      guildId: interaction.guildId,
    });
    await interaction.editReply({ content: `✅ ${form.mode === 'edit' ? 'Updated' : 'Posted'}: ${url}`, components: [] });
  },

  async button(ctx: CommandContext<ButtonInteraction>) {
    const [, action, id = ''] = ctx.interaction.customId.split(':');
    if (action !== 'reopen') return;
    const form = formState.get(id) as PanelForm | undefined;
    if (!form || form.authorId !== ctx.interaction.user.id) {
      await ctx.interaction.reply({ content: 'This form expired. Run /panel again.', ...ephemeral });
      return;
    }
    await ctx.interaction.showModal(panelModal(id, form));
  },
});
