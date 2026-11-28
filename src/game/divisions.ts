import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The Roblox groups the dashboard looks after: the army group (always there, from ARMY_GROUP_ID)
 * and any divisions added on the Groups page. Kept in DATA_DIR/divisions.json.
 */
export interface DivisionEntry {
  groupId: number;
  /** a short name for the dashboard; empty = the Roblox group's name */
  label?: string;
  /** invite to the division's own Discord, e.g. https://discord.gg/abc */
  discordInvite?: string;
  /** a Discord server the bot is in that belongs to this group */
  guildId?: string;
  addedAt: number;
  addedBy: string;
}

export class DivisionStore {
  private entries: Map<number, DivisionEntry> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string | null) {}

  private async load(): Promise<Map<number, DivisionEntry>> {
    if (this.entries) return this.entries;
    this.entries = new Map();
    if (!this.file) return this.entries;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { groups?: DivisionEntry[] };
      for (const e of raw.groups ?? []) if (e && Number.isSafeInteger(e.groupId) && e.groupId > 0) this.entries.set(e.groupId, e);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return this.entries;
  }

  private async save(): Promise<void> {
    if (!this.file || !this.entries) return;
    const file = this.file;
    const body = JSON.stringify({ version: 1, groups: [...this.entries.values()] }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, body, 'utf8');
      await rename(`${file}.tmp`, file);
    });
    await this.writing;
  }

  async list(): Promise<DivisionEntry[]> {
    return [...(await this.load()).values()].map((e) => ({ ...e }));
  }

  async get(groupId: number): Promise<DivisionEntry | null> {
    const e = (await this.load()).get(groupId);
    return e ? { ...e } : null;
  }

  async put(e: DivisionEntry): Promise<void> {
    (await this.load()).set(e.groupId, { ...e });
    await this.save();
  }

  async remove(groupId: number): Promise<boolean> {
    const had = (await this.load()).delete(groupId);
    if (had) await this.save();
    return had;
  }
}
