import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AnnounceState } from '../sync/eventPlan.js';

export type StaffTier = 1 | 2 | 3 | 4 | 5;

/** Like Bloxlink's group binds: members whose rank in `groupId` is between min and max get `roleId`. */
export interface RankBind {
  roleId: string;
  groupId: number;
  min: number;
  max: number;
}

/**
 * Settings for one Discord server, set with /setup. The bot works in any server it is in; each
 * server picks its own staff roles, audit channel and verified role here, so nothing in .env
 * has to name a server.
 */
export interface GuildSettings {
  /** Discord role ID -> staff tier, in this server only */
  staffRoles: Record<string, StaffTier>;
  /** where this server's staff actions are posted */
  auditChannelId?: string;
  /** role given here after /link verify */
  verifiedRoleId?: string;
  /** role for members who aren't linked (taken away once they are) */
  unverifiedRoleId?: string;
  /** nickname for linked members, e.g. "{roblox}" or "{rank} | {roblox}"; empty = leave nicknames alone */
  nicknameTemplate?: string;
  /** roles from Roblox group ranks */
  rankBinds?: RankBind[];
  /** mirror in-game events to and from this server's Events tab (default on) */
  eventSync?: boolean;
  /** channel with the event calendar and the event announcements */
  eventChannelId?: string;
  /** role pinged by the "starting soon" reminder */
  eventPingRoleId?: string;
  /** the calendar message the bot keeps editing */
  calendarMessageId?: string;
  /** which events have been announced here */
  eventState?: AnnounceState;
  /** in-game events this server removed from its Events tab without cancelling them in game */
  skipEventIds?: string[];
  /** where /post and /ssu requests from below the approver tier wait for approval */
  approvalChannelId?: string;
  /** default channel for /post */
  postChannelId?: string;
  /** default channel for /ssu (falls back to the post channel) */
  ssuChannelId?: string;
  /** SSU picture, relative to DATA_DIR (banners/<guildId>.<ext>) */
  ssuBanner?: string;
  /** lowest tier that can approve posts, or post without approval (default 3) */
  postApproverTier?: StaffTier;
  updatedAt?: number;
  updatedBy?: string;
}

export interface GuildSettingsStore {
  get(guildId: string): Promise<GuildSettings>;
  /** change one server's settings; `change` edits the copy it is given */
  update(guildId: string, by: string, change: (s: GuildSettings) => void): Promise<GuildSettings>;
}

const empty = (): GuildSettings => ({ staffRoles: {} });
const copy = (s: GuildSettings): GuildSettings => ({
  ...s,
  staffRoles: { ...s.staffRoles },
  rankBinds: s.rankBinds?.map((b) => ({ ...b })),
});

export class MemoryGuildSettingsStore implements GuildSettingsStore {
  protected readonly guilds = new Map<string, GuildSettings>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(guildId: string): Promise<GuildSettings> {
    return copy(this.guilds.get(guildId) ?? empty());
  }

  async update(guildId: string, by: string, change: (s: GuildSettings) => void): Promise<GuildSettings> {
    const next = copy(this.guilds.get(guildId) ?? empty());
    change(next);
    next.updatedAt = this.now();
    next.updatedBy = by;
    this.guilds.set(guildId, next);
    return copy(next);
  }
}

/** Kept in DATA_DIR/guilds.json, written the same safe way as links.json. */
export class JsonFileGuildSettingsStore extends MemoryGuildSettingsStore {
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    now?: () => number,
  ) {
    super(now);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { guilds?: Record<string, GuildSettings> };
      for (const [id, s] of Object.entries(raw.guilds ?? {})) {
        if (/^\d{15,25}$/.test(id) && s && typeof s === 'object') this.guilds.set(id, { ...s, staffRoles: { ...(s.staffRoles ?? {}) } });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private save(): Promise<void> {
    const body = JSON.stringify({ version: 1, guilds: Object.fromEntries(this.guilds) }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, this.file);
    });
    return this.writing;
  }

  override async get(guildId: string) {
    await this.load();
    return super.get(guildId);
  }

  override async update(guildId: string, by: string, change: (s: GuildSettings) => void) {
    await this.load();
    const out = await super.update(guildId, by, change);
    await this.save();
    return out;
  }
}
