import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdminLogArchive, commandOf, normaliseEntry } from '../src/game/adminLogArchive.js';
import type { AdminLogEntry } from '../src/roblox/globalData.js';

describe('in-game admin log copy', () => {
  it('reads HKAdmin entries: Discord ones, automatic ones, junk', () => {
    expect(normaliseEntry({ t: 10, by: 'Maj_X', text: ';kick A' })).toEqual({ t: 10, by: 'Maj_X', text: ';kick A', viaDiscord: false });
    expect(normaliseEntry({ t: 10, by: 'Maj_X (Discord)', text: 'ban 5 1 day' })).toMatchObject({ by: 'Maj_X', viaDiscord: true });
    expect(normaliseEntry({ t: 10, text: 'battle lock lifted' })).toMatchObject({ by: 'server' });
    expect(normaliseEntry({ by: 'x', text: 'no time' } as AdminLogEntry)).toBeNull();
    expect(commandOf({ t: 1, by: 'A', text: ';Award B MM', viaDiscord: false })).toBe('award');
    expect(commandOf({ t: 1, by: 'A', text: 'ban 5', viaDiscord: true })).toBe('ban');
    expect(commandOf({ t: 1, by: 'server', text: 'battle lock lifted', viaDiscord: false })).toBe('system');
  });

  it('keeps history past the game’s 200 and never doubles an entry', async () => {
    let game: AdminLogEntry[] = [{ t: 2, by: 'A', text: ';kick B' }, { t: 1, by: 'A', text: ';warn B' }];
    const a = new AdminLogArchive(async () => game);
    expect(await a.refresh()).toBe(2);
    expect(await a.refresh()).toBe(0);
    game = [{ t: 3, by: 'C', text: ';ban D' }, game[0]!]; // the oldest fell off the game's list
    expect(await a.refresh()).toBe(1);
    expect((await a.list()).map((e) => e.t)).toEqual([3, 2, 1]);
  });

  it('saves to disk and loads it back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hk-adminlog-'));
    try {
      const file = join(dir, 'admin-log.json');
      await new AdminLogArchive(async () => [{ t: 5, by: 'A (Discord)', text: 'kick 1' }], file).refresh();
      expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(1);
      const again = new AdminLogArchive(async () => [{ t: 5, by: 'A (Discord)', text: 'kick 1' }], file);
      expect(await again.refresh()).toBe(0);
      expect(await again.list()).toEqual([{ t: 5, by: 'A', text: 'kick 1', viaDiscord: true }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('remembers a failed read for the page to show', async () => {
    const a = new AdminLogArchive(async () => {
      throw new Error('403 Forbidden');
    });
    await expect(a.refresh()).rejects.toThrow('403');
    expect(a.lastError).toContain('403');
  });
});
