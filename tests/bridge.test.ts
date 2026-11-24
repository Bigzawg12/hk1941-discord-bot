import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BridgeClient, describeResult } from '../src/bridge/client.js';
import { BRIDGE_ACTIONS, BRIDGE_VERSION, buildMessage, encodeMessage, type BridgeActor } from '../src/bridge/schema.js';
import { RobloxHttp } from '../src/roblox/http.js';
import { SortedMapReader } from '../src/roblox/memoryStore.js';
import { MessagingPublisher } from '../src/roblox/messaging.js';
import { testConfig } from './helpers/fixtures.js';
import { json, mockFetch, type Route } from './helpers/mockFetch.js';

const actor: BridgeActor = { d: '444444444444444444', r: 42, n: 'Maj_Test', t: 3 };
const UNIVERSE = 10772680614;

/** A clock that only moves when the client sleeps, so polling tests run instantly. */
function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function client(routes: Route[], over: Record<string, string> = {}) {
  const { fetch, calls } = mockFetch(routes);
  const clock = fakeClock();
  const http = new RobloxHttp({ apiKey: 'test-open-cloud-key', fetch, sleep: async () => undefined });
  const cfg = testConfig(over).bridge;
  const c = new BridgeClient({
    publisher: new MessagingPublisher(http, UNIVERSE),
    acks: new SortedMapReader(http, UNIVERSE),
    config: cfg,
    now: clock.now,
    sleep: clock.sleep,
  });
  return { c, calls, cfg };
}

const PUBLISH = `apis.roblox.com/messaging-service/v1/universes/${UNIVERSE}/topics/HK1941Discord`;
const ACK = `apis.roblox.com/cloud/v2/universes/${UNIVERSE}/memory-store/sorted-maps/HK1941_DiscordBridge/items/`;

describe('bridge schema', () => {
  it('builds a compact versioned message', () => {
    const m = buildMessage('ban', actor, { secs: 3600, reason: 'spam' }, { tgt: 99, nowSec: 1000, ttlSec: 120, id: 'abcdefabcdef' });
    expect(m).toEqual({ v: BRIDGE_VERSION, id: 'abcdefabcdef', ts: 1000, exp: 1120, act: 'ban', by: actor, tgt: 99, a: { secs: 3600, reason: 'spam' } });
  });

  it('requires a target for player actions and a linked actor', () => {
    expect(() => buildMessage('kick', actor, { reason: '' }, { nowSec: 0, ttlSec: 60 })).toThrow(/target/);
    expect(() => buildMessage('announce', { ...actor, r: 0 }, { text: 'hi' }, { nowSec: 0, ttlSec: 60 })).toThrow(/linked Roblox/);
  });

  it('clamps the tier and trims the name', () => {
    const m = buildMessage('announce', { ...actor, t: 9, n: 'x'.repeat(80) }, { text: 'hi' }, { nowSec: 0, ttlSec: 60 });
    expect(m.by.t).toBe(5);
    expect(m.by.n).toHaveLength(40);
  });

  it('keeps messages under the 1 kB MessagingService limit', () => {
    const ok = buildMessage('announce', actor, { text: 'x'.repeat(300) }, { nowSec: 0, ttlSec: 60 });
    expect(encodeMessage(ok).length).toBeLessThan(1000);
    const big = buildMessage('announce', actor, { text: '漢'.repeat(400) }, { nowSec: 0, ttlSec: 60 });
    expect(() => encodeMessage(big)).toThrow(/byte budget/);
  });
});

describe('BridgeClient', () => {
  it('publishes to the topic and returns the ack once a server is done', async () => {
    let polls = 0;
    const { c, calls } = client([
      ['POST', PUBLISH, json({})],
      ['GET', ACK, () => (++polls < 2 ? json({ error: 'NOT_FOUND' }, 404) : json({ id: 'x', value: JSON.stringify({ s: 'done', ok: true, m: 'Kicked Pte_A.', job: 'abcdef1234' }) }))],
    ]);
    const res = await c.send('kick', actor, { reason: 'spam' }, 99);
    expect(res.ack).toMatchObject({ s: 'done', ok: true, m: 'Kicked Pte_A.' });
    const pub = calls.find((x) => x.method === 'POST')!;
    expect(pub.headers['x-api-key']).toBe('test-open-cloud-key');
    const sent = JSON.parse((pub.body as { message: string }).message);
    expect(sent).toMatchObject({ v: 1, act: 'kick', tgt: 99, by: actor, a: { reason: 'spam' } });
    expect(calls.some((x) => x.url.includes(`/items/msg_${sent.id}`))).toBe(true);
    expect(describeResult(res, true)).toMatch(/✓ Kicked Pte_A\. \(server abcdef12\)/);
  });

  it('gives up after the timeout when no server answers', async () => {
    const { c } = client([
      ['POST', PUBLISH, json({})],
      ['GET', ACK, json({ error: 'NOT_FOUND' }, 404)],
    ]);
    const res = await c.send('unban', actor, {}, 99);
    expect(res.ack).toBeNull();
    expect(res.waitedMs).toBeGreaterThanOrEqual(12000);
    expect(describeResult(res, true)).toMatch(/no game server answered/);
  });

  it('keeps counting servers for a broadcast before answering', async () => {
    let n = 0;
    const { c } = client([
      ['POST', PUBLISH, json({})],
      ['GET', ACK, () => json({ value: { s: 'done', ok: true, n: Math.min(++n, 3), m: 'Seen by 40 players.' } })],
    ]);
    const res = await c.send('announce', actor, { text: 'Parade at 19:00' });
    expect(res.ack?.n).toBe(3);
    expect(describeResult(res, true, true)).toBe('Done on 3 servers. Seen by 40 players.');
  });

  it('does not poll when acknowledgements are off', async () => {
    const { c, calls } = client([['POST', PUBLISH, json({})]], { BRIDGE_ACKS: 'false' });
    const res = await c.send('announce', actor, { text: 'hi' });
    expect(res.ack).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe('the Luau bridge matches the bot', () => {
  const lua = readFileSync(new URL('../roblox/DiscordBridge.server.luau', import.meta.url), 'utf8');
  const cfg = testConfig();

  it('uses the same version, topic and map names', () => {
    expect(lua).toMatch(new RegExp(`local VERSION = ${BRIDGE_VERSION}\\b`));
    expect(lua).toContain(`local TOPIC = "${cfg.bridge.topic}"`);
    expect(lua).toContain(`local ACK_MAP = "${cfg.bridge.ackMap}"`);
    expect(lua).toContain(`local SERVER_MAP = "${cfg.bridge.serverMap}"`);
  });

  it('handles every action the bot can send, and has a tier for each', () => {
    for (const act of BRIDGE_ACTIONS) {
      expect(lua, `handler for ${act}`).toMatch(new RegExp(`\\nH\\.${act} = function`));
      expect(lua, `MIN_TIER for ${act}`).toMatch(new RegExp(`\\n\\t${act} = `));
    }
  });

  it('calls the game bindables and stores by the confirmed names', () => {
    for (const name of ['MedalControl', 'ServiceControl', 'MPControl', 'PlayerData', 'HKAdminConfig', 'HK1941_Bans', 'HK1941_Events', 'HK1941_AdminLog']) {
      expect(lua).toContain(name);
    }
  });
});
