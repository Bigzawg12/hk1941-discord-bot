import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SectionBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type MessageMentionOptions,
} from 'discord.js';
import { UserFacingError } from '../util/errors.js';

/**
 * How the bot's posts look. Signed posts and SSUs use Discord's newer message layout ("components
 * v2"): a coloured container with text blocks, divider lines, link buttons and a picture. Info
 * panels are classic embeds with a server-name footer and link buttons under them.
 */

export const POST_KINDS = {
  recruitment: { label: 'Recruitment', colour: 0x3b7d3b },
  shout: { label: 'Shout', colour: 0x3a5f8a },
  notice: { label: 'Notice', colour: 0x8a7a4a },
  orders: { label: 'Orders', colour: 0xa33b3b },
  training: { label: 'Training', colour: 0x5b6e3a },
  event: { label: 'Event', colour: 0xc08a2a },
} as const;
export type PostKind = keyof typeof POST_KINDS;

export const COLOUR_CHOICES = {
  khaki: 0x8a7a4a,
  green: 0x3b7d3b,
  red: 0xa33b3b,
  blue: 0x3a5f8a,
  gold: 0xc08a2a,
  orange: 0xd9822b,
  grey: 0x6b6f73,
} as const;
export type ColourName = keyof typeof COLOUR_CHOICES;

export const SSU_COLOUR = COLOUR_CHOICES.orange;
export const PANEL_COLOUR = COLOUR_CHOICES.khaki;

/** Discord's cap on all text in one components-v2 message. */
export const TEXT_BUDGET = 4000;
/** Bigger pictures are refused before they reach Discord's upload limit. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_LINK_BUTTONS = 5;

export interface LinkButton {
  label: string;
  url: string;
}

export type Ping = { kind: 'none' } | { kind: 'here' } | { kind: 'everyone' } | { kind: 'role'; roleId: string };

export interface PostDraft {
  type: 'post';
  kind: PostKind;
  title: string;
  subtitle?: string;
  body: string;
  signature?: string;
  buttons: LinkButton[];
  colour: number;
  ping: Ping;
  /** file name of the picture sent with the message ("attachment://<name>") */
  imageName?: string;
}

export interface SsuDraft {
  type: 'ssu';
  /** one line under the heading */
  message: string;
  /** event text given by the person; when empty, the bot picks the game's current or next event */
  event?: string;
  colour: number;
  ping: Ping;
  imageName?: string;
  /** Roblox place the Join button opens */
  placeId: number;
}

export type Draft = PostDraft | SsuDraft;

/** Filled in when the message is built. */
export interface RenderMeta {
  authorId: string;
  /** "Approved by" name, or undefined while waiting */
  approvedBy?: string;
  /** SSU only: the game's event right now, worked out when it is posted */
  liveEvent?: { title: string; startsAt?: number };
  /** SSU only: "2 servers live · 18 playing" */
  serversLine?: string;
}

// ---------- text helpers ----------

/** Stop @everyone / @here written in the text from pinging; only the ping option pings. */
export function neutralise(text: string): string {
  return text.replace(/@(everyone|here)/g, '@​$1');
}

export interface GuildLookup {
  emojis?: { cache: Iterable<{ name: string | null; id: string; animated?: boolean | null }> | Map<string, { name: string | null; id: string; animated?: boolean | null }> };
  channels?: { cache: Iterable<{ name?: string | null; id: string }> | Map<string, { name?: string | null; id: string }> };
}

function values<T>(c: Iterable<T> | Map<string, T> | undefined): T[] {
  if (!c) return [];
  return c instanceof Map ? [...c.values()] : [...c];
}

/**
 * Modal text boxes can't pick emoji or channels, so `:name:` becomes this server's custom emoji and
 * `#channel-name` becomes a channel link, when one with that name exists. Everything else is left alone.
 */
export function expandText(text: string, guild?: GuildLookup | null): string {
  if (!guild) return text;
  const emojis = new Map<string, { id: string; animated?: boolean | null }>();
  for (const e of values(guild.emojis?.cache)) if (e.name) emojis.set(e.name.toLowerCase(), e);
  const channels = new Map<string, string>();
  for (const c of values(guild.channels?.cache)) if (c.name) channels.set(c.name.toLowerCase(), c.id);
  let out = text.replace(/(?<!<a?):([A-Za-z0-9_]{2,32}):(?!\d)/g, (whole, name: string) => {
    const e = emojis.get(name.toLowerCase());
    return e ? `<${e.animated ? 'a' : ''}:${name}:${e.id}>` : whole;
  });
  out = out.replace(/(^|[\s(])#([a-z0-9_-]{1,100})/gim, (whole, pre: string, name: string) => {
    const id = channels.get(name.toLowerCase());
    return id ? `${pre}<#${id}>` : whole;
  });
  return out;
}

/** Bold each line of a plain signature; leave it alone if it already has formatting. */
export function formatSignature(sig: string): string {
  const lines = sig.split('\n').map((l) => l.trim()).filter(Boolean);
  if (/\*|__|~~|`/.test(sig)) return lines.join('\n');
  return lines.map((l) => `**${l}**`).join('\n');
}

/** "Label | https://link" per line -> link buttons. */
export function parseButtons(text: string | null | undefined): LinkButton[] {
  const out: LinkButton[] = [];
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const bar = line.lastIndexOf('|');
    if (bar < 1) throw new UserFacingError(`Buttons go one per line as \`Label | https://link\`. This line has no "|": ${line.slice(0, 60)}`);
    const label = line.slice(0, bar).trim().slice(0, 80);
    const url = line.slice(bar + 1).trim();
    let ok = false;
    try {
      const u = new URL(url);
      ok = u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'discord:';
    } catch {
      ok = false;
    }
    if (!label || !ok) throw new UserFacingError(`Button "${label || '?'}" needs a full link starting with https:// (got "${url.slice(0, 60)}").`);
    out.push({ label, url });
  }
  if (out.length > MAX_LINK_BUTTONS) throw new UserFacingError(`At most ${MAX_LINK_BUTTONS} buttons.`);
  return out;
}

export function buttonsToText(buttons: LinkButton[]): string {
  return buttons.map((b) => `${b.label} | ${b.url}`).join('\n');
}

export function pingText(p: Ping): string | null {
  if (p.kind === 'here') return '@here';
  if (p.kind === 'everyone') return '@everyone';
  if (p.kind === 'role') return `<@&${p.roleId}>`;
  return null;
}

/** Only the chosen ping goes out: never the author, never other roles named in the text. */
export function allowedMentionsFor(p: Ping, live: boolean): MessageMentionOptions {
  if (!live || p.kind === 'none') return { parse: [] };
  if (p.kind === 'role') return { parse: [], roles: [p.roleId] };
  return { parse: ['everyone'] };
}

function linkRow(buttons: LinkButton[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    buttons.map((b) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(b.label).setURL(b.url)),
  );
}

export function joinUrl(placeId: number): string {
  return `https://www.roblox.com/games/${placeId}`;
}

// ---------- signed post ----------

export function renderPost(d: PostDraft, meta: RenderMeta): ContainerBuilder {
  const kind = POST_KINDS[d.kind];
  const texts: string[] = [];
  const c = new ContainerBuilder().setAccentColor(d.colour);
  const text = (s: string) => {
    texts.push(s);
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(s));
  };
  const line = (spacing = SeparatorSpacingSize.Small) => c.addSeparatorComponents((s) => s.setDivider(true).setSpacing(spacing));

  text(kind.label);
  line();
  const ping = pingText(d.ping);
  text(`**Sent by:** <@${meta.authorId}>${ping ? `\n**Ping:** ${ping}` : ''}`);
  text(`## ${d.title}${d.subtitle ? `\n*${d.subtitle}*` : ''}`);
  text(d.body);
  if (d.buttons.length) c.addActionRowComponents(linkRow(d.buttons));
  if (d.signature?.trim()) text(formatSignature(d.signature));
  if (d.imageName) c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${d.imageName}`)));
  line(SeparatorSpacingSize.Large);
  text(meta.approvedBy ? `**Approved by:** ${meta.approvedBy}` : '*Waiting for approval*');
  checkBudget(texts);
  return c;
}

// ---------- server start up ----------

export function renderSsu(d: SsuDraft, meta: RenderMeta): ContainerBuilder {
  const texts: string[] = [];
  const td = (s: string) => {
    texts.push(s);
    return new TextDisplayBuilder().setContent(s);
  };
  const c = new ContainerBuilder().setAccentColor(d.colour);
  const ping = pingText(d.ping);
  const head = [td('## Hong Kong 1941 | Server Start Up'), td(d.message)];
  if (ping) head.push(td(`Ping: ${ping}`));
  c.addSectionComponents(
    new SectionBuilder()
      .addTextDisplayComponents(head)
      .setButtonAccessory(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Join Hong Kong 1941').setURL(joinUrl(d.placeId))),
  );

  const event = d.event?.trim()
    ? { lead: 'Current event:', title: d.event.trim() }
    : meta.liveEvent
      ? {
          lead: meta.liveEvent.startsAt ? `An event starts <t:${meta.liveEvent.startsAt}:R>:` : 'There is currently an event taking place:',
          title: meta.liveEvent.title,
        }
      : null;
  if (event || meta.serversLine) {
    c.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    if (event) c.addTextDisplayComponents(td(`${event.lead}\n\`\`\`diff\n- ${event.title.replace(/`/g, "'").slice(0, 200)}\n\`\`\``));
    if (meta.serversLine) c.addTextDisplayComponents(td(`-# ${meta.serversLine}`));
  }
  c.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  c.addTextDisplayComponents(td(meta.approvedBy ? `Approved by: ${meta.approvedBy}` : '*Waiting for approval*'));
  if (d.imageName) {
    c.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${d.imageName}`)));
  }
  checkBudget(texts);
  return c;
}

export function renderDraft(d: Draft, meta: RenderMeta): ContainerBuilder {
  return d.type === 'post' ? renderPost(d, meta) : renderSsu(d, meta);
}

/** Short name for logs and the approval queue. */
export function draftLabel(d: Draft): string {
  return d.type === 'post' ? `${POST_KINDS[d.kind].label} post "${d.title.slice(0, 80)}"` : 'Server Start Up';
}

function checkBudget(texts: string[], extra = 0): void {
  const used = texts.reduce((n, t) => n + t.length, 0) + extra;
  if (used > TEXT_BUDGET - 300) {
    // 300 kept back for the approval-queue header
    throw new UserFacingError(`That's ${used - (TEXT_BUDGET - 300)} characters too long for one post. Shorten the text a little.`);
  }
}

/** A plain text block, for headers above a preview. */
export function textBlock(s: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(s);
}

/** What's left in the approval queue once a request is decided. */
export function renderDecision(opts: {
  draft: Draft;
  authorId: string;
  channelId: string;
  approved: boolean;
  by: string;
  at: number;
  reason?: string;
  postUrl?: string;
}): ContainerBuilder {
  const { draft, approved } = opts;
  const lines = [
    approved ? `✅ **Approved** by ${opts.by} <t:${Math.floor(opts.at / 1000)}:R>` : `❌ **Rejected** by ${opts.by} <t:${Math.floor(opts.at / 1000)}:R>`,
    `${draftLabel(draft)} from <@${opts.authorId}> for <#${opts.channelId}>`,
  ];
  if (opts.reason) lines.push(`**Reason:** ${opts.reason}`);
  if (opts.postUrl) lines.push(`[Open the post](${opts.postUrl})`);
  return new ContainerBuilder()
    .setAccentColor(approved ? COLOUR_CHOICES.green : COLOUR_CHOICES.red)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
}

// ---------- info panel (classic embed) ----------

export interface PanelDraft {
  title: string;
  body: string;
  footer?: string;
  buttons: LinkButton[];
  colour: number;
  imageName?: string;
}

export function renderPanel(d: PanelDraft, guild: { name: string; iconURL?: () => string | null } | null): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const embed = new EmbedBuilder().setColor(d.colour).setTitle(d.title).setDescription(d.body);
  const footer = d.footer?.trim() || guild?.name;
  if (footer) embed.setFooter({ text: footer.slice(0, 2048), iconURL: guild?.iconURL?.() ?? undefined });
  if (d.imageName) embed.setImage(`attachment://${d.imageName}`);
  return { embeds: [embed], components: d.buttons.length ? [linkRow(d.buttons)] : [] };
}
