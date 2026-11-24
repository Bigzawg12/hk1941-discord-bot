import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration, parseWhen } from '../src/util/time.js';

describe('parseDuration (same rules as HKAdmin)', () => {
  it.each([
    ['30m', 1800],
    ['12h', 43200],
    ['7d', 604800],
    ['2w', 1209600],
    ['perm', 0],
    ['Permanent', 0],
    [' 1H ', 3600],
  ])('%s -> %i', (input, secs) => expect(parseDuration(input)).toBe(secs));

  it.each(['', '0d', '5', 'abc', '1y', '-1d'])('rejects %j', (input) => expect(parseDuration(input)).toBeNull());

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('permanently');
    expect(formatDuration(90061)).toBe('1d 1h 1m');
  });
});

describe('parseWhen (UTC, like ;event add)', () => {
  const now = Date.UTC(2026, 10, 24, 18, 30) / 1000; // Tue 24 Nov 2026 18:30 UTC

  it('takes relative times', () => {
    expect(parseWhen('+2h', now)).toBe(now + 7200);
    expect(parseWhen('+30m', now)).toBe(now + 1800);
    expect(parseWhen('+1d', now)).toBe(now + 86400);
  });

  it('takes a clock time today, or tomorrow once it has passed', () => {
    expect(parseWhen('19:00', now)).toBe(Date.UTC(2026, 10, 24, 19, 0) / 1000);
    expect(parseWhen('07:15', now)).toBe(Date.UTC(2026, 10, 25, 7, 15) / 1000);
  });

  it('takes a full date and time', () => {
    expect(parseWhen('2026-12-01 20:00', now)).toBe(Date.UTC(2026, 11, 1, 20, 0) / 1000);
    expect(parseWhen('2026-02-31 20:00', now)).toBeNull();
  });

  it('takes Discord timestamps and unix seconds', () => {
    expect(parseWhen('<t:1798000000:F>', now)).toBe(1798000000);
    expect(parseWhen('<t:1798000000>', now)).toBe(1798000000);
    expect(parseWhen('1798000000', now)).toBe(1798000000);
  });

  it.each(['tomorrow', '25:00', '+2y', '2026-13-01 10:00'])('rejects %j', (input) => expect(parseWhen(input, now)).toBeNull());
});
