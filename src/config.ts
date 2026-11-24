import { z } from 'zod';
import { ConfigError } from './util/errors.js';

/**
 * Typed configuration, read from environment variables (see .env.example).
 *
 * The Open Cloud key is read from HK_OPEN_CLOUD_KEY on purpose, not from the common
 * ROBLOX_OPEN_CLOUD_API_KEY name: give the bot its own least-privilege key, and never let it
 * pick up a personal key that happens to be set on the machine.
 */

export type LinkProviderKind = 'blurb' | 'bloxlink' | 'rover';
export type TierNumber = 0 | 1 | 2 | 3 | 4 | 5;

export interface ArmyRankTier {
  rank: number;
  tier: TierNumber;
}

export interface BotConfig {
  discord: {
    token: string;
    clientId: string;
    auditChannelId?: string;
    verifiedRoleId?: string;
    /** register the slash commands globally each time the bot starts */
    registerCommands: boolean;
  };
  roblox: {
    apiKey?: string;
    universeId: number;
    placeId: number;
    profileStore: string;
    globalStore: string;
    armyGroupId: number;
    ownerGroupId: number;
    ownerRank: number;
  };
  bridge: {
    topic: string;
    ackMap: string;
    serverMap: string;
    acksEnabled: boolean;
    ackTimeoutMs: number;
    messageTtlSec: number;
  };
  permissions: {
    roleTiers: Record<1 | 2 | 3 | 4 | 5, string[]>;
    ownerDiscordIds: string[];
    tierFromRobloxRank: boolean;
    armyRankTiers: ArmyRankTier[];
    commandTiers: Record<string, TierNumber>;
  };
  linking: {
    provider: LinkProviderKind;
    bloxlinkApiKey?: string;
    roverApiKey?: string;
    codeTtlMinutes: number;
  };
  events: {
    /** keep in-game events, each server's Events tab and its event channel in step */
    sync: boolean;
    syncSeconds: number;
    remindMinutes: number;
    /** how long a Discord event lasts (in-game events have no end time) */
    lengthMinutes: number;
  };
  eligible: {
    maxProfiles: number;
    cacheMinutes: number;
  };
  dataDir: string;
  log: {
    level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
    pretty: boolean;
  };
}

export type Env = Record<string, string | undefined>;

/** 'bot' needs everything; 'deploy' only needs what registering slash commands needs. */
export type ConfigMode = 'bot' | 'deploy';

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const optionalString = z.preprocess(blankToUndefined, z.string().trim().optional());
const snowflake = z.string().regex(/^\d{15,25}$/, 'must be a Discord ID (15-25 digits)');
const optionalSnowflake = z.preprocess(blankToUndefined, snowflake.optional());

const snowflakeList = z.preprocess(
  blankToUndefined,
  z
    .string()
    .optional()
    .transform((s) =>
      (s ?? '')
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(snowflake)),
);

const positiveInt = (fallback: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(fallback));

const bool = (fallback: boolean) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .optional()
      .transform((s, ctx) => {
        if (s === undefined) return fallback;
        if (/^(1|true|yes|on)$/i.test(s)) return true;
        if (/^(0|false|no|off)$/i.test(s)) return false;
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be true or false' });
        return z.NEVER;
      }),
  );

/** "5:1,9:2" -> [{rank:5,tier:1},{rank:9,tier:2}] */
const armyRankTiers = z.preprocess(
  blankToUndefined,
  z
    .string()
    .default('5:1,9:2,11:3,13:4')
    .transform((s, ctx) => {
      const out: ArmyRankTier[] = [];
      for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
        const m = /^(\d{1,3}):([0-5])$/.exec(part);
        if (!m) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `bad entry "${part}" (use rank:tier, e.g. 9:2)` });
          return z.NEVER;
        }
        out.push({ rank: Number(m[1]), tier: Number(m[2]) as TierNumber });
      }
      return out.sort((a, b) => a.rank - b.rank);
    }),
);

/** "announce:2,promote:5" -> { announce: 2, promote: 5 } ; "event.schedule:3" sets one subcommand */
const commandTiers = z.preprocess(
  blankToUndefined,
  z
    .string()
    .default('')
    .transform((s, ctx) => {
      const out: Record<string, TierNumber> = {};
      for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
        const m = /^([a-z0-9_-]+(?:\.[a-z0-9_-]+)?):([0-5])$/i.exec(part);
        if (!m) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `bad entry "${part}" (use command:tier, e.g. announce:2)` });
          return z.NEVER;
        }
        out[m[1]!.toLowerCase()] = Number(m[2]) as TierNumber;
      }
      return out;
    }),
);

const schema = z.object({
  DISCORD_TOKEN: optionalString,
  DISCORD_CLIENT_ID: optionalSnowflake,
  AUDIT_CHANNEL_ID: optionalSnowflake,
  VERIFIED_ROLE_ID: optionalSnowflake,
  REGISTER_COMMANDS: bool(true),

  HK_OPEN_CLOUD_KEY: optionalString,
  ROBLOX_UNIVERSE_ID: positiveInt(10772680614),
  ROBLOX_PLACE_ID: positiveInt(77901932829123),
  PROFILE_STORE: z.preprocess(blankToUndefined, z.string().default('HK1941_Profiles')),
  GLOBAL_STORE: z.preprocess(blankToUndefined, z.string().default('HK1941_Global')),
  ARMY_GROUP_ID: positiveInt(409406376),
  OWNER_GROUP_ID: positiveInt(668236881),
  OWNER_RANK: positiveInt(255),

  BRIDGE_TOPIC: z.preprocess(blankToUndefined, z.string().regex(/^[\w-]{1,80}$/).default('HK1941Discord')),
  BRIDGE_ACK_MAP: z.preprocess(blankToUndefined, z.string().default('HK1941_DiscordBridge')),
  SERVER_MAP: z.preprocess(blankToUndefined, z.string().default('HK1941_Servers')),
  BRIDGE_ACKS: bool(true),
  BRIDGE_ACK_TIMEOUT_MS: positiveInt(12000),
  BRIDGE_MESSAGE_TTL_SEC: positiveInt(120),

  TIER1_ROLE_IDS: snowflakeList,
  TIER2_ROLE_IDS: snowflakeList,
  TIER3_ROLE_IDS: snowflakeList,
  TIER4_ROLE_IDS: snowflakeList,
  TIER5_ROLE_IDS: snowflakeList,
  OWNER_DISCORD_IDS: snowflakeList,
  TIER_FROM_ROBLOX_RANK: bool(true),
  ARMY_RANK_TIERS: armyRankTiers,
  COMMAND_TIERS: commandTiers,

  LINK_PROVIDER: z.preprocess(blankToUndefined, z.enum(['blurb', 'bloxlink', 'rover']).default('blurb')),
  BLOXLINK_API_KEY: optionalString,
  ROVER_API_KEY: optionalString,
  LINK_CODE_TTL_MIN: positiveInt(15),

  EVENT_SYNC: bool(true),
  EVENT_SYNC_SEC: positiveInt(60),
  EVENT_REMIND_MIN: positiveInt(15),
  EVENT_LENGTH_MIN: positiveInt(120),
  ELIGIBLE_MAX_PROFILES: positiveInt(300),
  ELIGIBLE_CACHE_MIN: positiveInt(10),

  DATA_DIR: z.preprocess(blankToUndefined, z.string().default('./data')),
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ),
  LOG_PRETTY: bool(false),
});

export function loadConfig(env: Env, mode: ConfigMode = 'bot'): BotConfig {
  const parsed = schema.safeParse(env);
  const problems: string[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push(`${issue.path.join('.') || 'env'}: ${issue.message}`);
    throw new ConfigError(problems);
  }
  const e = parsed.data;

  if (!e.DISCORD_TOKEN) problems.push('DISCORD_TOKEN: required');
  if (!e.DISCORD_CLIENT_ID) problems.push('DISCORD_CLIENT_ID: required');
  if (mode === 'bot') {
    if (!e.HK_OPEN_CLOUD_KEY) problems.push('HK_OPEN_CLOUD_KEY: required (an Open Cloud API key made for the bot)');
    if (e.LINK_PROVIDER === 'bloxlink' && !e.BLOXLINK_API_KEY) problems.push('BLOXLINK_API_KEY: required when LINK_PROVIDER=bloxlink');
    if (e.LINK_PROVIDER === 'rover' && !e.ROVER_API_KEY) problems.push('ROVER_API_KEY: required when LINK_PROVIDER=rover');
  }
  const anyRoleTier =
    e.TIER1_ROLE_IDS.length + e.TIER2_ROLE_IDS.length + e.TIER3_ROLE_IDS.length + e.TIER4_ROLE_IDS.length + e.TIER5_ROLE_IDS.length;
  if (mode === 'bot' && anyRoleTier === 0 && e.OWNER_DISCORD_IDS.length === 0 && !e.TIER_FROM_ROBLOX_RANK) {
    problems.push('No staff can be recognised, so nobody could run /setup: set OWNER_DISCORD_IDS, TIER_FROM_ROBLOX_RANK=true or TIERn_ROLE_IDS');
  }
  if (problems.length) throw new ConfigError(problems);

  return {
    discord: {
      token: e.DISCORD_TOKEN!,
      clientId: e.DISCORD_CLIENT_ID!,
      auditChannelId: e.AUDIT_CHANNEL_ID,
      verifiedRoleId: e.VERIFIED_ROLE_ID,
      registerCommands: e.REGISTER_COMMANDS,
    },
    roblox: {
      apiKey: e.HK_OPEN_CLOUD_KEY,
      universeId: e.ROBLOX_UNIVERSE_ID,
      placeId: e.ROBLOX_PLACE_ID,
      profileStore: e.PROFILE_STORE,
      globalStore: e.GLOBAL_STORE,
      armyGroupId: e.ARMY_GROUP_ID,
      ownerGroupId: e.OWNER_GROUP_ID,
      ownerRank: e.OWNER_RANK,
    },
    bridge: {
      topic: e.BRIDGE_TOPIC,
      ackMap: e.BRIDGE_ACK_MAP,
      serverMap: e.SERVER_MAP,
      acksEnabled: e.BRIDGE_ACKS,
      ackTimeoutMs: e.BRIDGE_ACK_TIMEOUT_MS,
      messageTtlSec: e.BRIDGE_MESSAGE_TTL_SEC,
    },
    permissions: {
      roleTiers: {
        1: e.TIER1_ROLE_IDS,
        2: e.TIER2_ROLE_IDS,
        3: e.TIER3_ROLE_IDS,
        4: e.TIER4_ROLE_IDS,
        5: e.TIER5_ROLE_IDS,
      },
      ownerDiscordIds: e.OWNER_DISCORD_IDS,
      tierFromRobloxRank: e.TIER_FROM_ROBLOX_RANK,
      armyRankTiers: e.ARMY_RANK_TIERS,
      commandTiers: e.COMMAND_TIERS,
    },
    linking: {
      provider: e.LINK_PROVIDER,
      bloxlinkApiKey: e.BLOXLINK_API_KEY,
      roverApiKey: e.ROVER_API_KEY,
      codeTtlMinutes: e.LINK_CODE_TTL_MIN,
    },
    events: {
      sync: e.EVENT_SYNC,
      syncSeconds: Math.max(30, e.EVENT_SYNC_SEC),
      remindMinutes: e.EVENT_REMIND_MIN,
      lengthMinutes: e.EVENT_LENGTH_MIN,
    },
    eligible: { maxProfiles: e.ELIGIBLE_MAX_PROFILES, cacheMinutes: e.ELIGIBLE_CACHE_MIN },
    dataDir: e.DATA_DIR,
    log: { level: e.LOG_LEVEL, pretty: e.LOG_PRETTY },
  };
}
