import { vi } from 'vitest';
import { Collection, type ChatInputCommandInteraction } from 'discord.js';
import { loadConfig, type BotConfig, type Env } from '../../src/config.js';
import { MemoryGuildSettingsStore } from '../../src/guilds/settings.js';
import { MemoryLinkStore } from '../../src/linking/store.js';
import { silentLogger } from '../../src/logger.js';
import { MemoryPanelStore } from '../../src/posts/panelStore.js';
import { MemoryPostStore } from '../../src/posts/store.js';
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
    q: { RIFLE_QUAL: { t: 1763900000, by: 'Sgt' } },
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
    postStore: new MemoryPostStore(),
    panelStore: new MemoryPanelStore(),
    adminLogFile: null,
    promotionLogFile: null,
    divisionsFile: null,
    promotionRequestsFile: null,
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
  attachments?: Record<string, { url: string; name: string; contentType?: string; size?: number }>;
  userId?: string;
  roles?: string[];
  /** share one fake Discord client between interactions (to see what was posted where) */
  client?: FakeClient;
}

/** A message the bot posted, close enough to discord.js for reading, editing and deleting panels. */
interface FakeMessage {
  id: string;
  channelId: string;
  url: string;
  author: { id: string };
  createdTimestamp: number;
  editedTimestamp: number | null;
  embeds: { title: string | null; description: string | null; color: number | null; footer: { text: string } | null; image: { url: string } | null }[];
  components: { type: number; components: { type: number; style?: number; label?: string; url?: string }[] }[];
  attachments: Collection<string, { url: string; name: string }>;
  edit: (p: Record<string, unknown>) => Promise<FakeMessage>;
  delete: () => Promise<void>;
}

const asJson = (x: unknown) => (x && typeof (x as { toJSON?: unknown }).toJSON === 'function' ? (x as { toJSON(): unknown }).toJSON() : x);

/** What the bot sent: channel posts, edits, deletions and DMs. Every channel exists and accepts posts. */
export function fakeClient() {
  const sent: { channelId: string; payload: Record<string, unknown> }[] = [];
  const edited: { channelId: string; messageId: string; payload: Record<string, unknown> }[] = [];
  const deleted: string[] = [];
  const dms: { userId: string; payload: Record<string, unknown> }[] = [];
  const messages = new Map<string, FakeMessage>();
  let n = 0;
  const guilds = new Map<string, unknown>();
  const fill = (m: FakeMessage, p: Record<string, unknown>) => {
    if ('embeds' in p) {
      m.embeds = ((p.embeds as unknown[]) ?? []).map((e) => {
        const j = asJson(e) as { title?: string; description?: string; color?: number; footer?: { text: string }; image?: { url: string } };
        return { title: j.title ?? null, description: j.description ?? null, color: j.color ?? null, footer: j.footer ?? null, image: j.image ?? null };
      });
    }
    if ('components' in p) m.components = ((p.components as unknown[]) ?? []).map(asJson) as FakeMessage['components'];
    if ('files' in p) {
      m.attachments = new Collection();
      for (const f of (p.files as { name?: string }[]) ?? []) {
        const name = f.name ?? 'file';
        m.attachments.set(name, { url: `https://cdn.discordapp.com/attachments/1/2/${name}`, name });
      }
    }
  };
  const channel = (id: string) => ({
    id,
    guildId: IDS.guild,
    isSendable: () => true,
    send: vi.fn(async (payload: Record<string, unknown>) => {
      sent.push({ channelId: id, payload });
      const mid = String(900000000000000000n + BigInt(++n));
      const m: FakeMessage = {
        id: mid,
        channelId: id,
        url: `https://discord.com/channels/${IDS.guild}/${id}/${mid}`,
        author: { id: IDS.client },
        createdTimestamp: Date.now(),
        editedTimestamp: null,
        embeds: [],
        components: [],
        attachments: new Collection(),
        edit: async (p) => {
          edited.push({ channelId: id, messageId: mid, payload: p });
          fill(m, p);
          m.editedTimestamp = Date.now();
          return m;
        },
        delete: async () => {
          deleted.push(mid);
          messages.delete(mid);
        },
      };
      fill(m, payload);
      messages.set(mid, m);
      return m;
    }),
    messages: {
      fetch: vi.fn(async (mid: string) => {
        const m = messages.get(mid);
        if (!m || m.channelId !== id) throw new Error('Unknown Message');
        return m;
      }),
    },
  });
  const client = {
    user: { id: IDS.client },
    isReady: () => true,
    guilds: { cache: guilds, fetch: vi.fn(async (id: string) => guilds.get(id) ?? null) },
    channels: { fetch: vi.fn(async (id: string) => channel(id)) },
    users: {
      cache: new Map<string, { username: string }>(),
      send: vi.fn(async (userId: string, payload: Record<string, unknown>) => {
        dms.push({ userId, payload });
      }),
    },
  };
  return { client, sent, edited, deleted, dms, messages };
}
export type FakeClient = ReturnType<typeof fakeClient>;

function replyMethods(i: { deferred: boolean; replied: boolean }, replies: unknown[]) {
  return {
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
    showModal: vi.fn(async (m: unknown) => {
      i.replied = true;
      replies.push(m);
    }),
  };
}

const notA = { isChatInputCommand: () => false, isAutocomplete: () => false, isButton: () => false, isModalSubmit: () => false };

/** A form (modal) being sent. */
export function fakeModal(o: { customId: string; fields: Record<string, string>; userId?: string; roles?: string[]; client?: FakeClient; fromMessage?: boolean }) {
  const replies: unknown[] = [];
  const fc = o.client ?? fakeClient();
  const i: Record<string, unknown> & { deferred: boolean; replied: boolean } = {
    ...notA,
    isModalSubmit: () => true,
    customId: o.customId,
    user: { id: o.userId ?? IDS.staffUser, username: 'tester' },
    member: { roles: o.roles ?? [] },
    guildId: IDS.guild,
    guild: null,
    client: fc.client,
    deferred: false,
    replied: false,
    fields: {
      getTextInputValue: (id: string) => {
        if (!(id in o.fields)) throw new Error(`no field ${id}`);
        return o.fields[id]!;
      },
    },
    isFromMessage: () => !!o.fromMessage,
    update: vi.fn(async (x: unknown) => {
      i.replied = true;
      replies.push(x);
    }),
  };
  Object.assign(i, replyMethods(i, replies));
  return { ...fc, interaction: i as never, raw: i, replies };
}

/** A button press on a message the bot posted. */
export function fakeButton(o: { customId: string; userId?: string; roles?: string[]; client?: FakeClient; attachments?: { name: string; url: string }[] }) {
  const replies: unknown[] = [];
  const fc = o.client ?? fakeClient();
  const i: Record<string, unknown> & { deferred: boolean; replied: boolean } = {
    ...notA,
    isButton: () => true,
    customId: o.customId,
    user: { id: o.userId ?? IDS.staffUser, username: 'tester' },
    member: { roles: o.roles ?? [] },
    guildId: IDS.guild,
    guild: null,
    client: fc.client,
    deferred: false,
    replied: false,
    message: { attachments: o.attachments ?? [] },
    deferUpdate: vi.fn(async () => {
      i.deferred = true;
    }),
    update: vi.fn(async (x: unknown) => {
      i.replied = true;
      replies.push(x);
    }),
  };
  Object.assign(i, replyMethods(i, replies));
  return { ...fc, interaction: i as never, raw: i, replies };
}

/** Just enough of a ChatInputCommandInteraction for commands and the dispatcher. */
export function fakeInteraction(o: FakeOptions = {}) {
  const replies: unknown[] = [];
  const fc = o.client ?? fakeClient();
  const i = {
    commandName: o.commandName ?? 'record',
    user: { id: o.userId ?? IDS.staffUser, username: 'tester' },
    member: { roles: o.roles ?? [] },
    guildId: IDS.guild,
    guild: null,
    channelId: '666666666666666666',
    client: fc.client,
    deferred: false,
    replied: false,
    inGuild: () => true,
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
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
      getAttachment: (n: string) => o.attachments?.[n] ?? null,
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
    showModal: vi.fn(async (m: unknown) => {
      i.replied = true;
      replies.push(m);
    }),
  };
  return { ...fc, interaction: i as unknown as ChatInputCommandInteraction, raw: i, replies };
}

/** Text of a reply that may be a string or { content, embeds }. */
export function replyText(r: unknown): string {
  if (typeof r === 'string') return r;
  const x = r as { content?: string; embeds?: { toJSON(): unknown }[] };
  return [x.content ?? '', ...(x.embeds ?? []).map((e) => JSON.stringify(e.toJSON()))].join('\n');
}
