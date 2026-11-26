import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Draft } from './render.js';

/** A post or SSU waiting in a server's approval channel, and what happened to it. */
export interface PendingPost {
  id: string;
  guildId: string;
  /** where it goes once approved */
  channelId: string;
  authorId: string;
  draft: Draft;
  createdAt: number;
  /** the approval-queue message with the Approve / Reject buttons */
  queue?: { channelId: string; messageId: string };
  status: 'pending' | 'approved' | 'rejected';
  decidedBy?: string;
  decidedAt?: number;
  reason?: string;
  postUrl?: string;
}

export interface PostStore {
  get(id: string): Promise<PendingPost | null>;
  put(post: PendingPost): Promise<void>;
  /** newest first; one server's, or every server's */
  list(guildId?: string): Promise<PendingPost[]>;
}

/** Waiting posts expire after this long. */
export const PENDING_TTL_MS = 7 * 86400_000;
/** Decided posts are forgotten after this long. */
const DECIDED_KEEP_MS = 30 * 86400_000;

export class MemoryPostStore implements PostStore {
  protected readonly posts = new Map<string, PendingPost>();

  async get(id: string): Promise<PendingPost | null> {
    const p = this.posts.get(id);
    return p ? structuredClone(p) : null;
  }

  async put(post: PendingPost): Promise<void> {
    this.posts.set(post.id, structuredClone(post));
  }

  async list(guildId?: string): Promise<PendingPost[]> {
    return [...this.posts.values()]
      .filter((p) => !guildId || p.guildId === guildId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((p) => structuredClone(p));
  }
}

/** Kept in DATA_DIR/posts.json so the Approve buttons still work after a restart. */
export class JsonFilePostStore extends MemoryPostStore {
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { posts?: Record<string, PendingPost> };
      for (const [id, p] of Object.entries(raw.posts ?? {})) {
        if (p && typeof p === 'object' && p.id === id && p.draft) this.posts.set(id, p);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private save(): Promise<void> {
    const now = this.now();
    for (const [id, p] of this.posts) {
      const age = now - (p.decidedAt ?? p.createdAt);
      if ((p.status === 'pending' && age > PENDING_TTL_MS * 2) || (p.status !== 'pending' && age > DECIDED_KEEP_MS)) this.posts.delete(id);
    }
    const body = JSON.stringify({ version: 1, posts: Object.fromEntries(this.posts) }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, this.file);
    });
    return this.writing;
  }

  override async get(id: string) {
    await this.load();
    return super.get(id);
  }

  override async list(guildId?: string) {
    await this.load();
    return super.list(guildId);
  }

  override async put(post: PendingPost) {
    await this.load();
    await super.put(post);
    await this.save();
  }
}
