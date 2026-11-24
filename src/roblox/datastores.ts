import { OPEN_CLOUD, type RobloxHttp } from './http.js';

/**
 * READ-ONLY access to standard DataStores through Open Cloud (DataStores API v1).
 *
 * There is deliberately no write method here. Player profiles are session-locked by ProfileStore
 * in game, so a write from outside would be overwritten (or would corrupt a live session).
 * Every change goes through the in-game bridge instead (see src/bridge and roblox/DiscordBridge.server.luau).
 *
 * Key scope needed: universe-datastores.objects:read on the experience.
 */
export interface DataStoreEntry<T = unknown> {
  value: T;
  version?: string;
  /** When this version was written (ISO time). */
  updatedAt?: string;
  createdAt?: string;
  userIds: number[];
}

export class DataStoreReader {
  constructor(
    private readonly http: RobloxHttp,
    private readonly universeId: number,
  ) {}

  /** One entry, or null if the key doesn't exist. Keys may contain "/" (e.g. "HK1941_MP/log"); they are sent as a query parameter. */
  async getEntry<T = unknown>(datastoreName: string, entryKey: string, scope = 'global'): Promise<DataStoreEntry<T> | null> {
    const res = await this.http.get<T>(
      `${OPEN_CLOUD}/datastores/v1/universes/${this.universeId}/standard-datastores/datastore/entries/entry`,
      { auth: true, allowNotFound: true, query: { datastoreName, entryKey, scope } },
    );
    if (!res) return null;
    let userIds: number[] = [];
    const rawIds = res.headers.get('roblox-entry-userids');
    if (rawIds) {
      try {
        const parsed: unknown = JSON.parse(rawIds);
        if (Array.isArray(parsed)) userIds = parsed.filter((x): x is number => typeof x === 'number');
      } catch {
        /* header is informational only */
      }
    }
    return {
      value: res.data,
      version: res.headers.get('roblox-entry-version') ?? undefined,
      updatedAt: res.headers.get('roblox-entry-version-created-time') ?? undefined,
      createdAt: res.headers.get('roblox-entry-created-time') ?? undefined,
      userIds,
    };
  }
}
