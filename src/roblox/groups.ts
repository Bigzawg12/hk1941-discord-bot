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
  groupMemberships?: { path?: string; user?: string; role?: string; createTime?: string }[];
  nextPageToken?: string;
}

interface CloudGroup {
  id?: string;
  displayName?: string;
  description?: string;
  owner?: string;
  memberCount?: number;
  createTime?: string;
}

export interface GroupInfo {
  id: number;
  name: string;
  description: string;
  memberCount: number;
  /** Roblox user ID of the owner, if the group has one */
  ownerId?: number;
}

export interface GroupMember {
  userId: number;
  roleId: number;
  /** when they joined (unix ms), if Roblox says */
  joinedAt?: number;
}

const lastNumber = (s: string | undefined): number => {
  const m = /(\d+)\s*$/.exec(s ?? '');
  return m ? Number(m[1]) : 0;
};

export class GroupsClient {
  private readonly rankCache = new TtlCache<number, UserRank[]>(5 * 60_000, 2000);
  private readonly rolesCache = new TtlCache<number, GroupRole[]>(30 * 60_000, 20);
  private readonly groupCache = new TtlCache<number, GroupInfo>(10 * 60_000, 50);
  private readonly iconCache = new TtlCache<number, string | null>(60 * 60_000, 100);

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

  /** Name, description and member count (Open Cloud, cached 10 minutes). */
  async getGroup(groupId: number): Promise<GroupInfo> {
    return this.groupCache.getOrLoad(groupId, async () => {
      const res = await this.http.get<CloudGroup>(`${OPEN_CLOUD}/cloud/v2/groups/${groupId}`, { auth: true });
      const g = res.data ?? {};
      return {
        id: groupId,
        name: g.displayName ?? `Group ${groupId}`,
        description: g.description ?? '',
        memberCount: g.memberCount ?? 0,
        ownerId: g.owner ? lastNumber(g.owner) || undefined : undefined,
      };
    });
  }

  /** One page of members, optionally only one role. Pass the returned token to get the next page. */
  async listMembers(groupId: number, opts: { roleId?: number; pageToken?: string; pageSize?: number } = {}): Promise<{ members: GroupMember[]; nextPageToken?: string }> {
    const res = await this.http.get<CloudMemberships>(`${OPEN_CLOUD}/cloud/v2/groups/${groupId}/memberships`, {
      auth: true,
      query: {
        maxPageSize: Math.min(100, opts.pageSize ?? 50),
        pageToken: opts.pageToken,
        filter: opts.roleId ? `role == 'groups/${groupId}/roles/${opts.roleId}'` : undefined,
      },
    });
    const members = (res.data?.groupMemberships ?? [])
      .map((m) => {
        const t = m.createTime ? Date.parse(m.createTime) : NaN;
        return { userId: lastNumber(m.user), roleId: lastNumber(m.role), joinedAt: Number.isFinite(t) ? t : undefined };
      })
      .filter((m) => m.userId > 0);
    return { members, nextPageToken: res.data?.nextPageToken || undefined };
  }

  /** Group emblem pictures (public thumbnails API, no key sent). */
  async icons(groupIds: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const need = [...new Set(groupIds)].filter((id) => {
      const hit = this.iconCache.get(id);
      if (hit) out.set(id, hit);
      return hit === undefined;
    });
    if (!need.length) return out;
    try {
      const res = await this.http.get<{ data?: { targetId?: number; state?: string; imageUrl?: string }[] }>('https://thumbnails.roblox.com/v1/groups/icons', {
        query: { groupIds: need.join(','), size: '150x150', format: 'Png', isCircular: 'false' },
      });
      for (const t of res.data?.data ?? []) {
        if (!t.targetId) continue;
        const url = t.state === 'Completed' && t.imageUrl ? t.imageUrl : null;
        this.iconCache.set(t.targetId, url);
        if (url) out.set(t.targetId, url);
      }
    } catch {
      // pictures are optional
    }
    return out;
  }

  /** Forget cached roles and info for a group (after its ranks change). */
  forgetGroup(groupId: number): void {
    this.rolesCache.delete(groupId);
    this.groupCache.delete(groupId);
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
