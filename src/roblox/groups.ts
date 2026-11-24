import { TtlCache } from '../util/cache.js';
import { OPEN_CLOUD, type RobloxHttp } from './http.js';

/**
 * Roblox groups.
 *  - Reading a user's rank uses the public groups web API (no key needed).
 *  - Listing roles / members and CHANGING a member's role use Open Cloud (cloud/v2 groups).
 *    Key scopes: group:read, and group:write for promotions. The key's owner must be allowed to
 *    change ranks in the group (Roblox applies the owner's own permissions).
 *
 * Groups: 409406376 = army rank group (Canada 1940s ranks), 668236881 = dev/asset group (HKAdmin owner check).
 */

export interface GroupRole {
  id: number;
  name: string;
  rank: number;
  memberCount?: number;
}

export interface UserRank {
  groupId: number;
  rank: number;
  roleId: number;
  roleName: string;
}

export interface Membership {
  /** e.g. "groups/409406376/memberships/abc" */
  path: string;
  userId: number;
  roleId: number;
}

interface LegacyUserGroups {
  data?: { group?: { id?: number; name?: string }; role?: { id?: number; name?: string; rank?: number } }[];
}

interface CloudRoles {
  groupRoles?: { id?: string; path?: string; displayName?: string; rank?: number; memberCount?: number }[];
  nextPageToken?: string;
}

interface CloudMemberships {
  groupMemberships?: { path?: string; user?: string; role?: string }[];
  nextPageToken?: string;
}

const lastNumber = (s: string | undefined): number => {
  const m = /(\d+)\s*$/.exec(s ?? '');
  return m ? Number(m[1]) : 0;
};

export class GroupsClient {
  private readonly rankCache = new TtlCache<number, UserRank[]>(5 * 60_000, 2000);
  private readonly rolesCache = new TtlCache<number, GroupRole[]>(30 * 60_000, 20);

  constructor(private readonly http: RobloxHttp) {}

  /** Every group the user is in, with their rank (public API, cached 5 minutes). */
  async userRanks(userId: number, { fresh = false } = {}): Promise<UserRank[]> {
    if (fresh) this.rankCache.delete(userId);
    return this.rankCache.getOrLoad(userId, async () => {
      const res = await this.http.get<LegacyUserGroups>(`https://groups.roblox.com/v2/users/${userId}/groups/roles`);
      return (res.data?.data ?? []).map((g) => ({
        groupId: g.group?.id ?? 0,
        rank: g.role?.rank ?? 0,
        roleId: g.role?.id ?? 0,
        roleName: g.role?.name ?? '',
      }));
    });
  }

  /** The user's rank in one group; rank 0 / "Guest" when they aren't a member. */
  async rankIn(groupId: number, userId: number, opts?: { fresh?: boolean }): Promise<UserRank> {
    const all = await this.userRanks(userId, opts);
    return all.find((g) => g.groupId === groupId) ?? { groupId, rank: 0, roleId: 0, roleName: 'Guest' };
  }

  /** All roles in a group, lowest rank first (Open Cloud, cached 30 minutes). */
  async listRoles(groupId: number): Promise<GroupRole[]> {
    return this.rolesCache.getOrLoad(groupId, async () => {
      const roles: GroupRole[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await this.http.get<CloudRoles>(`${OPEN_CLOUD}/cloud/v2/groups/${groupId}/roles`, {
          auth: true,
          query: { maxPageSize: 20, pageToken },
        });
        for (const r of res.data?.groupRoles ?? []) {
          roles.push({
            id: r.id ? Number(r.id) : lastNumber(r.path),
            name: r.displayName ?? '',
            rank: r.rank ?? 0,
            memberCount: r.memberCount,
          });
        }
        pageToken = res.data?.nextPageToken || undefined;
        if (!pageToken) break;
      }
      return roles.sort((a, b) => a.rank - b.rank);
    });
  }

  async findMembership(groupId: number, userId: number): Promise<Membership | null> {
    const res = await this.http.get<CloudMemberships>(`${OPEN_CLOUD}/cloud/v2/groups/${groupId}/memberships`, {
      auth: true,
      query: { maxPageSize: 10, filter: `user == 'users/${userId}'` },
    });
    const m = res.data?.groupMemberships?.[0];
    if (!m?.path) return null;
    return { path: m.path, userId: lastNumber(m.user), roleId: lastNumber(m.role) };
  }

  /** User IDs holding one role (paged, up to `max`). */
  async membersWithRole(groupId: number, roleId: number, max = 500): Promise<number[]> {
    const ids: number[] = [];
    let pageToken: string | undefined;
    while (ids.length < max) {
      const res = await this.http.get<CloudMemberships>(`${OPEN_CLOUD}/cloud/v2/groups/${groupId}/memberships`, {
        auth: true,
        query: { maxPageSize: 100, pageToken, filter: `role == 'groups/${groupId}/roles/${roleId}'` },
      });
      for (const m of res.data?.groupMemberships ?? []) {
        const id = lastNumber(m.user);
        if (id) ids.push(id);
      }
      pageToken = res.data?.nextPageToken || undefined;
      if (!pageToken) break;
    }
    return ids.slice(0, max);
  }

  /** Change a member's role (promotion / demotion). Throws if they aren't in the group. */
  async setRole(groupId: number, userId: number, roleId: number): Promise<void> {
    const m = await this.findMembership(groupId, userId);
    if (!m) throw new Error(`User ${userId} isn't in group ${groupId}.`);
    await this.http.patch(`${OPEN_CLOUD}/cloud/v2/${m.path}`, {
      auth: true,
      body: { role: `groups/${groupId}/roles/${roleId}` },
    });
    this.rankCache.delete(userId);
  }
}
