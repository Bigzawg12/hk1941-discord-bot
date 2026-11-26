import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AdminLogEntry } from '../roblox/globalData.js';

/**
 * A longer history of HKAdmin's log. The game keeps only the latest 200 entries in
 * HK1941_Global "HK1941_AdminLog/recent" (newest first); the bot copies new ones here every few
 * minutes, so the dashboard can show weeks of commands. Read only on the game side.
 */

export interface GameLogEntry {
  /** unix seconds */
  t: number;
  /** Roblox username of whoever ran it ("server" for automatic entries) */
  by: string;
  /** the command as typed, e.g. ";kick Pte_X spawn killing" */
  text: string;
  /** sent from Discord through the bridge ("Name (Discord)" in the game log) */
  viaDiscord: boolean;
}

/** How many entries the archive keeps (oldest dropped first). */
export const ARCHIVE_MAX = 20_000;

const DISCORD_SUFFIX = ' (Discord)';

export function normaliseEntry(e: AdminLogEntry): GameLogEntry | null {
  if (!e || typeof e !== 'object' || typeof e.t !== 'number' || typeof e.text !== 'string') return null;
  let by = typeof e.by === 'string' && e.by ? e.by : 'server';
  const viaDiscord = by.endsWith(DISCORD_SUFFIX);
  if (viaDiscord) by = by.slice(0, -DISCORD_SUFFIX.length);
  return { t: Math.floor(e.t), by: by.slice(0, 40), text: e.text.slice(0, 500), viaDiscord };
}

/** The command word: ";kick Pte_X" -> "kick"; Discord entries ("ban 123 ...") have no prefix. */
export function commandOf(e: GameLogEntry): string {
  if (e.by === 'server') return 'system';
  const word = /^\s*[;:!/]?([A-Za-z_]+)/.exec(e.text)?.[1];
  return word ? word.toLowerCase() : 'other';
}

const keyOf = (e: GameLogEntry) => `${e.t}|${e.by}|${e.viaDiscord ? 1 : 0}|${e.text}`;

export class AdminLogArchive {
  private entries: GameLogEntry[] = [];
  private keys = new Set<string>();
  private loaded: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private refreshing: Promise<number> | null = null;
  /** unix ms of the last successful read from the game */
  lastRefresh = 0;
  lastError: string | null = null;

  constructor(
    private readonly read: () => Promise<AdminLogEntry[]>,
    private readonly file: string | null = null,
    private readonly now: () => number = Date.now,
  ) {}

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.file) return;
      try {
        const raw: unknown = JSON.parse(await readFile(this.file, 'utf8'));
        const list = Array.isArray(raw) ? raw : [];
        for (const x of list) {
          const e = x as GameLogEntry;
          if (e && typeof e.t === 'number' && typeof e.text === 'string' && typeof e.by === 'string') this.add({ t: e.t, by: e.by, text: e.text, viaDiscord: !!e.viaDiscord });
        }
        this.sort();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    })();
    return this.loaded;
  }

  private add(e: GameLogEntry): boolean {
    const k = keyOf(e);
    if (this.keys.has(k)) return false;
    this.keys.add(k);
    this.entries.push(e);
    return true;
  }

  private sort(): void {
    this.entries.sort((a, b) => b.t - a.t);
    if (this.entries.length > ARCHIVE_MAX) {
      for (const e of this.entries.splice(ARCHIVE_MAX)) this.keys.delete(keyOf(e));
    }
  }

  private save(): Promise<void> {
    if (!this.file) return Promise.resolve();
    const file = this.file;
    const data = JSON.stringify(this.entries);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, data, 'utf8');
      await rename(tmp, file);
    });
    return this.writing;
  }

  /** Copy new entries from the game. Returns how many were new. One read at a time. */
  refresh(): Promise<number> {
    this.refreshing ??= (async () => {
      try {
        await this.load();
        const fresh = (await this.read()).map(normaliseEntry).filter((e): e is GameLogEntry => !!e);
        let added = 0;
        for (const e of fresh) if (this.add(e)) added++;
        if (added) {
          this.sort();
          await this.save();
        }
        this.lastRefresh = this.now();
        this.lastError = null;
        return added;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Newest first. */
  async list(): Promise<GameLogEntry[]> {
    await this.load();
    return this.entries.slice();
  }
}
