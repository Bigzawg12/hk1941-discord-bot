import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Services } from '../types.js';
import { mapLimit } from '../util/cache.js';

/**
 * Who is active in each group. Once a day (and on demand) the bot reads the service record of
 * every member of the army group and the divisions, and keeps:
 *   - when they last played, and how many trainings they did in the last 30 days, from the record;
 *   - a daily snapshot of their total time played and in the field, so "played this week" is the
 *     difference from a week ago (it fills in over the first week).
 * Kept in DATA_DIR/activity.json.
 */

export type ActivityStatus = 'active' | 'quiet' | 'inactive' | 'none';

export interface ActivityRow {
  /** last time they joined the game (unix seconds), 0 if never */
  lastJoin: number;
  /** total minutes played / deployed, from their record */
  play: number;
  field: number;
  trainings30: number;
  hasProfile: boolean;
  checkedAt: number;
}

interface ActivityData {
  version: 1;
  /** per user: YYYY-MM-DD -> [minutes played, minutes in the field] */
  snaps: Record<string, Record<string, [number, number]>>;
  rows: Record<string, ActivityRow>;
  /** per group: its members when last checked */
  members: Record<string, { userId: number; roleId: number }[]>;
  checked: Record<string, number>;
}

/** Days since they last played for each status. */
export const ACTIVE_DAYS = 7;
export const QUIET_DAYS = 21;
const KEEP_DAYS = 40;
const MAX_MEMBERS = 1500;

export const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function statusOf(row: ActivityRow | undefined, nowMs: number): ActivityStatus {
  if (!row || !row.hasProfile || !row.lastJoin) return 'none';
  const days = (nowMs / 1000 - row.lastJoin) / 86400;
  return days <= ACTIVE_DAYS ? 'active' : days <= QUIET_DAYS ? 'quiet' : 'inactive';
}

export class ActivityTracker {
  private data: ActivityData | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly running = new Map<number, Promise<void>>();
  lastError: string | null = null;

  constructor(
    private readonly services: Services,
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  private async load(): Promise<ActivityData> {
    if (this.data) return this.data;
    this.data = { version: 1, snaps: {}, rows: {}, members: {}, checked: {} };
    if (this.file) {
      try {
        const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<ActivityData>;
        this.data = { version: 1, snaps: raw.snaps ?? {}, rows: raw.rows ?? {}, members: raw.members ?? {}, checked: raw.checked ?? {} };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.services.logger.warn({ err }, 'could not read the activity history');
      }
    }
    return this.data;
  }

  private async save(): Promise<void> {
    if (!this.file || !this.data) return;
    const file = this.file;
    const body = JSON.stringify(this.data);
    this.writing = this.writing
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, body, 'utf8');
        await rename(`${file}.tmp`, file);
      })
      .catch((err) => this.services.logger.warn({ err }, 'could not save the activity history'));
    await this.writing;
  }

  isRunning(groupId: number): boolean {
    return this.running.has(groupId);
  }

  /** Read every member of one group and their records. One at a time per group. */
  refreshGroup(groupId: number): Promise<void> {
    let run = this.running.get(groupId);
    if (run) return run;
    run = (async () => {
      const data = await this.load();
      const members: { userId: number; roleId: number }[] = [];
      let pageToken: string | undefined;
      do {
        const page = await this.services.groups.listMembers(groupId, { pageToken, pageSize: 100 });
        for (const m of page.members) if (!members.some((x) => x.userId === m.userId)) members.push({ userId: m.userId, roleId: m.roleId });
        if (!page.members.length || page.nextPageToken === pageToken) break; // nothing new: stop
        pageToken = page.nextPageToken;
      } while (pageToken && members.length < MAX_MEMBERS);
      const t = this.now();
      const today = day(t);
      const since30 = t / 1000 - 30 * 86400;
      await mapLimit(members, 4, async (m) => {
        const p = await this.services.profiles.get(m.userId).catch(() => null);
        const d = p?.data;
        const row: ActivityRow = d
          ? {
              lastJoin: d.service.lastJoin,
              play: d.service.playtime,
              field: d.service.deployedTime,
              trainings30: d.training.history.filter((h) => (h.t ?? 0) >= since30).length,
              hasProfile: true,
              checkedAt: t,
            }
          : { lastJoin: 0, play: 0, field: 0, trainings30: 0, hasProfile: false, checkedAt: t };
        data.rows[m.userId] = row;
        if (d) {
          const snaps = (data.snaps[m.userId] ??= {});
          snaps[today] = [row.play, row.field];
          const cutoff = day(t - KEEP_DAYS * 86400_000);
          for (const k of Object.keys(snaps)) if (k < cutoff) delete snaps[k];
        }
      });
      data.members[groupId] = members;
      data.checked[groupId] = t;
      this.lastError = null;
      await this.save();
    })()
      .catch((err: unknown) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      })
      .finally(() => this.running.delete(groupId));
    this.running.set(groupId, run);
    return run;
  }

  /** The army group and every division, one after another. */
  async refreshAll(): Promise<void> {
    const ids = [this.services.config.roblox.armyGroupId, ...(await this.services.divisions.list()).map((e) => e.groupId)];
    for (const id of [...new Set(ids)]) {
      await this.refreshGroup(id).catch((err) => this.services.logger.warn({ err, groupId: id }, 'activity check failed'));
    }
  }

  /** Check every group if the last full check is older than a day. */
  async refreshIfStale(): Promise<void> {
    const data = await this.load();
    const oldest = Math.min(Date.now(), ...Object.values(data.checked));
    if (!Object.keys(data.checked).length || this.now() - oldest > 20 * 3600_000) await this.refreshAll();
  }

  /** Members of a group when it was last checked, with their activity. */
  async group(groupId: number): Promise<{ checkedAt?: number; members: { userId: number; roleId: number; row?: ActivityRow; week?: number; month?: number }[] }> {
    const data = await this.load();
    const members = data.members[groupId] ?? [];
    return {
      checkedAt: data.checked[groupId],
      members: members.map((m) => ({ ...m, row: data.rows[m.userId], ...this.deltas(data, m.userId) })),
    };
  }

  /** One person's activity (from the last check that included them). */
  async person(userId: number): Promise<{ row?: ActivityRow; week?: number; month?: number }> {
    const data = await this.load();
    return { row: data.rows[userId], ...this.deltas(data, userId) };
  }

  /** Minutes played in the last 7 and 30 days, when there's a snapshot old enough. */
  private deltas(data: ActivityData, userId: number): { week?: number; month?: number } {
    const snaps = data.snaps[userId];
    const row = data.rows[userId];
    if (!snaps || !row?.hasProfile) return {};
    const dates = Object.keys(snaps).sort();
    const since = (days: number) => {
      const target = day(row.checkedAt - days * 86400_000);
      const base = [...dates].reverse().find((d) => d <= target);
      return base ? Math.max(0, row.play - snaps[base]![0]) : undefined;
    };
    return { week: since(7), month: since(30) };
  }
}
