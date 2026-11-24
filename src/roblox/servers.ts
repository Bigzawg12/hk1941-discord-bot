import type { Logger } from '../logger.js';
import type { RobloxHttp } from './http.js';
import type { SortedMapReader } from './memoryStore.js';

/**
 * Live servers. Open Cloud has no "list servers" endpoint, so:
 *  1. The bridge script writes a heartbeat per server to MemoryStore sorted map SERVER_MAP every
 *     30 s (expires after 120 s). That covers private/reserved servers and includes player names.
 *  2. If there are no heartbeats (bridge not installed, or the read fails), fall back to the public
 *     games API, which only lists public servers and player counts.
 */
export interface LiveServer {
  jobId: string;
  players: number;
  maxPlayers?: number;
  names?: string[];
  uptimeSec?: number;
  privateServer?: boolean;
  /** CaptureControl "status" text, if the server sent it */
  capture?: string;
  /** unix seconds of the last heartbeat */
  seenAt?: number;
  fps?: number;
  ping?: number;
}

export interface ServerList {
  source: 'bridge' | 'public' | 'none';
  servers: LiveServer[];
  error?: string;
}

/** What DiscordBridge.server.luau writes (keep in sync). */
export interface Heartbeat {
  job?: string;
  place?: number;
  n?: number;
  max?: number;
  names?: string[];
  up?: number;
  priv?: boolean;
  cap?: string;
  t?: number;
  v?: number;
}

interface PublicServers {
  data?: { id?: string; playing?: number; maxPlayers?: number; fps?: number; ping?: number }[];
  nextPageCursor?: string | null;
}

export class ServerDirectory {
  constructor(
    private readonly deps: {
      http: RobloxHttp;
      sortedMaps?: SortedMapReader;
      serverMap: string;
      placeId: number;
      logger?: Logger;
      now?: () => number;
      staleAfterSec?: number;
    },
  ) {}

  async list(): Promise<ServerList> {
    const nowSec = Math.floor((this.deps.now ?? Date.now)() / 1000);
    let bridgeError: string | undefined;
    if (this.deps.sortedMaps) {
      try {
        const items = await this.deps.sortedMaps.listItems<Heartbeat>(this.deps.serverMap);
        const stale = this.deps.staleAfterSec ?? 120;
        const servers = items
          .map((i) => i.value)
          .filter((h): h is Heartbeat => !!h && typeof h === 'object' && typeof h.job === 'string')
          .filter((h) => !h.t || nowSec - h.t <= stale)
          .map(
            (h): LiveServer => ({
              jobId: h.job!,
              players: h.n ?? h.names?.length ?? 0,
              maxPlayers: h.max,
              names: h.names,
              uptimeSec: h.up,
              privateServer: h.priv,
              capture: h.cap,
              seenAt: h.t,
            }),
          )
          .sort((a, b) => b.players - a.players);
        if (servers.length) return { source: 'bridge', servers };
      } catch (err) {
        bridgeError = (err as Error).message;
        this.deps.logger?.warn({ err }, 'server heartbeat read failed; falling back to public list');
      }
    }
    try {
      const servers: LiveServer[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const res = await this.deps.http.get<PublicServers>(`https://games.roblox.com/v1/games/${this.deps.placeId}/servers/Public`, {
          query: { limit: 100, sortOrder: 'Desc', cursor },
        });
        for (const s of res.data?.data ?? []) {
          if (!s.id) continue;
          servers.push({ jobId: s.id, players: s.playing ?? 0, maxPlayers: s.maxPlayers, fps: s.fps, ping: s.ping });
        }
        cursor = res.data?.nextPageCursor ?? undefined;
        if (!cursor) break;
      }
      return { source: servers.length ? 'public' : 'none', servers, error: bridgeError };
    } catch (err) {
      return { source: 'none', servers: [], error: (err as Error).message };
    }
  }
}
