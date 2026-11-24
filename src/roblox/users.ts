import { TtlCache } from '../util/cache.js';
import type { RobloxHttp } from './http.js';

/** Roblox user lookups through the public users / thumbnails web APIs (no key needed). */
export interface RobloxUser {
  id: number;
  name: string;
  displayName: string;
  /** profile "About" text; only filled by getById */
  description?: string;
  created?: string;
  isBanned?: boolean;
}

interface UsernameLookup {
  data?: { id?: number; name?: string; displayName?: string; requestedUsername?: string }[];
}

interface UserById {
  id?: number;
  name?: string;
  displayName?: string;
  description?: string;
  created?: string;
  isBanned?: boolean;
}

interface Thumbs {
  data?: { targetId?: number; state?: string; imageUrl?: string }[];
}

const USERNAME = /^[A-Za-z0-9_]{3,20}$/;

export class UsersClient {
  private readonly byId = new TtlCache<number, RobloxUser | null>(5 * 60_000, 2000);
  private readonly byName = new TtlCache<string, RobloxUser | null>(5 * 60_000, 2000);
  private readonly thumbs = new TtlCache<number, string | null>(30 * 60_000, 2000);

  constructor(private readonly http: RobloxHttp) {}

  /** Accepts a username ("Name" or "@Name"), a numeric user ID, or a roblox.com profile link. */
  async resolve(query: string): Promise<RobloxUser | null> {
    const q = query.trim();
    const link = /roblox\.com\/users\/(\d+)/i.exec(q);
    if (link) return this.getById(Number(link[1]));
    if (/^\d{1,19}$/.test(q)) return this.getById(Number(q));
    const name = q.replace(/^@/, '');
    if (!USERNAME.test(name)) return null;
    return this.getByUsername(name);
  }

  async getById(id: number, { fresh = false } = {}): Promise<RobloxUser | null> {
    if (fresh) this.byId.delete(id);
    return this.byId.getOrLoad(id, async () => {
      const res = await this.http.get<UserById>(`https://users.roblox.com/v1/users/${id}`, { allowNotFound: true });
      if (!res?.data?.id) return null;
      const d = res.data;
      return {
        id: d.id!,
        name: d.name ?? String(id),
        displayName: d.displayName ?? d.name ?? String(id),
        description: d.description ?? '',
        created: d.created,
        isBanned: d.isBanned,
      };
    });
  }

  async getByUsername(name: string): Promise<RobloxUser | null> {
    return this.byName.getOrLoad(name.toLowerCase(), async () => {
      const res = await this.http.post<UsernameLookup>('https://users.roblox.com/v1/usernames/users', {
        body: { usernames: [name], excludeBannedUsers: false },
      });
      const u = res.data?.data?.[0];
      if (!u?.id) return null;
      return { id: u.id, name: u.name ?? name, displayName: u.displayName ?? u.name ?? name };
    });
  }

  /** Avatar headshot URL, or null if Roblox hasn't rendered one. */
  async headshotUrl(id: number): Promise<string | null> {
    return this.thumbs.getOrLoad(id, async () => {
      try {
        const res = await this.http.get<Thumbs>('https://thumbnails.roblox.com/v1/users/avatar-headshot', {
          query: { userIds: id, size: '150x150', format: 'Png', isCircular: 'false' },
        });
        const t = res.data?.data?.[0];
        return t?.state === 'Completed' && t.imageUrl ? t.imageUrl : null;
      } catch {
        return null; // a missing picture never fails a command
      }
    });
  }
}

export const profileUrl = (id: number) => `https://www.roblox.com/users/${id}/profile`;
