import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../src/roblox/globalData.js';
import { calendarEmbed, calendarKey, markerOf, planAnnouncements, planDiscordChanges, withMarker } from '../src/sync/eventPlan.js';

const NOW = 1_800_000_000;
const ev = (id: string, inMin: number, title = `Op ${id}`): GameEvent => ({ id, title, detail: 'Meet at the PPCLI lines', start: NOW + inMin * 60, host: 'Maj_Test' });

describe('event markers', () => {
  it('ties a Discord event to an in-game event through its location', () => {
    expect(withMarker(null, '1234')).toBe('Hong Kong 1941 (Roblox) · #1234');
    expect(markerOf('Hong Kong 1941 (Roblox) · #1234')).toBe('1234');
    expect(withMarker('Wong Nai Chung Gap', '77')).toBe('Wong Nai Chung Gap · #77');
    expect(withMarker('Gap · #77', '78')).toBe('Gap · #78');
    expect(markerOf('Some voice hangout')).toBeNull();
    expect(withMarker('x'.repeat(120), '1234')).toHaveLength(100);
  });
});

describe('planDiscordChanges', () => {
  it('adds missing upcoming events and removes ones gone from the game', () => {
    const plan = planDiscordChanges(
      [ev('1', 60), ev('2', 120), ev('3', -30)],
      [
        { id: 'd2', gameId: '2', live: true },
        { id: 'd9', gameId: '9', live: true },
        { id: 'd8', gameId: '8', live: false },
      ],
      NOW,
    );
    expect(plan.create.map((e) => e.id)).toEqual(['1']); // #3 already started: Discord can't hold it
    expect(plan.remove).toEqual(['d9']); // d8 is already finished/cancelled
  });

  it('recreates an event whose Discord copy was completed but the game still has', () => {
    expect(planDiscordChanges([ev('5', 30)], [{ id: 'd5', gameId: '5', live: false }], NOW).create).toHaveLength(1);
  });
});

describe('planAnnouncements', () => {
  it('announces nothing old the first time a server is seen', () => {
    const r = planAnnouncements([ev('1', 300), ev('2', 10), ev('3', -2)], undefined, NOW, 15);
    expect(r.posts).toEqual([]);
    expect(r.next).toEqual({ seen: ['1', '2', '3'], stage: { '2': 1, '3': 2 } });
  });

  it('posts new, then a reminder, then starting now, once each', () => {
    let state = planAnnouncements([], undefined, NOW, 15).next;
    const e = ev('7', 60);
    let r = planAnnouncements([e], state, NOW, 15);
    expect(r.posts.map((p) => p.kind)).toEqual(['new']);
    state = r.next;
    expect(planAnnouncements([e], state, NOW + 10 * 60, 15).posts).toEqual([]);
    r = planAnnouncements([e], state, NOW + 46 * 60, 15);
    expect(r.posts.map((p) => p.kind)).toEqual(['soon']);
    state = r.next;
    expect(planAnnouncements([e], state, NOW + 50 * 60, 15).posts).toEqual([]);
    r = planAnnouncements([e], state, NOW + 60 * 60 + 30, 15);
    expect(r.posts.map((p) => p.kind)).toEqual(['now']);
    expect(planAnnouncements([e], r.next, NOW + 62 * 60, 15).posts).toEqual([]);
  });

  it('skips "new" when an event is added inside the reminder window', () => {
    const state = planAnnouncements([], undefined, NOW, 15).next;
    expect(planAnnouncements([ev('8', 5)], state, NOW, 15).posts.map((p) => p.kind)).toEqual(['soon']);
  });

  it('does not post "starting now" long after the start (bot was offline)', () => {
    const state = planAnnouncements([], undefined, NOW, 15).next;
    const r = planAnnouncements([ev('9', -40)], state, NOW, 15);
    expect(r.posts).toEqual([]);
    expect(r.next.stage['9']).toBe(2);
  });

  it('only reports a change when there is one', () => {
    const first = planAnnouncements([ev('1', 300)], undefined, NOW, 15);
    expect(first.changed).toBe(true);
    expect(planAnnouncements([ev('1', 300)], first.next, NOW + 60, 15).changed).toBe(false);
  });
});

describe('calendar', () => {
  it('lists events with Discord timestamps and marks running ones', () => {
    const json = JSON.stringify(calendarEmbed([ev('3', -10), ev('4', 90)], NOW).toJSON());
    expect(json).toContain('On now · #3');
    expect(json).toContain(`<t:${NOW + 90 * 60}:F>`);
    expect(JSON.stringify(calendarEmbed([], NOW).toJSON())).toContain('No events scheduled');
  });

  it('changes its key only when what it shows changes', () => {
    const list = [ev('4', 90)];
    expect(calendarKey(list, NOW)).toBe(calendarKey(list, NOW + 60));
    expect(calendarKey(list, NOW)).not.toBe(calendarKey(list, NOW + 91 * 60));
  });
});
