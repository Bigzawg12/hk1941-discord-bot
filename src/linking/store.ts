import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** One Discord account linked to one Roblox account. */
export interface AccountLink {
  discordId: string;
  robloxId: number;
  robloxName: string;
  /** how it was verified */
  method: 'blurb' | 'bloxlink' | 'rover' | 'manual';
  linkedAt: number;
}

export interface LinkStore {
  get(discordId: string): Promise<AccountLink | null>;
  findByRoblox(robloxId: number): Promise<AccountLink | null>;
  set(link: AccountLink): Promise<void>;
  remove(discordId: string): Promise<boolean>;
  all(): Promise<AccountLink[]>;
}

export class MemoryLinkStore implements LinkStore {
  protected readonly links = new Map<string, AccountLink>();

  async get(discordId: string) {
    return this.links.get(discordId) ?? null;
  }
  async findByRoblox(robloxId: number) {
    for (const l of this.links.values()) if (l.robloxId === robloxId) return l;
    return null;
  }
  async set(link: AccountLink) {
    // one Roblox account per Discord account and the other way round
    for (const [id, l] of this.links) if (l.robloxId === link.robloxId && id !== link.discordId) this.links.delete(id);
    this.links.set(link.discordId, link);
  }
  async remove(discordId: string) {
    return this.links.delete(discordId);
  }
  async all() {
    return [...this.links.values()];
  }
}

/**
 * Links kept in a JSON file (DATA_DIR/links.json). Writes go to a temp file and are renamed into
 * place, so a crash can't leave half a file. Fine for one bot process; swap for a database
 * (implement LinkStore) if you ever run several.
 */
export class JsonFileLinkStore extends MemoryLinkStore {
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    super();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { links?: AccountLink[] };
      for (const l of raw.links ?? []) if (l?.discordId && l.robloxId) this.links.set(l.discordId, l);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private save(): Promise<void> {
    const body = JSON.stringify({ version: 1, links: [...this.links.values()] }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, this.file);
    });
    return this.writing;
  }

  override async get(discordId: string) {
    await this.load();
    return super.get(discordId);
  }
  override async findByRoblox(robloxId: number) {
    await this.load();
    return super.findByRoblox(robloxId);
  }
  override async set(link: AccountLink) {
    await this.load();
    await super.set(link);
    await this.save();
  }
  override async remove(discordId: string) {
    await this.load();
    const had = await super.remove(discordId);
    if (had) await this.save();
    return had;
  }
  override async all() {
    await this.load();
    return super.all();
  }
}
