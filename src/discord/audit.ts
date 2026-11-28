import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

/** A kept audit entry (for the dashboard's Audit log page). */
export interface StoredAudit extends Omit<AuditEntry, 'guildId'> {
  /** unix ms */
  t: number;
  guildId?: string;
}

/** How many entries are kept (oldest dropped first). */
export const AUDIT_KEEP = 20_000;

/**
 * Every staff action goes to the log, is kept in DATA_DIR/audit.json for the dashboard, to the audit channel the server set with /setup, and to
 * AUDIT_CHANNEL_ID (an optional central channel that collects every server's actions).
 */
export class AuditLog {
  private client: Client | null = null;
  private kept: StoredAudit[] | null = null;
  private writing: Promise<void> = Promise.resolve();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly centralChannelId?: string,
    private readonly guilds?: GuildSettingsStore,
    private readonly file: string | null = null,
  ) {}

  private async load(): Promise<StoredAudit[]> {
    if (this.kept) return this.kept;
    this.kept = [];
    if (!this.file) return this.kept;
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (Array.isArray(raw)) this.kept = raw.filter((e): e is StoredAudit => !!e && typeof e === 'object' && typeof (e as StoredAudit).t === 'number');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn({ err }, 'could not read the audit history');
    }
    return this.kept;
  }

  /** Save soon (a burst of actions is written once). */
  private saveSoon(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 2000);
    this.saveTimer.unref?.();
  }

  /** Write the history now (also used at shutdown). */
  flush(): Promise<void> {
    if (!this.file || !this.kept) return Promise.resolve();
    const file = this.file;
    const body = JSON.stringify(this.kept);
    this.writing = this.writing
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, body, 'utf8');
        await rename(`${file}.tmp`, file);
      })
      .catch((err) => this.logger.warn({ err }, 'could not save the audit history'));
    return this.writing;
  }

  /** Newest first. */
  async list(): Promise<StoredAudit[]> {
    return (await this.load()).slice();
  }

  attach(client: Client): void {
    this.client = client;
  }

  async record(e: AuditEntry): Promise<void> {
    const { guildId, ...entry } = e;
    this.logger.info({ audit: entry, guildId }, `audit: ${e.action}`);
    const kept = await this.load();
    kept.unshift({ ...entry, t: Date.now(), guildId: guildId ?? undefined });
    if (kept.length > AUDIT_KEEP) kept.length = AUDIT_KEEP;
    this.saveSoon();
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
