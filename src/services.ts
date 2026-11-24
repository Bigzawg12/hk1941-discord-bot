import { join } from 'node:path';
import { BridgeClient } from './bridge/client.js';
import type { BotConfig } from './config.js';
import { AuditLog } from './discord/audit.js';
import { JsonFileGuildSettingsStore, type GuildSettingsStore } from './guilds/settings.js';
import { BloxlinkProvider, RoVerProvider, type ExternalLinkProvider } from './linking/providers.js';
import { LinkService } from './linking/service.js';
import { JsonFileLinkStore, type LinkStore } from './linking/store.js';
import type { Logger } from './logger.js';
import { PermissionResolver } from './permissions/resolver.js';
import { DataStoreReader } from './roblox/datastores.js';
import { GlobalData } from './roblox/globalData.js';
import { GroupsClient } from './roblox/groups.js';
import { RobloxHttp, type FetchLike } from './roblox/http.js';
import { SortedMapReader } from './roblox/memoryStore.js';
import { MessagingPublisher } from './roblox/messaging.js';
import { ProfileReader } from './roblox/profiles.js';
import { ServerDirectory } from './roblox/servers.js';
import { UsersClient } from './roblox/users.js';
import { EventSync } from './sync/eventSync.js';
import type { Services } from './types.js';

export interface ServiceOverrides {
  fetch?: FetchLike;
  linkStore?: LinkStore;
  guildStore?: GuildSettingsStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Wire every module together. Tests pass a mocked fetch (and a memory link store) through `overrides`. */
export function createServices(config: BotConfig, logger: Logger, overrides: ServiceOverrides = {}): Services {
  const openCloud = new RobloxHttp({ apiKey: config.roblox.apiKey, fetch: overrides.fetch, logger, sleep: overrides.sleep });
  const publicWeb = new RobloxHttp({ fetch: overrides.fetch, logger, sleep: overrides.sleep }); // never carries the key

  const ds = new DataStoreReader(openCloud, config.roblox.universeId);
  const sortedMaps = new SortedMapReader(openCloud, config.roblox.universeId);
  const users = new UsersClient(publicWeb);
  const groups = new GroupsClient(openCloud);

  let provider: ExternalLinkProvider | undefined;
  if (config.linking.provider === 'bloxlink' && config.linking.bloxlinkApiKey) provider = new BloxlinkProvider(publicWeb, config.linking.bloxlinkApiKey);
  if (config.linking.provider === 'rover' && config.linking.roverApiKey) provider = new RoVerProvider(publicWeb, config.linking.roverApiKey);

  const links = new LinkService({
    store: overrides.linkStore ?? new JsonFileLinkStore(join(config.dataDir, 'links.json')),
    users,
    provider,
    codeTtlMinutes: config.linking.codeTtlMinutes,
    now: overrides.now,
  });

  const guilds = overrides.guildStore ?? new JsonFileGuildSettingsStore(join(config.dataDir, 'guilds.json'), overrides.now);

  const nowSec = overrides.now ? () => Math.floor(overrides.now!() / 1000) : undefined;

  const services: Services = {
    config,
    logger,
    users,
    groups,
    profiles: new ProfileReader(ds, config.roblox.profileStore),
    global: new GlobalData(ds, config.roblox.globalStore, nowSec),
    bridge: new BridgeClient({
      publisher: new MessagingPublisher(openCloud, config.roblox.universeId),
      acks: sortedMaps,
      config: config.bridge,
      logger,
      now: overrides.now,
      sleep: overrides.sleep,
    }),
    servers: new ServerDirectory({
      http: publicWeb,
      sortedMaps,
      serverMap: config.bridge.serverMap,
      placeId: config.roblox.placeId,
      logger,
      now: overrides.now,
    }),
    links,
    permissions: new PermissionResolver(config, { links, groups, guilds, logger }),
    audit: new AuditLog(logger, config.discord.auditChannelId, guilds),
    guilds,
    commands: new Map(),
    eventSync: undefined as unknown as EventSync, // set just below: it needs the finished services
  };
  services.eventSync = new EventSync(services, nowSec);
  return services;
}
