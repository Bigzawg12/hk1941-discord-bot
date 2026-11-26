import { vi } from 'vitest';
import { IDS } from './fixtures.js';

export const VERIFIED = '700000000000000001';
export const UNVERIFIED = '700000000000000002';
export const CORPORAL = '700000000000000003';
export const OFFICER = '700000000000000004';

/** A Discord server the bot is in, with one member whose role changes are recorded. */
export function fakeGuild(memberRoles: string[] = [], opts: { botTop?: number; nickname?: string | null } = {}) {
  const roles = new Map([VERIFIED, UNVERIFIED, CORPORAL, OFFICER].map((id, i) => [id, { id, name: `role${i}`, position: 5 + i, managed: false }]));
  const has = new Map(memberRoles.map((r) => [r, {}]));
  const member = {
    id: IDS.staffUser,
    nickname: opts.nickname ?? null,
    user: { username: 'tester', globalName: null },
    roles: {
      cache: has,
      highest: { position: 1 },
      add: vi.fn(async (ids: string[]) => ids.forEach((i) => has.set(i, {}))),
      remove: vi.fn(async (ids: string[]) => ids.forEach((i) => has.delete(i))),
    },
    setNickname: vi.fn(async (n: string) => {
      member.nickname = n;
    }),
  };
  const guild = {
    id: IDS.guild,
    name: 'HK1941 Test',
    ownerId: '1',
    memberCount: 10,
    roles: { cache: roles },
    channels: { cache: new Map([['800000000000000001', { id: '800000000000000001', name: 'general', type: 0, position: 0 }]]) },
    members: {
      fetch: vi.fn(async (id: string) => {
        if (id !== IDS.staffUser) throw new Error('Unknown Member');
        return member;
      }),
      me: { roles: { highest: { position: opts.botTop ?? 50 } }, permissions: { has: () => true } },
    },
  };
  return { guild, member };
}

