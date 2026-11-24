import { EmbedBuilder, type Client } from 'discord.js';
import type { Logger } from '../logger.js';

export interface AuditEntry {
  /** Discord user ID of the staff member */
  actorId: string;
  actorName: string;
  action: string;
  target?: string;
  detail?: string;
  ok: boolean;
}

/** Every staff action goes to the log, and to AUDIT_CHANNEL_ID when one is set. */
export class AuditLog {
  private client: Client | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly channelId?: string,
  ) {}

  attach(client: Client): void {
    this.client = client;
  }

  async record(e: AuditEntry): Promise<void> {
    this.logger.info({ audit: e }, `audit: ${e.action}`);
    if (!this.channelId || !this.client) return;
    try {
      const channel = await this.client.channels.fetch(this.channelId);
      if (!channel?.isSendable()) return;
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
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
      this.logger.warn({ err }, 'could not post to the audit channel');
    }
  }
}
