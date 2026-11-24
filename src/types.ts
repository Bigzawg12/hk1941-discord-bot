import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ClientEvents,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { BridgeClient } from './bridge/client.js';
import type { BotConfig } from './config.js';
import type { AuditLog } from './discord/audit.js';
import type { GuildSettingsStore } from './guilds/settings.js';
import type { LinkService } from './linking/service.js';
import type { Logger } from './logger.js';
import type { PermissionResolver, ResolvedTier } from './permissions/resolver.js';
import type { Tier } from './permissions/tiers.js';
import type { GlobalData } from './roblox/globalData.js';
import type { GroupsClient } from './roblox/groups.js';
import type { ProfileReader } from './roblox/profiles.js';
import type { ServerDirectory } from './roblox/servers.js';
import type { UsersClient } from './roblox/users.js';
import type { EventSync } from './sync/eventSync.js';

/** Everything a command can use. Built once in services.ts; tests build their own with mocks. */
export interface Services {
  config: BotConfig;
  logger: Logger;
  users: UsersClient;
  groups: GroupsClient;
  profiles: ProfileReader;
  global: GlobalData;
  bridge: BridgeClient;
  servers: ServerDirectory;
  links: LinkService;
  permissions: PermissionResolver;
  audit: AuditLog;
  /** per-server settings from /setup */
  guilds: GuildSettingsStore;
  /** in-game events <-> Discord Events tab and event channels */
  eventSync: EventSync;
  /** filled in by the loader */
  commands: Map<string, Command>;
}

export interface CommandContext<I = ChatInputCommandInteraction> {
  interaction: I;
  services: Services;
  /** the caller's tier and linked account */
  caller: ResolvedTier;
  logger: Logger;
}

export interface Command {
  /** the slash command definition (any discord.js builder) */
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  /** lowest tier allowed to use it (COMMAND_TIERS can override) */
  tier: Tier;
  /** per-subcommand minimum, when it differs from `tier` */
  subTiers?: Record<string, Tier>;
  /** short line for /help */
  help: string;
  execute(ctx: CommandContext): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction, services: Services): Promise<void>;
  /** buttons whose customId starts with "<command name>:" come here (after the same tier check) */
  button?(ctx: CommandContext<ButtonInteraction>): Promise<void>;
}

export interface BotEvent<K extends keyof ClientEvents = keyof ClientEvents> {
  name: K;
  once?: boolean;
  execute(services: Services, ...args: ClientEvents[K]): Promise<void> | void;
}

/** Helper so event files get typed arguments. */
export function defineEvent<K extends keyof ClientEvents>(e: BotEvent<K>): BotEvent<K> {
  return e;
}

export function defineCommand(c: Command): Command {
  return c;
}
