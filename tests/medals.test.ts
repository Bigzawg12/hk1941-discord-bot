import { describe, expect, it, vi } from 'vitest';
import award from '../src/commands/award.js';
import { tabNames } from '../src/discord/embeds.js';
import { CERTS, MAX_STRIPES, MEDALS } from '../src/game/gameConfig.js';
import { normalizeProfile } from '../src/game/profile.js';

describe('medal lists (MedalConfig, 2026-11-26)', () => {
  it('matches the game: 28 medals, 3 sleeve badges, unique ids', () => {
    expect(MEDALS).toHaveLength(28);
    expect(new Set(MEDALS.map((m) => m.id)).size).toBe(28);
    expect(CERTS.map((c) => c.id)).toEqual(['RIFLE_QUAL', 'RIFLE_PROF', 'SERVICE']);
    expect(MEDALS.filter((m) => m.top).map((m) => m.id)).toEqual(['VC', 'GC']);
  });

  it('/award medal uses search, not fixed choices (Discord allows 25)', () => {
    const json = award.data.toJSON() as { options: { name: string; options: { name: string; autocomplete?: boolean; choices?: unknown[] }[] }[] };
    const medal = json.options.find((o) => o.name === 'medal')!.options.find((o) => o.name === 'medal')!;
    expect(medal.autocomplete).toBe(true);
    expect(medal.choices ?? []).toHaveLength(0);
  });

  it('medal search finds St John grades by name or post-nominal', async () => {
    const respond = vi.fn();
    const search = (typed: string) => award.autocomplete!({ options: { getFocused: () => typed }, respond } as never, {} as never);
    await search('st. john');
    const names = respond.mock.calls[0]![0] as { value: string }[];
    expect(names.map((c) => c.value)).toEqual(expect.arrayContaining(['STJ_GC', 'STJ_E', 'STJ_CHAN']));
    await search('kstj');
    expect((respond.mock.calls[1]![0] as { value: string }[]).map((c) => c.value)).toEqual(['STJ_K']);
    await search('');
    expect(respond.mock.calls[2]![0]).toHaveLength(25);
  });

  it('records show the service stripe count', () => {
    const p = { data: normalizeProfile({ medals: { q: { RIFLE_PROF: {}, SERVICE: { n: 3 } } } }) } as never;
    expect(tabNames(p)).toEqual(['Rifle Proficiency Badge', '3 service stripes']);
    const many = { data: normalizeProfile({ medals: { q: { SERVICE: { n: 99 } } } }) } as never;
    expect(tabNames(many)).toEqual([`${MAX_STRIPES} service stripes`]);
  });
});
