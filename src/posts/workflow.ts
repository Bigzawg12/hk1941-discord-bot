import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Message,
  type ModalSubmitInteraction,
} from 'discord.js';
import { ephemeral } from '../discord/helpers.js';
import { Tier, tierLabel } from '../permissions/tiers.js';
import type { GameEvent } from '../roblox/globalData.js';
import type { CommandContext, Services } from '../types.js';
import { TtlCache } from '../util/cache.js';
import { UserFacingError } from '../util/errors.js';
import { bannerFile, type ImageFile } from './images.js';
import {
  allowedMentionsFor,
  draftLabel,
  renderDecision,
  renderDraft,
  textBlock,
  type Draft,
  type Ping,
  type RenderMeta,
} from './render.js';
import { PENDING_TTL_MS, type PendingPost } from './store.js';

/**
 * Posts and SSUs: someone at or above the server's approver tier posts straight away (signed
 * "Approved by" themselves). Anyone below goes through the approval channel: a preview with
 * Approve / Reject buttons, and only an approver can press them.
 */

export const DEFAULT_APPROVER_TIER = Tier.SeniorModerator;

/** Short-lived state between a slash command and the form it opens (15 minutes). */
export const formState = new TtlCache<string, unknown>(15 * 60_000, 500);

export function newToken(): string {
  return randomBytes(6).toString('hex');
}

/** One-line text box in a modal, under a label (Discord's newer modal layout). */
export function field(
  id: string,
  label: string,
  opts: { long?: boolean; required?: boolean; max: number; placeholder?: string; value?: string; description?: string },
): LabelBuilder {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setStyle(opts.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(opts.required ?? false)
    .setMaxLength(opts.max);
  if (opts.placeholder) input.setPlaceholder(opts.placeholder.slice(0, 100));
  if (opts.value) input.setValue(opts.value.slice(0, opts.max));
  const label_ = new LabelBuilder().setLabel(label).setTextInputComponent(input);
  if (opts.description) label_.setDescription(opts.description.slice(0, 100));
  return label_;
}

export function modal(customId: string, title: string, fields: LabelBuilder[]): ModalBuilder {
  return new ModalBuilder().setCustomId(customId).setTitle(title.slice(0, 45)).addLabelComponents(fields);
}

export function readPing(interaction: ChatInputCommandInteraction, fallback: Ping['kind'] = 'none'): Ping {
  const role = interaction.options.getRole('ping-role');
  if (role) {
    if (role.id === interaction.guildId) return { kind: 'everyone' };
    return { kind: 'role', roleId: role.id };
  }
  const p = (interaction.options.getString('ping') ?? fallback) as Ping['kind'];
  return p === 'here' || p === 'everyone' ? { kind: p } : { kind: 'none' };
}

/**
 * Say what was wrong with a form, with a button that opens it again with their text still in it.
 * Works whether or not the interaction was deferred.
 */
export async function retryReply(interaction: ModalSubmitInteraction, message: string, reopenId: string): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(reopenId).setLabel('Edit and send again').setStyle(ButtonStyle.Primary),
  );
  if (interaction.deferred || interaction.replied) await interaction.editReply({ content: message, components: [row] });
  else await interaction.reply({ content: message, components: [row], ...ephemeral });
}

export async function approverTier(services: Services, guildId: string): Promise<Tier> {
  return ((await services.guilds.get(guildId)).postApproverTier ?? DEFAULT_APPROVER_TIER) as Tier;
}

/** The name shown in "Approved by": the linked Roblox name, else the Discord name. */
export function nameOf(ctx: CommandContext<{ user: { username: string; globalName?: string | null }; member: unknown }>): string {
  if (ctx.caller.robloxName) return ctx.caller.robloxName;
  const m = ctx.interaction.member as { displayName?: string; nick?: string | null } | null;
  return m?.displayName ?? m?.nick ?? ctx.interaction.user.globalName ?? ctx.interaction.user.username;
}

/** The event to show on an SSU: one running now, else the next one within the hour. */
export function pickEvent(events: GameEvent[], nowSec: number, lengthMinutes: number): RenderMeta['liveEvent'] {
  const running = events.filter((e) => e.start <= nowSec && e.start + lengthMinutes * 60 > nowSec).sort((a, b) => b.start - a.start)[0];
  if (running) return { title: running.title };
  const soon = events.filter((e) => e.start > nowSec && e.start <= nowSec + 3600).sort((a, b) => a.start - b.start)[0];
  return soon ? { title: soon.title, startsAt: soon.start } : undefined;
}

/** Live details for an SSU, looked up when it's posted. Never fails the post. */
async function ssuMeta(services: Services, draft: Draft): Promise<Pick<RenderMeta, 'liveEvent' | 'serversLine'>> {
  if (draft.type !== 'ssu') return {};
  const out: Pick<RenderMeta, 'liveEvent' | 'serversLine'> = {};
  const nowSec = Math.floor(Date.now() / 1000);
  if (!draft.event) {
    try {
      out.liveEvent = pickEvent(await services.global.events(), nowSec, services.config.events.lengthMinutes);
    } catch (err) {
      services.logger.warn({ err }, 'SSU: could not read the game events');
    }
  }
  try {
    const list = await services.servers.list();
    if (list.source !== 'none' && list.servers.length) {
      const players = list.servers.reduce((n, s) => n + s.players, 0);
      out.serversLine = `🟢 ${list.servers.length} server${list.servers.length === 1 ? '' : 's'} live · ${players} playing`;
    }
  } catch (err) {
    services.logger.warn({ err }, 'SSU: could not read the server list');
  }
  return out;
}

async function sendableChannel(client: Client, channelId: string) {
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch?.isSendable()) {
    throw new UserFacingError(`I can't post in <#${channelId}>. Give me View Channel, Send Messages, Embed Links and Attach Files there.`);
  }
  return ch;
}

function messageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** Send the finished post to its channel. */
export async function publish(
  services: Services,
  client: Client,
  p: { guildId: string; channelId: string; authorId: string; draft: Draft },
  approvedBy: string,
  image?: ImageFile,
): Promise<{ message: Message; url: string }> {
  const ch = await sendableChannel(client, p.channelId);
  const draft = { ...p.draft, imageName: image ? image.name : undefined } as Draft;
  const container = renderDraft(draft, { authorId: p.authorId, approvedBy, ...(await ssuMeta(services, draft)) });
  const message = await ch.send({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    files: image ? [image] : [],
    allowedMentions: allowedMentionsFor(draft.ping, true),
  });
  return { message, url: messageUrl(p.guildId, p.channelId, message.id) };
}

type Submitting = CommandContext<ChatInputCommandInteraction | ModalSubmitInteraction>;

/**
 * Post now (approvers) or put it in the approval channel (everyone else). The interaction must
 * already be deferred (ephemeral).
 */
export async function submit(ctx: Submitting, draft: Draft, channelId: string, image?: ImageFile): Promise<void> {
  const { interaction, services, caller } = ctx;
  const guildId = interaction.guildId!;
  const need = await approverTier(services, guildId);
  const by = nameOf(ctx);
  const audit = (action: string, detail: string, ok = true) =>
    services.audit.record({ actorId: interaction.user.id, actorName: interaction.user.username, action, detail, ok, guildId });

  if (caller.tier >= need) {
    const { url } = await publish(services, interaction.client, { guildId, channelId, authorId: interaction.user.id, draft }, by, image);
    await audit(draft.type === 'ssu' ? 'SSU posted' : 'Post published', `${draftLabel(draft)} in <#${channelId}>: ${url}`);
    await interaction.editReply({ content: `✅ Posted in <#${channelId}>: ${url}` });
    return;
  }

  const settings = await services.guilds.get(guildId);
  if (!settings.approvalChannelId) {
    throw new UserFacingError(
      `Posts from below ${tierLabel(need)} need approval, and this server has no approval channel yet. An Administrator can set one with /setup approval-channel.`,
    );
  }
  await sendableChannel(interaction.client, channelId); // fail now, not when it's approved
  const queueChannel = await sendableChannel(interaction.client, settings.approvalChannelId);
  const post: PendingPost = {
    id: newToken(),
    guildId,
    channelId,
    authorId: interaction.user.id,
    draft: { ...draft, imageName: image?.name } as Draft,
    createdAt: Date.now(),
    status: 'pending',
  };
  const preview = renderDraft(post.draft, { authorId: post.authorId, ...(await ssuMeta(services, post.draft)) });
  const queued = await queueChannel.send({
    components: [
      textBlock(`📝 <@${post.authorId}> wants to post this in <#${channelId}>. ${tierLabel(need)} or above can approve it.`),
      preview,
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`post:approve:${post.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`post:reject:${post.id}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
      ),
    ],
    flags: MessageFlags.IsComponentsV2,
    files: image ? [image] : [],
    allowedMentions: { parse: [] },
  });
  post.queue = { channelId: settings.approvalChannelId, messageId: queued.id };
  await services.posts.put(post);
  await audit('Post sent for approval', `${draftLabel(post.draft)} for <#${channelId}> (request ${post.id})`);
  await interaction.editReply({ content: `📝 Sent for approval in <#${settings.approvalChannelId}>. You'll get a DM when it's approved or rejected (if your DMs are open).` });
}

// ---------- approval buttons ----------

const inFlight = new Set<string>();

async function loadForDecision(ctx: CommandContext<ButtonInteraction | ModalSubmitInteraction>, id: string): Promise<PendingPost | null> {
  const { interaction, services, caller } = ctx;
  const post = await services.posts.get(id);
  const say = async (content: string) => {
    await interaction.reply({ content, ...ephemeral });
    return null;
  };
  if (!post) return say('This request is no longer on file.');
  if (post.status !== 'pending') return say(`This was already ${post.status} by ${post.decidedBy ?? 'someone'}.`);
  const need = await approverTier(services, post.guildId);
  if (caller.tier < need) return say(`Approving posts needs ${tierLabel(need)} or above in this server.`);
  if (interaction.user.id === post.authorId && caller.tier < Tier.Owner) return say('Someone else has to approve your own post.');
  if (inFlight.has(id)) return say('Someone is deciding on this right now.');
  return post;
}

async function tellAuthor(client: Client, post: PendingPost, text: string, services: Services): Promise<void> {
  try {
    await client.users.send(post.authorId, { content: text, allowedMentions: { parse: [] } });
  } catch (err) {
    services.logger.debug({ err, user: post.authorId }, 'could not DM the post author');
  }
}

function decisionMessage(post: PendingPost) {
  return {
    components: [
      renderDecision({
        draft: post.draft,
        authorId: post.authorId,
        channelId: post.channelId,
        approved: post.status === 'approved',
        by: post.decidedBy ?? '?',
        at: post.decidedAt ?? Date.now(),
        reason: post.reason,
        postUrl: post.postUrl,
      }),
    ],
    attachments: [],
    flags: MessageFlags.IsComponentsV2 as const,
    allowedMentions: { parse: [] },
  };
}

export async function approveButton(ctx: CommandContext<ButtonInteraction>, id: string): Promise<void> {
  const { interaction, services } = ctx;
  const post = await loadForDecision(ctx, id);
  if (!post) return;
  if (Date.now() - post.createdAt > PENDING_TTL_MS) {
    post.status = 'rejected';
    post.decidedBy = 'the bot';
    post.decidedAt = Date.now();
    post.reason = 'Expired: nobody approved it within 7 days.';
    await services.posts.put(post);
    await interaction.update(decisionMessage(post));
    return;
  }
  inFlight.add(id);
  try {
    await interaction.deferUpdate();
    const by = nameOf(ctx);
    const name = post.draft.imageName;
    const att = name ? interaction.message.attachments.find((a) => a.name === name) : undefined;
    let image: ImageFile | undefined = att && name ? { attachment: att.url, name } : undefined;
    if (!image && name && post.draft.type === 'ssu') {
      image = bannerFile(services.config.dataDir, (await services.guilds.get(post.guildId)).ssuBanner);
    }
    const { url } = await publish(services, interaction.client, post, by, image);
    post.status = 'approved';
    post.decidedBy = by;
    post.decidedAt = Date.now();
    post.postUrl = url;
    await services.posts.put(post);
    await interaction.editReply(decisionMessage(post));
    await services.audit.record({
      actorId: interaction.user.id,
      actorName: interaction.user.username,
      action: 'Post approved',
      target: `<@${post.authorId}>`,
      detail: `${draftLabel(post.draft)} in <#${post.channelId}>: ${url}`,
      ok: true,
      guildId: post.guildId,
    });
    await tellAuthor(interaction.client, post, `✅ Your ${draftLabel(post.draft)} was approved by ${by} and posted: ${url}`, services);
  } finally {
    inFlight.delete(id);
  }
}

export async function rejectButton(ctx: CommandContext<ButtonInteraction>, id: string): Promise<void> {
  const post = await loadForDecision(ctx, id);
  if (!post) return;
  await ctx.interaction.showModal(
    modal(`post:rejectwhy:${id}`, 'Reject this post', [
      field('reason', 'Reason (sent to the author)', { long: true, max: 500, placeholder: 'What to change before posting again' }),
    ]),
  );
}

export async function rejectReason(ctx: CommandContext<ModalSubmitInteraction>, id: string): Promise<void> {
  const { interaction, services } = ctx;
  const post = await loadForDecision(ctx, id);
  if (!post) return;
  const by = nameOf(ctx);
  post.status = 'rejected';
  post.decidedBy = by;
  post.decidedAt = Date.now();
  post.reason = interaction.fields.getTextInputValue('reason').trim().slice(0, 500) || undefined;
  await services.posts.put(post);
  if (interaction.isFromMessage()) await interaction.update(decisionMessage(post));
  else await interaction.reply({ content: 'Rejected.', ...ephemeral });
  await services.audit.record({
    actorId: interaction.user.id,
    actorName: interaction.user.username,
    action: 'Post rejected',
    target: `<@${post.authorId}>`,
    detail: `${draftLabel(post.draft)}${post.reason ? `: ${post.reason}` : ''}`,
    ok: true,
    guildId: post.guildId,
  });
  await tellAuthor(
    interaction.client,
    post,
    `❌ Your ${draftLabel(post.draft)} was not approved by ${by}.${post.reason ? `\nReason: ${post.reason}` : ''}\nYou can change it and send it again.`,
    services,
  );
}

/**
 * Approve or reject from the admin dashboard: same result as the buttons, and the approval-queue
 * message in Discord is updated to match.
 */
export async function decideFromDashboard(
  services: Services,
  client: Client,
  id: string,
  d: { approve: boolean; by: string; byDiscordId: string; reason?: string },
): Promise<PendingPost> {
  const post = await services.posts.get(id);
  if (!post) throw new UserFacingError('That request is no longer on file.');
  if (post.status !== 'pending') throw new UserFacingError(`It was already ${post.status} by ${post.decidedBy ?? 'someone'}.`);
  if (inFlight.has(id)) throw new UserFacingError('Someone is deciding on this right now.');
  inFlight.add(id);
  try {
    let queueMsg: Message | null = null;
    if (post.queue) {
      const ch = await client.channels.fetch(post.queue.channelId).catch(() => null);
      if (ch && 'messages' in ch) queueMsg = await ch.messages.fetch(post.queue.messageId).catch(() => null);
    }
    if (d.approve) {
      const name = post.draft.imageName;
      const att = name && queueMsg ? queueMsg.attachments.find((a) => a.name === name) : undefined;
      let image: ImageFile | undefined = att && name ? { attachment: att.url, name } : undefined;
      if (!image && name && post.draft.type === 'ssu') image = bannerFile(services.config.dataDir, (await services.guilds.get(post.guildId)).ssuBanner);
      const { url } = await publish(services, client, post, d.by, image);
      post.status = 'approved';
      post.postUrl = url;
    } else {
      post.status = 'rejected';
      post.reason = d.reason?.trim().slice(0, 500) || undefined;
    }
    post.decidedBy = d.by;
    post.decidedAt = Date.now();
    await services.posts.put(post);
    if (queueMsg) await queueMsg.edit(decisionMessage(post)).catch((err) => services.logger.warn({ err }, 'could not update the approval-queue message'));
    await services.audit.record({
      actorId: d.byDiscordId,
      actorName: `${d.by} (dashboard)`,
      action: d.approve ? 'Post approved' : 'Post rejected',
      target: `<@${post.authorId}>`,
      detail: d.approve ? `${draftLabel(post.draft)} in <#${post.channelId}>: ${post.postUrl}` : `${draftLabel(post.draft)}${post.reason ? `: ${post.reason}` : ''}`,
      ok: true,
      guildId: post.guildId,
    });
    await tellAuthor(
      client,
      post,
      d.approve
        ? `✅ Your ${draftLabel(post.draft)} was approved by ${d.by} and posted: ${post.postUrl}`
        : `❌ Your ${draftLabel(post.draft)} was not approved by ${d.by}.${post.reason ? `\nReason: ${post.reason}` : ''}\nYou can change it and send it again.`,
      services,
    );
    return post;
  } finally {
    inFlight.delete(id);
  }
}
