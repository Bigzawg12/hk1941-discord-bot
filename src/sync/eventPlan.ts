import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { COLOURS, clip, esc } from '../discord/helpers.js';
import type { GameEvent } from '../roblox/globalData.js';
import { discordTime } from '../util/time.js';

/**
 * Pure planning for the event sync, kept apart from Discord calls so it can be tested.
 *
 * A Discord scheduled event is tied to an in-game event by a marker at the end of its location:
 * "Hong Kong 1941 (Roblox) · #1234". That survives restarts with nothing extra to store.
 */

export const LOCATION = 'Hong Kong 1941 (Roblox)';
const MARKER = /·\s*#(\d{1,8})\s*$/;

export function markerOf(location: string | null | undefined): string | null {
  const m = MARKER.exec(location ?? '');
  return m ? m[1]! : null;
}

/** Add (or replace) the marker, keeping within Discord's 100-character location limit. */
export function withMarker(location: string | null | undefined, gameId: string): string {
  const tag = ` · #${gameId}`;
  const base = (location ?? '').replace(MARKER, '').trim() || LOCATION;
  return base.slice(0, 100 - tag.length) + tag;
}

export interface LinkedDiscordEvent {
  /** Discord scheduled event ID */
  id: string;
  /** in-game event ID from the marker */
  gameId: string;
  /** still scheduled or running (not completed or cancelled) */
  live: boolean;
}

/**
 * What to change in one server's Events tab so it matches the in-game list.
 * Discord can't hold events that start in the past, so ones already running are not created.
 */
export function planDiscordChanges(
  game: GameEvent[],
  discord: LinkedDiscordEvent[],
  nowSec: number,
): { create: GameEvent[]; remove: string[] } {
  const inGame = new Set(game.map((e) => String(e.id)));
  const have = new Set(discord.filter((d) => d.live).map((d) => d.gameId));
  return {
    create: game.filter((e) => !have.has(String(e.id)) && e.start > nowSec + 60),
    remove: discord.filter((d) => d.live && !inGame.has(d.gameId)).map((d) => d.id),
  };
}

export type AnnounceKind = 'new' | 'soon' | 'now';

export interface AnnounceState {
  /** event IDs this server has seen; undefined until the first sync (so old events aren't re-announced) */
  seen?: string[];
  /** event ID -> 1 reminder sent, 2 "starting now" sent */
  stage: Record<string, number>;
}

const START_WINDOW = 10 * 60; // "starting now" is only posted within 10 minutes of the start

/** Which announcements to post this round, and the state to save afterwards. */
export function planAnnouncements(
  game: GameEvent[],
  state: AnnounceState | undefined,
  nowSec: number,
  remindMinutes: number,
): { posts: { event: GameEvent; kind: AnnounceKind }[]; next: AnnounceState; changed: boolean } {
  const first = !state || state.seen === undefined;
  const seen = new Set(state?.seen ?? []);
  const stage: Record<string, number> = {};
  const posts: { event: GameEvent; kind: AnnounceKind }[] = [];

  for (const e of game) {
    const id = String(e.id);
    let st = state?.stage[id] ?? 0;
    const soon = nowSec >= e.start - remindMinutes * 60 && nowSec < e.start;
    const started = nowSec >= e.start;

    if (first) {
      // first look at this server: remember everything, announce nothing old
      st = started ? 2 : soon ? 1 : 0;
    } else {
      if (!seen.has(id) && !started && !soon) posts.push({ event: e, kind: 'new' });
      if (soon && st < 1) {
        posts.push({ event: e, kind: 'soon' });
        st = 1;
      }
      if (started && st < 2) {
        if (nowSec < e.start + START_WINDOW) posts.push({ event: e, kind: 'now' });
        st = 2;
      }
    }
    if (st) stage[id] = st;
  }

  const next: AnnounceState = { seen: game.map((e) => String(e.id)), stage };
  const changed = JSON.stringify(next) !== JSON.stringify({ seen: state?.seen, stage: state?.stage ?? {} });
  return { posts, next, changed };
}

export function gameUrl(placeId: number): string {
  return `https://www.roblox.com/games/${placeId}`;
}

export function joinButton(placeId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Join Hong Kong 1941').setURL(gameUrl(placeId)),
  );
}

/** The calendar message kept up to date in a server's event channel. */
export function calendarEmbed(game: GameEvent[], nowSec: number): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLOURS.khaki)
    .setTitle('🗓️ Hong Kong 1941 · event calendar')
    .setFooter({ text: 'Times are in your own time zone. Updated automatically.' })
    .setTimestamp(new Date(nowSec * 1000));
  if (!game.length) {
    return embed.setDescription('No events scheduled yet.\nStaff: `/event schedule`, the Events tab, or `;event add` in game.');
  }
  for (const e of game.slice(0, 25)) {
    const live = nowSec >= e.start;
    embed.addFields({
      name: clip(`${live ? '🔴 On now · ' : ''}#${e.id} · ${e.title}`, 256),
      value: clip(
        [`${discordTime(e.start, 'F')} (${discordTime(e.start, 'R')})`, e.detail ? esc(e.detail) : null, `Host: ${esc(e.host || 'staff')}`]
          .filter(Boolean)
          .join('\n'),
        1024,
      ),
    });
  }
  return embed;
}

/** A fingerprint of what the calendar shows, so it is only edited when something changed. */
export function calendarKey(game: GameEvent[], nowSec: number): string {
  return JSON.stringify(game.slice(0, 25).map((e) => [e.id, e.start, e.title, e.detail, e.host, nowSec >= e.start]));
}

export function announcementEmbed(e: GameEvent, kind: AnnounceKind): EmbedBuilder {
  const when = `${discordTime(e.start, 'F')} (${discordTime(e.start, 'R')})`;
  const head = {
    new: { title: `🗓️ New event: ${e.title}`, colour: COLOURS.info, line: when },
    soon: { title: `⏰ Starting soon: ${e.title}`, colour: COLOURS.warn, line: `Starts ${discordTime(e.start, 'R')}. Get in game and fall in!` },
    now: { title: `🔔 Starting now: ${e.title}`, colour: COLOURS.ok, line: 'The event is starting. Join now!' },
  }[kind];
  return new EmbedBuilder()
    .setColor(head.colour)
    .setTitle(clip(head.title, 256))
    .setDescription(clip([head.line, e.detail ? esc(e.detail) : null, `Host: ${esc(e.host || 'staff')} · event #${e.id}`].filter(Boolean).join('\n'), 4000));
}
