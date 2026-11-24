import { vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import { loadConfig, type BotConfig, type Env } from '../../src/config.js';
import { MemoryGuildSettingsStore } from '../../src/guilds/settings.js';
import { MemoryLinkStore } from '../../src/linking/store.js';
import { silentLogger } from '../../src/logger.js';
import { createServices } from '../../src/services.js';
import type { Services } from '../../src/types.js';
import { mockFetch, type Route } from './mockFetch.js';

export const IDS = {
  guild: '222222222222222222',
  client: '111111111111111111',
  modRole: '333333333333333333',
  seniorRole: '333333333333333334',
  staffUser: '444444444444444444',
  otherUser: '555555555555555555',
};

/** Fake values only. Tests never read process.env. */
export const BASE_ENV: Env = {
  DISCORD_TOKEN: 'test-discord-token',
  DISCORD_CLIENT_ID: IDS.client,
  HK_OPEN_CLOUD_KEY: 'test-open-cloud-key',
  TIER2_ROLE_IDS: IDS.modRole,
  TIER3_ROLE_IDS: IDS.seniorRole,
  TIER_FROM_ROBLOX_RANK: 'false',
};

export function testConfig(over: Env = {}): BotConfig {
  return loadConfig({ ...BASE_ENV, ...over }, 'bot');
}

/** A ProfileStore record as it sits in the HK1941_Profiles DataStore. */
export function profileStoreValue(data: Record<string, unknown>, activeSession: unknown = null) {
  return { Data: data, MetaData: { ProfileCreateTime: 1763900000, SessionLoadCount: 3, ActiveSession: activeSession }, UserIds: [] };
}

export const SAMPLE_PROFILE = {
  settings: {},
  medals: {
    a: { MC: { n: 1, t: 1763900000, by: 'Major', c: 'Held the bridge' }, PACIFIC: { n: 1, t: 1763900000, by: 'Major' } },
    q: { MARKSMAN: { t: 1763900000, by: 'Sgt' } },
    wear: true,
  },
  loadouts: {},
  training: { attended: 5, passed: 4, failed: 1, hosted: 0, history: [{ title: 'Basic', t: 1763900000, result: 'Pass', host: 'Sgt' }], hostedList: [] },
  service: {
    joins: 10, firstJoin: 1763000000, lastJoin: 1763900000, playtime: 600, deployedTime: 300, deployments: 12,
    deaths: 4, kills: 7, aiKills: 9, captures: 3, events: 2, manual: 5, log: [{ t: 1763900000, n: 5, by: 'Lt', reason: 'Good drill' }],
  },
  mp: { arrests: [{ t: 1763800000, by: 'MP1', charges: ['Insubordination'], minutes: 5 }], jailUntil: 0, jailLeft: 0, jailCharges: '', jailBy: '', made: 2 },
  migrated: true,
};

export function testServices(routes: Route[], envOver: Env = {}): { services: Services; calls: ReturnType<typeof mockFetch>['calls'] } {
  const { fetch, calls } = mockFetch(routes);
  const services = createServices(testConfig(envOver), silentLogger(), {
    fetch,
    linkStore: new MemoryLinkStore(),
    guildStore: new MemoryGuildSettingsStore(),
    sleep: async () => undefined,
  });
  return { services, calls };
}

export interface FakeOptions {
  commandName?: string;
  sub?: string | null;
  strings?: Record<string, string>;
  integers?: Record<string, number>;
  booleans?: Record<string, boolean>;
  users?: Record<string, { id: string; username: string }>;
  discordRoles?: Record<string, { id: string; name: string; managed?: boolean; position?: number }>;
  channels?: Record<string, { id: string }>;
  userId?: string;
  roles?: string[];
}

/** Just enough of a ChatInputCommandInteraction for commands and the dispatcher. */
export function fakeInteraction(o: FakeOptions = {}) {
  const replies: unknown[] = [];
  const i = {
    commandName: o.commandName ?? 'record',
    user: { id: o.userId ?? IDS.staffUser, username: 'tester' },
    member: { roles: o.roles ?? [] },
    guildId: IDS.guild,
    guild: null,
    client: { channels: { fetch: vi.fn(async () => ({ isSendable: () => true, send: vi.fn(async () => undefined) })) } },
    deferred: false,
    replied: false,
    inGuild: () => true,
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    options: {
      getString: (n: string, required?: boolean) => {
        const v = o.strings?.[n];
        if (v === undefined && required) throw new Error(`missing required option ${n}`);
        return v ?? null;
      },
      getInteger: (n: string, required?: boolean) => {
        const v = o.integers?.[n];
        if (v === undefined && required) throw new Error(`missing required option ${n}`);
        return v ?? null;
      },
      getBoolean: (n: string) => o.booleans?.[n] ?? null,
      getUser: (n: string) => o.users?.[n] ?? null,
      getRole: (n: string, required?: boolean) => {
        const v = o.discordRoles?.[n];
        if (v === undefined && required) throw new Error(`missing required option ${n}`);
        return v ? { managed: false, position: 1, ...v } : null;
      },
      getChannel: (n: string) => o.channels?.[n] ?? null,
      getSubcommand: (required?: boolean) => {
        if (o.sub) return o.sub;
        if (required) throw new Error('no subcommand');
        return null;
      },
    },
    deferReply: vi.fn(async () => {
      i.deferred = true;
    }),
    reply: vi.fn(async (x: unknown) => {
      i.replied = true;
      replies.push(x);
    }),
    editReply: vi.fn(async (x: unknown) => {
      replies.push(x);
    }),
    followUp: vi.fn(async (x: unknown) => {
      replies.push(x);
    }),
  };
  return { interaction: i as unknown as ChatInputCommandInteraction, raw: i, replies };
}

/** Text of a reply that may be a string or { content, embeds }. */
export function replyText(r: unknown): string {
  if (typeof r === 'string') return r;
  const x = r as { content?: string; embeds?: { toJSON(): unknown }[] };
  return [x.content ?? '', ...(x.embeds ?? []).map((e) => JSON.stringify(e.toJSON()))].join('\n');
}
