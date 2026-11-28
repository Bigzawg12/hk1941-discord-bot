import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Services } from '../types.js';

/**
 * Who can use the dashboard, and what they can do.
 *
 *   0 No access    can't sign in
 *   1 Viewer       read everything about members, groups, promotions and the game log
 *   2 Officer      also change ranks in the groups they manage (only below their own rank there)
 *   3 Admin        also decide requests, promote in bulk, points & ranks, posts, panels, servers, linked accounts
 *   4 Owner        everything, including this access list; rank changes aren't limited by their own rank
 *
 * Owners are DASHBOARD_ADMIN_IDS (else OWNER_DISCORD_IDS). Everyone else gets a level from the rules
 * (army rank or in-game staff tier of their linked Roblox account) or from a per-person setting.
 * Kept in DATA_DIR/dashboard-access.json. Out of the box nobody but the owners can sign in.
 */

export const Level = { None: 0, Viewer: 1, Officer: 2, Admin: 3, Owner: 4 } as const;
export type Level = (typeof Level)[keyof typeof Level];
export const LEVEL_NAMES: Record<Level, string> = { 0: 'No access', 1: 'Viewer', 2: 'Officer', 3: 'Admin', 4: 'Owner' };
export const LEVEL_HINTS: Record<Level, string> = {
  0: 'Can’t sign in',
  1: 'Sees members, groups, promotions and the game log',
  2: 'Also changes ranks in the groups they manage, below their own rank there',
  3: 'Also decides requests, bulk promotions, points & ranks, posts, panels and servers',
  4: 'Everything, including who has access',
};

/** Lowest army rank / in-game staff tier for each level (unset = that rule is off). */
export interface AccessRule {
  armyRank?: number;
  staffTier?: number;
}

export interface AccessSettings {
  rules: Partial<Record<'viewer' | 'officer' | 'admin', AccessRule>>;
  /** per person, by Discord ID; beats the rules (0 = blocked) */
  people: Record<
    string,
    {
      level: Exclude<Level, 4>;
      note?: string;
      by: string;
      at: number;
      /** extra groups an Officer may change ranks in */
      groups?: number[];
      /** if set, the only groups they can see anything about (Viewers and Officers) */
      scope?: number[];
    }
  >;
  /** Viewers and Officers without their own list only see the groups they're a member of */
  scopeByMembership?: boolean;
}

const RULE_LEVELS = [
  ['admin', Level.Admin],
  ['officer', Level.Officer],
  ['viewer', Level.Viewer],
] as const;

export class AccessStore {
  private data: AccessSettings | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string | null) {}

  async get(): Promise<AccessSettings> {
    if (this.data) return structuredClone(this.data);
    this.data = { rules: {}, people: {} };
    if (this.file) {
      try {
        const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<AccessSettings>;
        this.data = { rules: raw.rules ?? {}, people: raw.people ?? {} };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return structuredClone(this.data);
  }

  async set(next: AccessSettings): Promise<void> {
    this.data = structuredClone(next);
    if (!this.file) return;
    const file = this.file;
    const body = JSON.stringify(next, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, body, 'utf8');
      await rename(`${file}.tmp`, file);
    });
    await this.writing;
  }
}

export interface AccessCheck {
  level: Level;
  /** why, for the sign-in page and the Access page */
  why: string;
  robloxId?: number;
  robloxName?: string;
  armyRank?: number;
  staffTier?: number;
  /** the only groups they may see; null/undefined = every group (Admins, owners, or no limit) */
  scope?: number[] | null;
}

/** Their level, plus which groups they may see. */
export async function checkAccess(services: Services, access: AccessStore, discordId: string, ownerIds: string[]): Promise<AccessCheck> {
  const check = await checkLevel(services, access, discordId, ownerIds);
  if (check.level === Level.None || check.level >= Level.Admin) return { ...check, scope: null };
  const settings = await access.get();
  const person = settings.people[discordId];
  if (person?.scope?.length) return { ...check, scope: person.scope };
  if (settings.scopeByMembership && check.robloxId) {
    const tracked = new Set([services.config.roblox.armyGroupId, ...(await services.divisions.list()).map((e) => e.groupId)]);
    const mine = await services.groups.userRanks(check.robloxId).catch(() => []);
    return { ...check, scope: mine.filter((g) => g.rank > 0 && tracked.has(g.groupId)).map((g) => g.groupId) };
  }
  return { ...check, scope: null };
}

/** Work out someone's level. Never throws: if Roblox can't be reached, the rules can't match. */
async function checkLevel(services: Services, access: AccessStore, discordId: string, ownerIds: string[]): Promise<AccessCheck> {
  const link = await services.links.get(discordId).catch(() => null);
  const base = { robloxId: link?.robloxId, robloxName: link?.robloxName };
  if (ownerIds.includes(discordId)) return { ...base, level: Level.Owner, why: 'Owner (DASHBOARD_ADMIN_IDS)' };
  const settings = await access.get();
  const person = settings.people[discordId];
  if (person) return { ...base, level: person.level, why: person.level ? `Set by ${person.by}` : `Blocked by ${person.by}` };
  if (!link) return { level: Level.None, why: 'No linked Roblox account. Link one with /verify in Discord first.' };
  const [rank, staff] = await Promise.all([
    services.groups.rankIn(services.config.roblox.armyGroupId, link.robloxId).catch(() => null),
    services.global.staff().catch(() => ({}) as Record<string, { tier?: number }>),
  ]);
  const armyRank = rank?.rank ?? 0;
  const staffTier = staff[String(link.robloxId)]?.tier ?? 0;
  for (const [key, level] of RULE_LEVELS) {
    const rule = settings.rules[key];
    if (!rule) continue;
    if (rule.armyRank && armyRank >= rule.armyRank) return { ...base, armyRank, staffTier, level, why: `Army rank ${armyRank} (${rank?.roleName ?? ''}) meets the ${LEVEL_NAMES[level]} rule` };
    if (rule.staffTier && staffTier >= rule.staffTier) return { ...base, armyRank, staffTier, level, why: `Staff tier ${staffTier} meets the ${LEVEL_NAMES[level]} rule` };
  }
  return { ...base, armyRank, staffTier, level: Level.None, why: `Army rank ${armyRank}${staffTier ? `, staff tier ${staffTier}` : ''}: not enough for dashboard access.` };
}

/** Lowest level for a page (GET) or a form (POST). */
export function levelNeeded(method: string, path: string, action?: string): Level {
  const post = method === 'POST';
  if (path === '/theme') return Level.Viewer;
  if (path === '/access' || path.startsWith('/access/')) return Level.Owner;
  if (/^\/(approvals|panels|servers|links|audit)(\/|$|\.csv)/.test(path)) return Level.Admin;
  if (path === '/promotions') {
    if (!post) return Level.Viewer;
    if (action === 'refresh') return Level.Viewer;
    return Level.Admin; // decide, bulk, settings
  }
  if (/^\/members\/\d+$/.test(path) && post) return Level.Officer; // rank change
  if (path === '/groups' && post) return Level.Admin; // add a group
  if (/^\/groups\/\d+$/.test(path) && post) return action === 'rank' || action === 'app-decide' || action === 'apps-settings' || action === 'activity-check' ? Level.Officer : Level.Admin;
  if (path === '/game-log' && post) return Level.Viewer; // sync now
  if (path === '/events' && post) return Level.Officer; // schedule / cancel
  return Level.Viewer;
}
