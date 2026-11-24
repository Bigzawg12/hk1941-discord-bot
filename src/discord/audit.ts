import { EmbedBuilder, type Client } from 'discord.js';
import type { GuildSettingsStore } from '../guilds/settings.js';
import type { Logger } from '../logger.js';

export interface AuditEntry {
  /** Discord user ID of the staff member */
  actorId: string;
  actorName: string;
  action: string;
  target?: string;
  detail?: string;
  ok: boolean;
  /** the server it was done from: posted to that server's /setup audit channel */
  guildId?: string | null;
}

/**
 * Every staff action goes to the log, to the audit channel the server set with /setup, and to
 * AUDIT_CHANNEL_ID (an optional central channel that collects every server's actions).
 */
export class AuditLog {
  private client: Client | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly centralChannelId?: string,
    private readonly guilds?: GuildSettingsStore,
  ) {}

  attach(client: Client): void {
    this.client = client;
  }

  async record(e: AuditEntry): Promise<void> {
    const { guildId, ...entry } = e;
    this.logger.info({ audit: entry, guildId }, `audit: ${e.action}`);
    if (!this.client) return;
    const targets = new Set<string>();
    if (this.centralChannelId) targets.add(this.centralChannelId);
    if (guildId && this.guilds) {
      try {
        const own = (await this.guilds.get(guildId)).auditChannelId;
        if (own) targets.add(own);
      } catch (err) {
        this.logger.warn({ err, guildId }, 'could not read the server settings for the audit channel');
      }
    }
    if (!targets.size) return;

    const embed = new EmbedBuilder()
      .setColor(e.ok ? 0x3b7d3b : 0xa33b3b)
      .setTitle(e.action)
      .setDescription(
        [`**By** <@${e.actorId}> (${e.actorName})`, e.target ? `**Target** ${e.target}` : null, e.detail ?? null]
          .filter(Boolean)
          .join('\n')
          .slice(0, 4000),
      )
      .setTimestamp(new Date());
    for (const id of targets) {
      try {
        const channel = await this.client.channels.fetch(id);
        if (!channel?.isSendable()) continue;
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      } catch (err) {
        this.logger.warn({ err, channelId: id }, 'could not post to an audit channel');
      }
    }
  }
}
