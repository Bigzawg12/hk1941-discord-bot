import type { DataStoreReader } from './datastores.js';
import { TtlCache } from '../util/cache.js';

/**
 * Server-wide game data. In game, ServerStorage.PlayerData keeps it all in ONE DataStore,
 * HK1941_Global, under keys "<area>/<key>" (e.g. "HK1941_MP/log"). The first time the game touches
 * a key it copies it over from the old per-system store (DataStore "<area>", key "<key>"), so for keys
 * that haven't been touched yet we fall back to reading the old store. Read only.
 */

/** HK1941_MP/log: newest first, up to MPConfig.MaxLog (120). */
export interface ArrestLogEntry {
  t?: number;
  who?: string;
  whoId?: number;
  by?: string;
  charges?: string[];
  minutes?: number;
  notes?: string;
}

/** HK1941_Events/list (HKAdmin ;event). start is unix seconds. */
export interface GameEvent {
  id: string;
  title: string;
  detail: string;
  start: number;
  host: string;
  unit?: string;
}

/** HK1941_Bans/u<userId>. untilT 0 = permanent. */
export interface BanRecord {
  untilT: number;
  reason?: string;
  by?: string;
  at?: number;
}

/** HK1941_Trainings/recent (TrainingServer log). */
export interface TrainingLogEntry {
  title?: string;
  pad?: string;
  host?: string;
  hostRole?: string;
  start?: number;
  ended?: number;
  people?: { name?: string; unit?: string; joined?: number; left?: number; result?: string }[];
  [k: string]: unknown;
}

export interface AdminLogEntry {
  t?: number;
  by?: string;
  text?: string;
}

export interface StaffEntry {
  tier: number;
  name?: string;
  by?: string;
  at?: number;
}

/** HKAdmin drops events 3 hours after they start. */
export const EVENT_KEEP_SECONDS = 3 * 3600;

export function pruneEvents(list: unknown, nowSec: number): GameEvent[] {
  if (!Array.isArray(list)) return [];
  return (list as GameEvent[])
    .filter((e) => e && typeof e.start === 'number' && e.start + EVENT_KEEP_SECONDS > nowSec)
    .sort((a, b) => a.start - b.start);
}

export function isBanActive(ban: BanRecord | null, nowSec: number): boolean {
  return !!ban && (ban.untilT === 0 || ban.untilT > nowSec);
}

export class GlobalData {
  private readonly cache = new TtlCache<string, unknown>(15_000, 200);

  constructor(
    private readonly ds: DataStoreReader,
    private readonly storeName: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Raw value of "<area>/<key>", falling back to the old store; null if neither has it. */
  async get<T>(area: string, key: string): Promise<T | null> {
    const id = `${area}/${key}`;
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached as T | null;
    let entry = await this.ds.getEntry<T>(this.storeName, id);
    if (!entry) entry = await this.ds.getEntry<T>(area, key); // not migrated yet
    const value = entry ? entry.value : null;
    this.cache.set(id, value);
    return value;
  }

  async arrestLog(): Promise<ArrestLogEntry[]> {
    const v = await this.get<ArrestLogEntry[]>('HK1941_MP', 'log');
    return Array.isArray(v) ? v : [];
  }

  async trainings(): Promise<TrainingLogEntry[]> {
    const v = await this.get<TrainingLogEntry[]>('HK1941_Trainings', 'recent');
    return Array.isArray(v) ? v : [];
  }

  /** Upcoming and running events, soonest first (same pruning as HKAdmin). */
  async events(): Promise<GameEvent[]> {
    return pruneEvents(await this.get('HK1941_Events', 'list'), this.now());
  }

  async ban(userId: number): Promise<BanRecord | null> {
    const v = await this.get<BanRecord>('HK1941_Bans', `u${userId}`);
    return v && typeof v === 'object' ? v : null;
  }

  async adminLog(): Promise<AdminLogEntry[]> {
    const v = await this.get<AdminLogEntry[]>('HK1941_AdminLog', 'recent');
    return Array.isArray(v) ? v : [];
  }

  /** In-game staff list (;mod add), userId (string) -> entry. */
  async staff(): Promise<Record<string, StaffEntry>> {
    const v = await this.get<Record<string, StaffEntry>>('HK1941_Staff', 'list');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  /** Forget cached values (after the bot asks the game to change something). */
  invalidate(area?: string, key?: string): void {
    if (area && key) this.cache.delete(`${area}/${key}`);
    else this.cache.clear();
  }
}
