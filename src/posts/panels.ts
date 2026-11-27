import { ButtonStyle, ComponentType, type Client, type Message } from 'discord.js';
import type { Services } from '../types.js';
import { UserFacingError } from '../util/errors.js';
import type { ImageFile } from './images.js';
import { buttonsToText, PANEL_COLOUR, renderPanel, type LinkButton, type PanelDraft } from './render.js';

/**
 * Info panels (rules, guidebook, how to join): shared by /panel and the dashboard's Panels page.
 * Each one the bot posts is remembered in services.panels so the dashboard can list it.
 */

export interface PanelContent {
  values: { title: string; body: string; buttons: string; footer: string };
  colour: number;
  /** a file attached to the message */
  image?: ImageFile;
  /** or a picture link */
  imageUrl?: string;
}

/** What a panel the bot posted says now. */
export function readPanel(msg: Message): PanelContent {
  const e = msg.embeds[0];
  if (!e) throw new UserFacingError("That message isn't an info panel.");
  const buttons: LinkButton[] = [];
  for (const row of msg.components) {
    if (row.type !== ComponentType.ActionRow) continue;
    for (const c of row.components) {
      if (c.type === ComponentType.Button && c.style === ButtonStyle.Link && c.url) buttons.push({ label: c.label ?? 'Link', url: c.url });
    }
  }
  const imgUrl = e.image?.url;
  let image: ImageFile | undefined;
  let imageUrl: string | undefined;
  if (imgUrl) {
    let imgName = '';
    try {
      imgName = decodeURIComponent(new URL(imgUrl).pathname.split('/').pop() ?? '');
    } catch {
      imgName = '';
    }
    const att = msg.attachments.find((a) => a.name === imgName) ?? msg.attachments.first();
    if (att) image = { attachment: att.url, name: att.name };
    else imageUrl = imgUrl;
  }
  return {
    values: { title: e.title ?? '', body: e.description ?? '', buttons: buttonsToText(buttons), footer: e.footer?.text ?? '' },
    colour: e.color ?? PANEL_COLOUR,
    image,
    imageUrl,
  };
}

/** The message, if it's still there and in that server. */
export async function fetchPanelMessage(client: Client, guildId: string, channelId: string, messageId: string): Promise<Message | null> {
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch || !('messages' in ch) || ('guildId' in ch && ch.guildId !== guildId)) return null;
  return ch.messages.fetch(messageId).catch(() => null);
}

/**
 * Post a new panel, or change one (messageId), and remember it. Returns the message link.
 * `guild` is used for the footer name and icon.
 */
export async function savePanel(
  services: Services,
  client: Client,
  opts: {
    guild: { id: string; name: string; iconURL?: () => string | null };
    channelId: string;
    messageId?: string;
    draft: PanelDraft;
    image?: ImageFile;
    by: { id: string; name: string };
  },
): Promise<{ url: string; messageId: string }> {
  const { guild } = opts;
  const out = renderPanel({ ...opts.draft, imageName: opts.image?.name, imageUrl: opts.image ? undefined : opts.draft.imageUrl }, guild);
  const ch = await client.channels.fetch(opts.channelId).catch(() => null);
  if (!ch?.isSendable() || ('guildId' in ch && ch.guildId !== guild.id)) {
    throw new UserFacingError(`I can't post in <#${opts.channelId}>. Give me View Channel, Send Messages, Embed Links and Attach Files there.`);
  }
  const payload = { ...out, files: opts.image ? [opts.image] : [], allowedMentions: { parse: [] } };
  let msg: Message;
  if (opts.messageId) {
    if (!('messages' in ch)) throw new UserFacingError("I can't find that panel's channel.");
    const old = await ch.messages.fetch(opts.messageId).catch(() => null);
    if (!old) throw new UserFacingError("That panel's message is gone. It may have been deleted in Discord.");
    if (old.author.id !== client.user?.id) throw new UserFacingError('I can only edit panels I posted.');
    msg = await old.edit({ ...payload, attachments: [] });
  } else {
    msg = await ch.send(payload);
  }
  const before = await services.panels.get(msg.id);
  const now = Date.now();
  await services.panels.put({
    messageId: msg.id,
    guildId: guild.id,
    channelId: opts.channelId,
    title: opts.draft.title.slice(0, 256),
    createdBy: before?.createdBy ?? opts.by.id,
    createdAt: before?.createdAt ?? now,
    updatedAt: now,
    updatedBy: opts.by.name,
  });
  return { url: `https://discord.com/channels/${guild.id}/${opts.channelId}/${msg.id}`, messageId: msg.id };
}
