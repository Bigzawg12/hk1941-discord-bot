import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** An info panel the bot posted (rules, guidebook…), so the dashboard can list and edit it. */
export interface PanelRecord {
  messageId: string;
  guildId: string;
  channelId: string;
  title: string;
  /** Discord user ID of whoever posted it */
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** name of whoever changed it last */
  updatedBy: string;
}

export interface PanelStore {
  get(messageId: string): Promise<PanelRecord | null>;
  put(p: PanelRecord): Promise<void>;
  remove(messageId: string): Promise<void>;
  /** most recently changed first; one server's, or every server's */
  list(guildId?: string): Promise<PanelRecord[]>;
}

export class MemoryPanelStore implements PanelStore {
  protected readonly panels = new Map<string, PanelRecord>();

  async get(messageId: string): Promise<PanelRecord | null> {
    const p = this.panels.get(messageId);
    return p ? { ...p } : null;
  }

  async put(p: PanelRecord): Promise<void> {
    this.panels.set(p.messageId, { ...p });
  }

  async remove(messageId: string): Promise<void> {
    this.panels.delete(messageId);
  }

  async list(guildId?: string): Promise<PanelRecord[]> {
    return [...this.panels.values()]
      .filter((p) => !guildId || p.guildId === guildId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => ({ ...p }));
  }
}

/** Kept in DATA_DIR/panels.json. */
export class JsonFilePanelStore extends MemoryPanelStore {
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    super();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { panels?: Record<string, PanelRecord> };
      for (const [id, p] of Object.entries(raw.panels ?? {})) {
        if (p && typeof p === 'object' && p.messageId === id && p.guildId && p.channelId) this.panels.set(id, p);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private save(): Promise<void> {
    const body = JSON.stringify({ version: 1, panels: Object.fromEntries(this.panels) }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, this.file);
    });
    return this.writing;
  }

  override async get(messageId: string) {
    await this.load();
    return super.get(messageId);
  }

  override async list(guildId?: string) {
    await this.load();
    return super.list(guildId);
  }

  override async put(p: PanelRecord) {
    await this.load();
    await super.put(p);
    await this.save();
  }

  override async remove(messageId: string) {
    await this.load();
    await super.remove(messageId);
    await this.save();
  }
}
