import { unwrapProfileStore, type ProfileSnapshot } from '../game/profile.js';
import { TtlCache } from '../util/cache.js';
import type { DataStoreReader } from './datastores.js';

/** Reads HK1941 player profiles (store HK1941_Profiles, key "u<userId>"). Read only. */
export class ProfileReader {
  private readonly cache: TtlCache<number, ProfileSnapshot | null>;

  constructor(
    private readonly ds: DataStoreReader,
    private readonly storeName: string,
    cacheMs = 30_000,
  ) {
    this.cache = new TtlCache(cacheMs, 500);
  }

  /** The profile, or null if this user has never loaded into the game since profiles started. */
  async get(userId: number, { fresh = false } = {}): Promise<ProfileSnapshot | null> {
    if (fresh) this.cache.delete(userId);
    return this.cache.getOrLoad(userId, async () => {
      const entry = await this.ds.getEntry(this.storeName, `u${userId}`);
      if (!entry) return null;
      return unwrapProfileStore(entry.value, userId, { version: entry.version, updatedAt: entry.updatedAt });
    });
  }
}
