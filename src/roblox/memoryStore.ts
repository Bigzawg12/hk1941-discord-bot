import { OPEN_CLOUD, type RobloxHttp } from './http.js';

/**
 * Reads MemoryStore sorted maps through Open Cloud (cloud/v2 memory-store API). The in-game bridge
 * writes two maps: acknowledgements for bot actions, and a heartbeat per live server.
 *
 * Key scope needed: memory-store.sorted-map:read (Creator Hub: "memory-store.sorted-map" -> Read).
 */
export interface SortedMapItem<T> {
  id: string;
  value: T;
  expireTime?: string;
}

interface RawItem {
  id?: string;
  path?: string;
  value?: unknown;
  expireTime?: string;
}

interface RawList {
  memoryStoreSortedMapItems?: RawItem[];
  nextPageToken?: string;
}

/** The bridge stores JSON strings; Open Cloud may hand them back as strings or as objects. */
export function decodeValue<T>(v: unknown): T {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return v as T;
    }
  }
  return v as T;
}

export class SortedMapReader {
  constructor(
    private readonly http: RobloxHttp,
    private readonly universeId: number,
  ) {}

  private base(map: string): string {
    return `${OPEN_CLOUD}/cloud/v2/universes/${this.universeId}/memory-store/sorted-maps/${encodeURIComponent(map)}/items`;
  }

  async getItem<T>(map: string, id: string): Promise<SortedMapItem<T> | null> {
    const res = await this.http.get<RawItem>(`${this.base(map)}/${encodeURIComponent(id)}`, { auth: true, allowNotFound: true });
    if (!res || !res.data) return null;
    return { id: res.data.id ?? id, value: decodeValue<T>(res.data.value), expireTime: res.data.expireTime };
  }

  async listItems<T>(map: string, { pageSize = 100, maxPages = 5 } = {}): Promise<SortedMapItem<T>[]> {
    const out: SortedMapItem<T>[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.http.get<RawList>(this.base(map), { auth: true, query: { maxPageSize: pageSize, pageToken } });
      for (const raw of res.data?.memoryStoreSortedMapItems ?? []) {
        const id = raw.id ?? raw.path?.split('/').pop() ?? '';
        out.push({ id, value: decodeValue<T>(raw.value), expireTime: raw.expireTime });
      }
      pageToken = res.data?.nextPageToken || undefined;
      if (!pageToken) break;
    }
    return out;
  }
}
