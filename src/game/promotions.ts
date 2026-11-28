import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Client } from 'discord.js';
import { syncEverywhere } from '../linking/memberSync.js';
import { Tier } from '../permissions/tiers.js';
import type { GroupRole, UserRank } from '../roblox/groups.js';
import type { RobloxUser } from '../roblox/users.js';
import type { Services } from '../types.js';
import { mapLimit } from '../util/cache.js';
import { RobloxApiError, UserFacingError } from '../util/errors.js';
import { RANKS, type RankRequirement } from './gameConfig.js';
import { standing } from './points.js';

/**
 * Promotions, shared by /promote, /eligible and the dashboard: who is where on the points
 * ladder (a scan of the army group), and changing someone's rank with the same checks everywhere.
 */

export interface RosterEntry {
  userId: number;
  rank: number;
  roleId: number;
  roleName: string;
  points: number;
  /** trainings attended */
  trainings: number;
  /** what the next rank on the points ladder needs (null past the ladder) */
  next: RankRequirement | null;
  eligible: boolean;
  /** false when they have never played (no profile) */
  hasProfile: boolean;
}

export interface Roster {
  entries: RosterEntry[];
  /** members read */
  checked: number;
  /** stopped at ELIGIBLE_MAX_PROFILES */
  capped: boolean;
  /** unix ms */
  at: number;
}

/** Reads every member at a points-ladder rank (or one rank) and their profile. */
export async function scanRoster(services: Services, onlyRank: number | null, onProgress?: (done: number, total: number) => void): Promise<Roster> {
  const { config } = services;
  const roles: GroupRole[] = await services.groups.listRoles(config.roblox.armyGroupId);
  const wanted = roles.filter((r) => RANKS[r.rank] && (onlyRank === null || r.rank === onlyRank));
  if (!wanted.length) throw new UserFacingError('No army group roles match the ranks on the points record.');

  const members: { userId: number; role: GroupRole }[] = [];
  let capped = false;
  for (const role of wanted) {
    const left = config.eligible.maxProfiles - members.length;
    if (left <= 0) {
      capped = true;
      break;
    }
    const ids = await services.groups.membersWithRole(config.roblox.armyGroupId, role.id, left);
    if (ids.length >= left) capped = true;
    for (const userId of ids) members.push({ userId, role });
  }

  let done = 0;
  const entries = await mapLimit(members, 5, async ({ userId, role }) => {
    const p = await services.profiles.get(userId).catch(() => null);
    onProgress?.(++done, members.length);
    const base = { userId, rank: role.rank, roleId: role.id, roleName: role.name, next: RANKS[role.rank] ?? null };
    if (!p) return { ...base, points: 0, trainings: 0, eligible: false, hasProfile: false } satisfies RosterEntry;
    const st = standing(p.data, role.rank);
    return { ...base, points: st.points, trainings: st.next?.haveTrainings ?? p.data.training.attended, eligible: st.eligible, hasProfile: true } satisfies RosterEntry;
  });
  return { entries, checked: members.length, capped, at: Date.now() };
}

/** 0..1: how far along to the next rank (the lower of points and trainings). */
export function progressOf(e: Pick<RosterEntry, 'points' | 'trainings' | 'next'>): number {
  if (!e.next) return 1;
  const p = e.next.points ? Math.min(1, e.points / e.next.points) : 1;
  const t = e.next.trainings ? Math.min(1, e.trainings / e.next.trainings) : 1;
  return Math.min(p, t);
}

/**
 * Remembers scans so /eligible and the dashboard share them, and runs at most one scan per key
 * at a time. Keys: "all" or a rank number.
 */
export class RosterScanner {
  private readonly results = new Map<string, Roster>();
  private readonly running = new Map<string, Promise<Roster>>();
  readonly progress = new Map<string, { done: number; total: number }>();
  readonly errors = new Map<string, string>();

  constructor(private readonly services: Services) {}

  private key(onlyRank: number | null): string {
    return onlyRank === null ? 'all' : String(onlyRank);
  }

  /** The last finished scan, however old. */
  cached(onlyRank: number | null): Roster | null {
    return this.results.get(this.key(onlyRank)) ?? null;
  }

  isRunning(onlyRank: number | null): boolean {
    return this.running.has(this.key(onlyRank));
  }

  /** A scan no older than maxAgeMs (default: ELIGIBLE_CACHE_MIN), scanning if needed. */
  load(onlyRank: number | null, opts: { maxAgeMs?: number; force?: boolean } = {}): Promise<Roster> {
    const key = this.key(onlyRank);
    const maxAge = opts.maxAgeMs ?? this.services.config.eligible.cacheMinutes * 60_000;
    const have = this.results.get(key);
    if (have && !opts.force && Date.now() - have.at <= maxAge) return Promise.resolve(have);
    let run = this.running.get(key);
    if (!run) {
      this.progress.set(key, { done: 0, total: 0 });
      run = scanRoster(this.services, onlyRank, (done, total) => this.progress.set(key, { done, total }))
        .then((r) => {
          this.results.set(key, r);
          this.errors.delete(key);
          // a full scan also answers each single rank
          if (key === 'all') for (const rank of Object.keys(RANKS)) this.results.set(rank, { ...r, entries: r.entries.filter((e) => e.rank === Number(rank)) });
          return r;
        })
        .catch((err: unknown) => {
          this.errors.set(key, err instanceof Error ? err.message : String(err));
          throw err;
        })
        .finally(() => {
          this.running.delete(key);
          this.progress.delete(key);
        });
      this.running.set(key, run);
    }
    return run;
  }

  /** Forget scans that include this person (after their rank changes). */
  forget(): void {
    this.results.clear();
  }
}

const scanners = new WeakMap<Services, RosterScanner>();
export function rosterFor(services: Services): RosterScanner {
  let s = scanners.get(services);
  if (!s) scanners.set(services, (s = new RosterScanner(services)));
  return s;
}

/** The army group role one step up the points ladder, if there is one. */
export function nextRole(roles: GroupRole[], rank: number): GroupRole | undefined {
  const req = RANKS[rank];
  return req ? roles.find((r) => r.rank === req.nextRank) : undefined;
}

/** Roles that exist in the groups but are never given out (staff-only roles). */
export const NOT_OBTAINABLE = /^\s*developers?\s*$/i;

/** Ranks anyone may be given here: in the group, not guest (0), not owner (255), not Developer. */
export const assignable = (roles: GroupRole[]) =>
  roles.filter((r) => r.rank > 0 && r.rank < 255 && !NOT_OBTAINABLE.test(r.name)).sort((a, b) => a.rank - b.rank);

/**
 * Who may change whose rank: owners anything; everyone else only people below their own army
 * rank, to ranks below it. Dashboard admins count as owners.
 */
export async function rankGuard(
  services: Services,
  actor: { robloxId?: number; tier: number },
  currentRank: number,
  newRank: number,
  groupId = services.config.roblox.armyGroupId,
): Promise<void> {
  if (actor.tier >= Tier.Owner) return;
  if (!actor.robloxId) throw new UserFacingError('Link your Roblox account first (/link start): promotions are checked against your own rank.');
  const mine = await services.groups.rankIn(groupId, actor.robloxId, { fresh: true });
  if (newRank >= mine.rank) throw new UserFacingError(`You can only give ranks below your own (${mine.roleName}, rank ${mine.rank}).`);
  if (currentRank >= mine.rank) throw new UserFacingError('You can only change the rank of people below you.');
}

export interface RankChange {
  user: RobloxUser | null;
  from: UserRank;
  to: GroupRole;
  /** their Discord roles and nickname were refreshed (they have a linked account) */
  discordUpdated: boolean;
}

/** Turn Roblox's refusal into something staff can act on. */
export function explainRankError(err: unknown, to: GroupRole): unknown {
  if (!(err instanceof RobloxApiError)) return err;
  const body = `${err.body ?? ''} ${err.message}`;
  if (/same user/i.test(body)) {
    return new UserFacingError("Roblox won't let the bot's account change its own rank. Change that one on the Roblox group page.");
  }
  if (err.status === 403) {
    return new UserFacingError(
      `Roblox refused: the bot's Roblox account isn't allowed to give ${to.name} here. Its role in the group needs "Manage lower-ranked member ranks", and it can only change people below its own rank, to ranks below its own.`,
    );
  }
  if (err.status === 401) {
    return new UserFacingError("Roblox refused the bot's Open Cloud key (401). Check the key has Groups read and write, and that the bot server's IP is allowed.");
  }
  if (err.status === 404) return new UserFacingError('Roblox says they are no longer in the group.');
  return err;
}

/** Change someone's army rank after checking it's allowed, and record it in the audit log. */
export async function changeRank(
  services: Services,
  opts: {
    userId: number;
    roleId: number;
    /** default: the army group. (Divisions with their own groups can be added later.) */
    groupId?: number;
    actor: { robloxId?: number; tier: number };
    audit: { actorId: string; actorName: string; guildId?: string | null };
    reason?: string;
    /** refuse if their rank isn't this any more (someone else changed it meanwhile) */
    expectRoleId?: number;
    /** to refresh their Discord roles and nickname afterwards (when they have a linked account) */
    client?: Client | null;
  },
): Promise<RankChange> {
  const group = opts.groupId ?? services.config.roblox.armyGroupId;
  const roles = await services.groups.listRoles(group);
  const to = assignable(roles).find((r) => r.id === opts.roleId);
  if (!to) throw new UserFacingError('That rank no longer exists, or can’t be given out.');
  const from = await services.groups.rankIn(group, opts.userId, { fresh: true });
  if (from.rank === 0) throw new UserFacingError('They aren’t in the army group. They need to join it first.');
  if (opts.expectRoleId !== undefined && from.roleId !== opts.expectRoleId) {
    throw new UserFacingError(`Their rank changed in the meantime (now ${from.roleName}). Check again before changing it.`);
  }
  if (from.roleId === to.id) throw new UserFacingError(`They are already ${to.name}.`);
  await rankGuard(services, opts.actor, from.rank, to.rank, group);
  const user = await services.users.getById(opts.userId).catch(() => null);
  try {
    await services.groups.setRole(group, opts.userId, to.id);
  } catch (err) {
    throw explainRankError(err, to);
  }
  rosterFor(services).forget();
  services.groups.forgetGroup(group); // member counts changed
  const reason = opts.reason?.trim().slice(0, 200);
  await services.promotionLog
    .add({ t: Date.now(), groupId: group, userId: opts.userId, name: user?.name ?? String(opts.userId), from: from.roleName, fromRank: from.rank, to: to.name, toRank: to.rank, by: opts.audit.actorName, reason })
    .catch((err) => services.logger.warn({ err }, 'could not save the promotion history'));
  await services.audit.record({
    actorId: opts.audit.actorId,
    actorName: opts.audit.actorName,
    action: to.rank > from.rank ? 'Promotion' : 'Rank change',
    target: `${user?.name ?? opts.userId} (${opts.userId})`,
    detail: `${from.roleName} (${from.rank}) → ${to.name} (${to.rank})${reason ? `\nReason: ${reason}` : ''}`,
    ok: true,
    guildId: opts.audit.guildId ?? undefined,
  });
  let discordUpdated = false;
  const link = opts.client ? await services.links.findByRoblox(opts.userId).catch(() => null) : null;
  if (link && opts.client) {
    const results = await syncEverywhere(services, opts.client, link.discordId, `Rank changed to ${to.name}`).catch((err) => {
      services.logger.warn({ err }, 'could not update Discord roles after a rank change');
      return [];
    });
    discordUpdated = results.length > 0;
  }
  return { user, from, to, discordUpdated };
}

// ---------- history ----------

/** One rank change made through the bot (Discord or dashboard). */
export interface RankChangeRecord {
  /** unix ms */
  t: number;
  groupId: number;
  userId: number;
  name: string;
  from: string;
  fromRank: number;
  to: string;
  toRank: number;
  by: string;
  reason?: string;
}

/** The latest rank changes made through the bot, newest first. Kept in DATA_DIR/promotions.json. */
export class PromotionLog {
  private entries: RankChangeRecord[] | null = null;
  private writing: Promise<void> = Promise.resolve();
  static readonly MAX = 5000;

  constructor(private readonly file: string | null) {}

  private async load(): Promise<RankChangeRecord[]> {
    if (this.entries) return this.entries;
    this.entries = [];
    if (!this.file) return this.entries;
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (Array.isArray(raw)) this.entries = raw.filter((e): e is RankChangeRecord => !!e && typeof e === 'object' && typeof (e as RankChangeRecord).userId === 'number');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return this.entries;
  }

  async add(e: RankChangeRecord): Promise<void> {
    const list = await this.load();
    list.unshift(e);
    list.splice(PromotionLog.MAX);
    if (!this.file) return;
    const file = this.file;
    const body = JSON.stringify(list);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, body, 'utf8');
      await rename(`${file}.tmp`, file);
    });
    await this.writing;
  }

  /** Newest first; one person's, or everyone's. */
  async list(userId?: number): Promise<RankChangeRecord[]> {
    const list = await this.load();
    return (userId === undefined ? list : list.filter((e) => e.userId === userId)).slice();
  }
}

// ---------- promotion requests (/nominate) ----------

/** Someone below the approvers asking for a rank change; an approver decides. */
export interface PromotionRequest {
  id: string;
  guildId: string;
  groupId: number;
  userId: number;
  userName: string;
  fromRoleId: number;
  fromName: string;
  toRoleId: number;
  toName: string;
  /** Discord ID and name of whoever asked */
  byId: string;
  byName: string;
  reason: string;
  createdAt: number;
  status: 'pending' | 'approved' | 'rejected';
  decidedBy?: string;
  decidedAt?: number;
  note?: string;
  /** the message with the Approve / Reject buttons */
  queue?: { channelId: string; messageId: string };
}

/** Kept in DATA_DIR/promotion-requests.json; decided ones are forgotten after 60 days. */
export class PromotionRequests {
  private items: Map<string, PromotionRequest> | null = null;
  private writing: Promise<void> = Promise.resolve();
  static readonly KEEP_MS = 60 * 86400_000;

  constructor(private readonly file: string | null) {}

  private async load(): Promise<Map<string, PromotionRequest>> {
    if (this.items) return this.items;
    this.items = new Map();
    if (!this.file) return this.items;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { requests?: PromotionRequest[] };
      for (const r of raw.requests ?? []) if (r && typeof r.id === 'string' && typeof r.userId === 'number') this.items.set(r.id, r);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return this.items;
  }

  async get(id: string): Promise<PromotionRequest | null> {
    const r = (await this.load()).get(id);
    return r ? structuredClone(r) : null;
  }

  async put(r: PromotionRequest): Promise<void> {
    const items = await this.load();
    items.set(r.id, structuredClone(r));
    const now = Date.now();
    for (const [id, x] of items) if (x.status !== 'pending' && now - (x.decidedAt ?? x.createdAt) > PromotionRequests.KEEP_MS) items.delete(id);
    if (!this.file) return;
    const file = this.file;
    const body = JSON.stringify({ version: 1, requests: [...items.values()] }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, body, 'utf8');
      await rename(`${file}.tmp`, file);
    });
    await this.writing;
  }

  /** Newest first. */
  async list(filter: { status?: PromotionRequest['status']; userId?: number } = {}): Promise<PromotionRequest[]> {
    return [...(await this.load()).values()]
      .filter((r) => (!filter.status || r.status === filter.status) && (filter.userId === undefined || r.userId === filter.userId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => structuredClone(r));
  }
}

// ---------- several at once ----------

export interface BulkResult {
  done: { userId: number; name: string; to: string }[];
  failed: { userId: number; name: string; why: string }[];
}

/** Promote several people one after another; one failing doesn't stop the rest. */
export async function bulkPromote(
  services: Services,
  picks: { userId: number; from: number; to: number }[],
  o: { actor: { robloxId?: number; tier: number }; audit: { actorId: string; actorName: string; guildId?: string | null }; reason?: string; client?: Client | null },
): Promise<BulkResult> {
  const out: BulkResult = { done: [], failed: [] };
  const names = await services.users.namesFor(picks.map((p) => p.userId)).catch(() => new Map<number, RobloxUser>());
  for (const p of picks) {
    const name = names.get(p.userId)?.name ?? String(p.userId);
    try {
      const c = await changeRank(services, { userId: p.userId, roleId: p.to, expectRoleId: p.from, actor: o.actor, audit: o.audit, reason: o.reason, client: o.client });
      out.done.push({ userId: p.userId, name, to: c.to.name });
    } catch (err) {
      if (!(err instanceof UserFacingError)) services.logger.warn({ err, userId: p.userId }, 'bulk promotion failed');
      out.failed.push({ userId: p.userId, name, why: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

export function describeBulk(r: BulkResult): string {
  return [
    r.done.length ? `Promoted ${r.done.length}: ${r.done.map((d) => `${d.name} → ${d.to}`).join(', ')}.` : '',
    r.failed.length ? `Not done (${r.failed.length}): ${r.failed.map((f) => `${f.name}: ${f.why}`).join(' · ')}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
