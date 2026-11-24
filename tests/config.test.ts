import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ConfigError } from '../src/util/errors.js';
import { BASE_ENV, IDS } from './helpers/fixtures.js';

describe('loadConfig', () => {
  it('fills in the HK1941 defaults', () => {
    const c = loadConfig(BASE_ENV);
    expect(c.roblox.universeId).toBe(10772680614);
    expect(c.roblox.placeId).toBe(77901932829123);
    expect(c.roblox.profileStore).toBe('HK1941_Profiles');
    expect(c.roblox.globalStore).toBe('HK1941_Global');
    expect(c.roblox.armyGroupId).toBe(409406376);
    expect(c.roblox.ownerGroupId).toBe(668236881);
    expect(c.bridge.topic).toBe('HK1941Discord');
    expect(c.bridge.acksEnabled).toBe(true);
    expect(c.permissions.armyRankTiers).toEqual([
      { rank: 5, tier: 1 },
      { rank: 9, tier: 2 },
      { rank: 11, tier: 3 },
      { rank: 13, tier: 4 },
    ]);
    expect(c.permissions.roleTiers[2]).toEqual([IDS.modRole]);
    expect(c.linking.provider).toBe('blurb');
  });

  it('treats blank values as unset', () => {
    const c = loadConfig({ ...BASE_ENV, AUDIT_CHANNEL_ID: '', ROBLOX_UNIVERSE_ID: '  ', TIER1_ROLE_IDS: '' });
    expect(c.discord.auditChannelId).toBeUndefined();
    expect(c.roblox.universeId).toBe(10772680614);
    expect(c.permissions.roleTiers[1]).toEqual([]);
  });

  it('parses role lists, owner ids and command overrides', () => {
    const c = loadConfig({
      ...BASE_ENV,
      TIER4_ROLE_IDS: '666666666666666666, 777777777777777777',
      OWNER_DISCORD_IDS: '888888888888888888',
      COMMAND_TIERS: 'announce:2, event.schedule:3',
      LOG_PRETTY: 'yes',
    });
    expect(c.permissions.roleTiers[4]).toEqual(['666666666666666666', '777777777777777777']);
    expect(c.permissions.ownerDiscordIds).toEqual(['888888888888888888']);
    expect(c.permissions.commandTiers).toEqual({ announce: 2, 'event.schedule': 3 });
    expect(c.log.pretty).toBe(true);
  });

  it('rejects bad values with every problem listed', () => {
    try {
      loadConfig({ ...BASE_ENV, TIER2_ROLE_IDS: 'not-an-id', COMMAND_TIERS: 'announce=2', BRIDGE_ACKS: 'maybe' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const problems = (err as ConfigError).problems.join('\n');
      expect(problems).toContain('TIER2_ROLE_IDS');
      expect(problems).toContain('COMMAND_TIERS');
      expect(problems).toContain('BRIDGE_ACKS');
    }
  });

  it('needs the token, client id and the bot key to run', () => {
    expect(() => loadConfig({ TIER2_ROLE_IDS: IDS.modRole })).toThrow(/DISCORD_TOKEN[\s\S]*DISCORD_CLIENT_ID[\s\S]*HK_OPEN_CLOUD_KEY/);
  });

  it('never falls back to a personal ROBLOX_OPEN_CLOUD_API_KEY', () => {
    const env = { ...BASE_ENV, HK_OPEN_CLOUD_KEY: undefined, ROBLOX_OPEN_CLOUD_API_KEY: 'fake-personal-key' };
    expect(() => loadConfig(env)).toThrow(/HK_OPEN_CLOUD_KEY/);
  });

  it('only needs Discord settings to register commands', () => {
    const c = loadConfig({ DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: IDS.client }, 'deploy');
    expect(c.roblox.apiKey).toBeUndefined();
  });

  it('needs a guild and key for Bloxlink', () => {
    expect(() => loadConfig({ ...BASE_ENV, LINK_PROVIDER: 'bloxlink', DISCORD_GUILD_ID: '' })).toThrow(/BLOXLINK_API_KEY[\s\S]*DISCORD_GUILD_ID/);
  });

  it('refuses to start with no way to recognise staff', () => {
    expect(() =>
      loadConfig({ DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: IDS.client, HK_OPEN_CLOUD_KEY: 'k', TIER_FROM_ROBLOX_RANK: 'false' }),
    ).toThrow(/No staff can be recognised/);
  });
});
