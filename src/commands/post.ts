import { ChannelType, InteractionContextType, SlashCommandBuilder, type ButtonInteraction, type ModalSubmitInteraction } from 'discord.js';
import { ephemeral } from '../discord/helpers.js';
import { Tier } from '../permissions/tiers.js';
import { imageFromAttachment, type ImageFile } from '../posts/images.js';
import {
  COLOUR_CHOICES,
  expandText,
  neutralise,
  parseButtons,
  POST_KINDS,
  renderDraft,
  type ColourName,
  type Ping,
  type PostDraft,
  type PostKind,
} from '../posts/render.js';
import {
  approveButton,
  field,
  formState,
  modal,
  newToken,
  readPing,
  rejectButton,
  rejectReason,
  retryReply,
  submit,
} from '../posts/workflow.js';
import { defineCommand, type CommandContext } from '../types.js';
import { UserFacingError } from '../util/errors.js';

interface PostForm {
  authorId: string;
  kind: PostKind;
  channelId: string;
  ping: Ping;
  colour: number;
  image?: ImageFile;
  /** what they typed last time, so a mistake doesn't lose it */
  values?: Record<string, string>;
}

function postModal(token: string, form: PostForm) {
  const v = form.values ?? {};
  if (form.kind === 'announcement') {
    return modal(`post:compose:${token}`, 'Announcement', [
      field('title', 'Heading (optional)', { max: 100, placeholder: 'Server update', value: v.title }),
      field('body', 'Text', { long: true, required: true, max: 3500, placeholder: 'Markdown works: **bold**, - lists, [link text](https://…), #channel-name', value: v.body }),
      field('signature', 'Signature (optional)', { long: true, max: 300, placeholder: 'Your name\nRank', value: v.signature }),
      field('buttons', 'Link buttons (one per line)', { long: true, max: 600, placeholder: 'Read more | https://…', value: v.buttons }),
    ]);
  }
  return modal(`post:compose:${token}`, `${POST_KINDS[form.kind].label} post`, [
    field('title', 'Title', { required: true, max: 100, placeholder: ':badge: | Royal Rifles of Canada', value: v.title }),
    field('subtitle', 'Line under the title', { max: 100, placeholder: 'C Force, Hong Kong (optional)', value: v.subtitle }),
    field('body', 'Text', { long: true, required: true, max: 3000, placeholder: 'Markdown works: **bold**, - lists, [link text](https://…), #channel-name', value: v.body }),
    field('signature', 'Signature', { long: true, max: 300, placeholder: 'Your name\nRank\nUnit', value: v.signature }),
    field('buttons', 'Link buttons (one per line)', { long: true, max: 600, placeholder: 'Apply here | https://forms.gle/…', value: v.buttons }),
  ]);
}

const KIND_CHOICES = (Object.keys(POST_KINDS) as PostKind[]).map((k) => ({ name: POST_KINDS[k].label, value: k }));
const COLOUR_OPTIONS = (Object.keys(COLOUR_CHOICES) as ColourName[]).map((c) => ({ name: c[0]!.toUpperCase() + c.slice(1), value: c }));

/**
 * /post: a signed post like a unit's recruitment notice or a shout. It shows who sent it and who
 * approved it. The text is written in a form (title, unit line, body, signature, link buttons).
 * Kind "Announcement" is a plain message instead: heading, text, signature, with a small
 * "Sent by" line and no box.
 */
export default defineCommand({
  tier: Tier.TrialModerator,
  help: 'Send an announcement or a signed post (recruitment, shout, notice, orders…). Senior staff approve it first unless you are one.',
  data: new SlashCommandBuilder()
    .setName('post')
    .setDescription('Send an announcement or signed post (recruitment…); approvers check it unless you are one')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('kind').setDescription('What sort of post').setRequired(true).addChoices(...KIND_CHOICES))
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Where it goes (default: /setup post-channel)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .addStringOption((o) => o.setName('ping').setDescription('Ping when it goes out').addChoices({ name: '@here', value: 'here' }, { name: '@everyone', value: 'everyone' }))
    .addRoleOption((o) => o.setName('ping-role').setDescription('Or ping this role instead'))
    .addAttachmentOption((o) => o.setName('image').setDescription('A picture shown under the post (PNG, JPG, GIF or WebP, up to 8 MB)'))
    .addStringOption((o) => o.setName('colour').setDescription('Colour of the bar on the left (default: by kind; announcements have none)').addChoices(...COLOUR_OPTIONS)),

  async execute(ctx) {
    const { interaction, services } = ctx;
    const guildId = interaction.guildId!;
    const kind = interaction.options.getString('kind', true) as PostKind;
    if (!POST_KINDS[kind]) throw new UserFacingError('Pick a kind from the list.');
    const settings = await services.guilds.get(guildId);
    const channelId = interaction.options.getChannel('channel')?.id ?? settings.postChannelId;
    if (!channelId) throw new UserFacingError('Pick a channel, or ask an Administrator to set a default with /setup post-channel.');
    const colourName = interaction.options.getString('colour') as ColourName | null;
    const form: PostForm = {
      authorId: interaction.user.id,
      kind,
      channelId,
      ping: readPing(interaction),
      colour: colourName ? COLOUR_CHOICES[colourName] : POST_KINDS[kind].colour,
      image: imageFromAttachment(interaction.options.getAttachment('image'), 'post-image'),
    };
    const token = newToken();
    formState.set(token, form);
    await interaction.showModal(postModal(token, form));
  },

  async modal(ctx: CommandContext<ModalSubmitInteraction>) {
    const { interaction } = ctx;
    const [, action, id = ''] = interaction.customId.split(':');
    if (action === 'rejectwhy') return rejectReason(ctx, id);
    if (action !== 'compose') return;
    const form = formState.get(id) as PostForm | undefined;
    if (!form || form.authorId !== interaction.user.id) {
      await interaction.reply({ content: 'This form expired. Run /post again.', ...ephemeral });
      return;
    }
    const get = (k: string) => interaction.fields.getTextInputValue(k).trim();
    const plain = form.kind === 'announcement'; // its form has no "line under the title"
    form.values = { title: get('title'), subtitle: plain ? '' : get('subtitle'), body: get('body'), signature: get('signature'), buttons: get('buttons') };
    const tidy = (s: string) => neutralise(expandText(s, interaction.guild));
    let draft: PostDraft;
    try {
      draft = {
        type: 'post',
        kind: form.kind,
        title: tidy(form.values.title!),
        subtitle: tidy(form.values.subtitle!) || undefined,
        body: tidy(form.values.body!),
        signature: tidy(form.values.signature!) || undefined,
        buttons: parseButtons(form.values.buttons),
        colour: form.colour,
        ping: form.ping,
      };
      renderDraft(draft, { authorId: form.authorId, approvedBy: 'x'.repeat(40) }); // too long? say so now
    } catch (err) {
      if (err instanceof UserFacingError) return retryReply(interaction, err.message, `post:reopen:${id}`);
      throw err;
    }
    await interaction.deferReply(ephemeral);
    try {
      await submit(ctx, draft, form.channelId, form.image);
      formState.delete(id);
    } catch (err) {
      if (err instanceof UserFacingError) return retryReply(interaction, err.message, `post:reopen:${id}`);
      throw err;
    }
  },

  async button(ctx: CommandContext<ButtonInteraction>) {
    const [, action, id = ''] = ctx.interaction.customId.split(':');
    if (action === 'approve') return approveButton(ctx, id);
    if (action === 'reject') return rejectButton(ctx, id);
    if (action === 'reopen') {
      const form = formState.get(id) as PostForm | undefined;
      if (!form || form.authorId !== ctx.interaction.user.id) {
        await ctx.interaction.reply({ content: 'This form expired. Run /post again.', ...ephemeral });
        return;
      }
      await ctx.interaction.showModal(postModal(id, form));
    }
  },
});
