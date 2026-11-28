import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { isModuleFile, loadCommands } from '../src/loaders/commands.js';
import { loadEvents } from '../src/loaders/events.js';
import { testServices } from './helpers/fixtures.js';

const EXPECTED = [
  'announce', 'apply', 'arrests', 'award', 'ban', 'eligible', 'event', 'help', 'kick', 'link',
  'medals', 'nominate', 'panel', 'points', 'post', 'promote', 'record', 'release', 'setup', 'ssu', 'status', 'unban', 'update', 'verify',
];

describe('command loader', () => {
  it('loads every command once', async () => {
    const commands = await loadCommands();
    expect([...commands.keys()].sort()).toEqual(EXPECTED);
  });

  it('builds valid Discord command JSON for each', async () => {
    for (const [name, cmd] of await loadCommands()) {
      const body = cmd.data.toJSON();
      expect(body.name).toBe(name);
      expect(body.description.length).toBeGreaterThan(0);
      expect(body.description.length).toBeLessThanOrEqual(100);
      expect(cmd.help.length).toBeGreaterThan(0);
      expect(JSON.stringify(body).length).toBeLessThan(8000);
    }
  });

  it('keeps subcommand tiers on real subcommands', async () => {
    for (const cmd of (await loadCommands()).values()) {
      const subs = new Set((cmd.data.toJSON().options ?? []).map((o) => o.name));
      for (const sub of Object.keys(cmd.subTiers ?? {})) expect(subs.has(sub), `${cmd.data.name} ${sub}`).toBe(true);
    }
  });

  it('mirrors the in-game HKAdmin tiers', async () => {
    const c = await loadCommands();
    const tier = (n: string) => c.get(n)!.tier;
    expect(tier('record')).toBe(0);
    expect(tier('arrests')).toBe(1);
    expect(tier('eligible')).toBe(1);
    expect(tier('kick')).toBe(2);
    expect(tier('release')).toBe(2);
    expect(tier('points')).toBe(2);
    expect(tier('ban')).toBe(3);
    expect(tier('unban')).toBe(4);
    expect(tier('announce')).toBe(4);
    expect(c.get('award')!.subTiers).toEqual({ medal: 3, tab: 2 });
    expect(c.get('event')!.subTiers).toEqual({ schedule: 2, cancel: 2 });
  });

  it('skips helpers, maps and tests', () => {
    expect(isModuleFile('record.js')).toBe(true);
    expect(isModuleFile('record.ts')).toBe(true);
    expect(isModuleFile('record.d.ts')).toBe(false);
    expect(isModuleFile('record.js.map')).toBe(false);
    expect(isModuleFile('_shared.ts')).toBe(false);
    expect(isModuleFile('record.test.ts')).toBe(false);
  });
});

describe('event loader', () => {
  it('attaches every event file to the client', async () => {
    const { services } = testServices([]);
    const client = new EventEmitter() as unknown as Client;
    const names = await loadEvents(client, services);
    expect(names.sort()).toEqual(['clientReady (once)', 'error', 'guildCreate', 'guildMemberAdd', 'guildScheduledEventCreate', 'guildScheduledEventDelete', 'guildScheduledEventUpdate', 'interactionCreate', 'warn']);
    expect((client as unknown as EventEmitter).listenerCount('interactionCreate')).toBe(1);
  });
});
