import {
  AuditLogEvent,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildScheduledEvent,
  type PartialGuildScheduledEvent,
  type SendableChannels,
} from 'discord.js';
import { describeResult } from '../bridge/client.js';
import type { GuildSettings } from '../guilds/settings.js';
import { requiredTier, Tier } from '../permissions/tiers.js';
import type { GameEvent } from '../roblox/globalData.js';
import type { Services } from '../types.js';
import {
  announcementEmbed,
  calendarEmbed,
  calendarKey,
  gameUrl,
  joinButton,
  LOCATION,
  markerOf,
  planAnnouncements,
  planDiscordChanges,
  withMarker,
  type LinkedDiscordEvent,
} from './eventPlan.js';

type AnyScheduledEvent = GuildScheduledEvent | PartialGuildScheduledEvent;

/**
 * Keeps in-game events (HK1941_Global "HK1941_Events/list") and Discord in step, in every server:
 *  - game -> Discord: each server's Events tab gets every upcoming in-game event; cancelled and
 *    finished ones are removed. The server's event channel gets a calendar message and posts for
 *    new events, a reminder before the start (pinging the event role) and "starting now".
 *  - Discord -> game: an event staff create in the Events tab ("Somewhere else" type) is added to
 *    the game; cancelling a synced event in Discord cancels it in game. Same tier rule as
 *    /event schedule and cancel, and it needs a linked Roblox account.
 */
export class EventSync {
  private client: Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private soonTimer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly calendarKeys = new Map<string, string>();
  /** Discord events the bot itself deleted, so their delete events are ignored */
  private readonly botDeleted = new Set<string>();
  /** cancels already handled (Discord can send an update and a delete for one cancel) */
  private readonly handledCancels = new Set<string>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly services: Services,
    private readonly nowSec: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  private get cfg() {
    return this.services.config.events;
  }

  attach(client: Client): void {
    this.client = client;
  }

  start(): void {
    if (!this.cfg.sync || this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.cfg.syncSeconds * 1000);
    this.timer.unref?.();
    this.syncSoon(2000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.timer = this.soonTimer = null;
  }

  /** Run a sync shortly (after /event schedule, a /setup change, or a Discord-side change). */
  syncSoon(delayMs = 3000): void {
    if (!this.cfg.sync || !this.client) return;
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      void this.runOnce();
    }, delayMs);
    this.soonTimer.unref?.();
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  private warnOnce(key: string, msg: string, extra: object = {}): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.services.logger.warn(extra, msg);
  }

  private needTier(sub: 'schedule' | 'cancel'): number {
    const cmd = this.services.commands.get('event') ?? { data: { name: 'event' }, tier: Tier.Everyone, subTiers: { schedule: Tier.Moderator, cancel: Tier.Moderator } };
    return requiredTier(cmd, sub, this.services.config.permissions.commandTiers);
  }

  /** One pass over every server the bot is in. */
  async runOnce(): Promise<void> {
    const client = this.client;
    if (!client || this.running || !this.cfg.sync) return;
    this.running = true;
    try {
      this.services.global.invalidate('HK1941_Events', 'list');
      let events: GameEvent[];
      try {
        events = await this.services.global.events();
      } catch (err) {
        // never remove Discord events because the game list couldn't be read
        this.services.logger.warn({ err }, 'event sync: could not read the in-game events; skipped this round');
        return;
      }
      const now = this.nowSec();
      for (const guild of client.guilds.cache.values()) {
        await this.withLock(guild.id, () => this.syncGuild(guild, events, now)).catch((err: unknown) =>
          this.services.logger.warn({ err, guildId: guild.id }, 'event sync failed for a server'),
        );
      }
    } finally {
      this.running = false;
    }
  }

  private async syncGuild(guild: Guild, all: GameEvent[], now: number): Promise<void> {
    const s = await this.services.guilds.get(guild.id);
    if (s.eventSync === false) return;
    const skip = new Set(s.skipEventIds ?? []);
    const events = all.filter((e) => !skip.has(String(e.id)));

    await this.syncEventsTab(guild, events, now);
    if (s.eventChannelId) await this.syncChannel(guild, s, events, now);

    // forget skipped IDs that are no longer in the game
    const ids = new Set(all.map((e) => String(e.id)));
    if (s.skipEventIds?.some((id) => !ids.has(id))) {
      await this.services.guilds.update(guild.id, 'event sync', (x) => {
        x.skipEventIds = (x.skipEventIds ?? []).filter((id) => ids.has(id));
      });
    }
  }

  private async syncEventsTab(guild: Guild, events: GameEvent[], now: number): Promise<void> {
    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageEvents) || !me.permissions.has(PermissionFlagsBits.CreateEvents)) {
      this.warnOnce(`perm:${guild.id}`, 'event sync: the bot needs Create Events and Manage Events in this server (see README)', { guildId: guild.id });
      return;
    }
    const existing = await guild.scheduledEvents.fetch();
    const linked: LinkedDiscordEvent[] = [];
    for (const ev of existing.values()) {
      const gameId = markerOf(ev.entityMetadata?.location);
      if (gameId) {
        linked.push({ id: ev.id, gameId, live: ev.status === GuildScheduledEventStatus.Scheduled || ev.status === GuildScheduledEventStatus.Active });
      }
    }
    const plan = planDiscordChanges(events, linked, now);
    const placeId = this.services.config.roblox.placeId;
    for (const e of plan.create) {
      await guild.scheduledEvents.create({
        name: e.title.slice(0, 100),
        description: [e.detail, `Host: ${e.host || 'staff'}`, `Join: ${gameUrl(placeId)}`].filter(Boolean).join('\n').slice(0, 1000),
        scheduledStartTime: new Date(e.start * 1000),
        scheduledEndTime: new Date((e.start + this.cfg.lengthMinutes * 60) * 1000),
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location: withMarker(LOCATION, String(e.id)) },
        reason: `In-game event #${e.id}`,
      });
      this.services.logger.info({ guildId: guild.id, gameId: e.id }, 'event sync: added to the Events tab');
    }
    for (const id of plan.remove) {
      this.botDeleted.add(id);
      await guild.scheduledEvents.delete(id).catch((err: unknown) => {
        this.botDeleted.delete(id);
        this.services.logger.warn({ err, guildId: guild.id, id }, 'event sync: could not remove a Discord event');
      });
    }
  }

  private async syncChannel(guild: Guild, s: GuildSettings, events: GameEvent[], now: number): Promise<void> {
    const client = this.client!;
    const channel = await client.channels.fetch(s.eventChannelId!).catch(() => null);
    if (!channel?.isSendable()) {
      this.warnOnce(`chan:${guild.id}:${s.eventChannelId}`, 'event sync: cannot post in the event channel', { guildId: guild.id, channelId: s.eventChannelId });
      return;
    }
    const placeId = this.services.config.roblox.placeId;

    // the calendar: one message, edited when something changes
    const key = calendarKey(events, now);
    let calendarId = s.calendarMessageId;
    if (this.calendarKeys.get(guild.id) !== key || !calendarId) {
      const body = { embeds: [calendarEmbed(events, now)], components: [joinButton(placeId)], allowedMentions: { parse: [] as never[] } };
      let edited = false;
      if (calendarId && 'messages' in channel) {
        const msg = await channel.messages.fetch(calendarId).catch(() => null);
        if (msg?.editable) {
          await msg.edit(body);
          edited = true;
        }
      }
      if (!edited) calendarId = (await (channel as SendableChannels).send(body)).id;
      this.calendarKeys.set(guild.id, key);
    }

    // announcements
    const plan = planAnnouncements(events, s.eventState, now, this.cfg.remindMinutes);
    for (const { event, kind } of plan.posts) {
      const ping = kind === 'soon' && s.eventPingRoleId ? s.eventPingRoleId : undefined;
      await (channel as SendableChannels).send({
        content: ping ? `<@&${ping}>` : undefined,
        embeds: [announcementEmbed(event, kind)],
        components: [joinButton(placeId)],
        allowedMentions: { roles: ping ? [ping] : [] },
      });
    }
    if (plan.changed || calendarId !== s.calendarMessageId) {
      await this.services.guilds.update(guild.id, 'event sync', (x) => {
        x.eventState = plan.next;
        x.calendarMessageId = calendarId;
      });
    }
  }

  /** Forget the calendar so the next sync posts a fresh one (after the event channel changes). */
  resetChannel(guildId: string): void {
    this.calendarKeys.delete(guildId);
  }

  // ---------- Discord -> game ----------

  /** Staff made an event in the Events tab: add it to the game. */
  async onDiscordCreate(ev: GuildScheduledEvent): Promise<void> {
    const client = this.client;
    if (!client || !this.cfg.sync || !ev.guild) return;
    if (ev.creatorId === client.user?.id) return;
    if (ev.entityType !== GuildScheduledEventEntityType.External) return; // voice/stage events stay Discord-only
    if (markerOf(ev.entityMetadata?.location)) return;
    const guild = ev.guild;

    await this.withLock(guild.id, async () => {
      const s = await this.services.guilds.get(guild.id);
      if (s.eventSync === false || !ev.creatorId) return;
      if (!this.services.config.bridge.acksEnabled) {
        this.warnOnce('acks', 'event sync: Discord-made events are only copied to the game when BRIDGE_ACKS=true');
        return;
      }
      const member = await guild.members.fetch(ev.creatorId).catch(() => null);
      if (!member) return;
      const caller = await this.services.permissions.resolve({ discordId: member.id, roleIds: member.roles.cache.keys(), guildId: guild.id });
      if (caller.tier < this.needTier('schedule') || !caller.robloxId || !caller.robloxName) {
        this.services.logger.info({ guildId: guild.id, by: member.id, tier: caller.tier }, 'event sync: Discord event not copied (creator is not event staff with a linked account)');
        return;
      }
      const start = Math.floor((ev.scheduledStartTimestamp ?? 0) / 1000);
      const title = ev.name.slice(0, 60);
      const detail = (ev.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const res = await this.services.bridge.send('event_add', { d: member.id, r: caller.robloxId, n: caller.robloxName, t: caller.tier }, { start, title, detail });
      const gameId = res.ack?.ok ? res.ack.eventId : undefined;
      if (gameId) {
        await ev.edit({ entityMetadata: { location: withMarker(ev.entityMetadata?.location, gameId) }, reason: `Linked to in-game event #${gameId}` }).catch((err: unknown) =>
          this.services.logger.warn({ err }, 'event sync: could not tag the Discord event'),
        );
      }
      await this.services.audit.record({
        actorId: member.id,
        actorName: `${member.user.username} / ${caller.robloxName}`,
        action: 'Schedule event (Discord Events tab)',
        target: title,
        detail: gameId
          ? `Added to the game as #${gameId}`
          : `Not added to the game: ${describeResult(res, true)}\nUse /event schedule or ;event add once a server is up.`,
        ok: !!gameId,
        guildId: guild.id,
      });
    });
    this.syncSoon();
  }

  /** A synced event was cancelled or deleted in Discord. */
  async onDiscordCancel(ev: AnyScheduledEvent): Promise<void> {
    const client = this.client;
    if (!client || !this.cfg.sync) return;
    if (this.botDeleted.delete(ev.id)) return;
    if (this.handledCancels.has(ev.id)) return;
    const gameId = markerOf(ev.entityMetadata?.location);
    const guild = ev.guild ?? client.guilds.cache.get(ev.guildId);
    if (!gameId || !guild) return;
    this.handledCancels.add(ev.id);

    await this.withLock(guild.id, async () => {
      const s = await this.services.guilds.get(guild.id);
      if (s.eventSync === false) return;
      const executorId = await this.findExecutor(guild, ev.id);
      if (executorId && executorId !== client.user?.id) {
        const member = await guild.members.fetch(executorId).catch(() => null);
        const caller = member ? await this.services.permissions.resolve({ discordId: member.id, roleIds: member.roles.cache.keys(), guildId: guild.id }) : null;
        if (member && caller && caller.tier >= this.needTier('cancel') && caller.robloxId && caller.robloxName) {
          const res = await this.services.bridge.send('event_cancel', { d: member.id, r: caller.robloxId, n: caller.robloxName, t: caller.tier }, { eventId: gameId });
          await this.services.audit.record({
            actorId: member.id,
            actorName: `${member.user.username} / ${caller.robloxName}`,
            action: `Cancel event #${gameId} (Discord Events tab)`,
            detail: describeResult(res, this.services.config.bridge.acksEnabled),
            ok: res.ack?.ok !== false,
            guildId: guild.id,
          });
          return;
        }
      }
      // not someone who can cancel it in game (or unknown): just stop showing it in this server
      await this.services.guilds.update(guild.id, 'event sync', (x) => {
        x.skipEventIds = [...new Set([...(x.skipEventIds ?? []), gameId])];
      });
      this.services.logger.info({ guildId: guild.id, gameId, executorId }, 'event sync: event removed in Discord only; hidden in this server');
    });
    this.syncSoon();
  }

  /** Who deleted or cancelled a scheduled event, from the audit log (needs View Audit Log). */
  private async findExecutor(guild: Guild, eventId: string): Promise<string | null> {
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      this.warnOnce(`audit:${guild.id}`, 'event sync: give the bot View Audit Log so cancelling in Discord can cancel in game', { guildId: guild.id });
      return null;
    }
    const cutoff = Date.now() - 2 * 60_000;
    for (const type of [AuditLogEvent.GuildScheduledEventDelete, AuditLogEvent.GuildScheduledEventUpdate] as const) {
      const logs = await guild.fetchAuditLogs({ type, limit: 10 }).catch(() => null);
      const hit = logs?.entries.find((e) => e.targetId === eventId && e.createdTimestamp >= cutoff);
      if (hit?.executorId) return hit.executorId;
    }
    return null;
  }
}
