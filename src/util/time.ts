/**
 * Time parsing shared with the game's HKAdmin rules.
 * All clock times are UTC, as in game (";event add 19:00 ..." means 19:00 UTC).
 */

const UNIT: Record<string, number> = { m: 60, h: 3600, d: 86400, w: 604800 };

/** "30m" | "12h" | "7d" | "2w" | "perm" -> seconds (0 = permanent), or null if not understood. Same as HKAdmin parseDuration. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (s === 'perm' || s === 'permanent') return 0;
  const m = /^(\d+)\s*([mhdw])$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  return n * UNIT[m[2]!]!;
}

export function formatDuration(seconds: number): string {
  if (seconds === 0) return 'permanently';
  const parts: string[] = [];
  let left = seconds;
  for (const [label, size] of [
    ['w', 604800],
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
  ] as const) {
    if (left >= size) {
      parts.push(`${Math.floor(left / size)}${label}`);
      left %= size;
    }
  }
  return parts.join(' ') || `${seconds}s`;
}

/**
 * When an event starts, as unix seconds. Accepts (UTC):
 *   +30m / +2h / +1d            relative to now
 *   HH:MM                       today, or tomorrow if that time has passed
 *   YYYY-MM-DD HH:MM            a date and time
 *   <t:1767225600> / <t:...:F>  a Discord timestamp
 *   1767225600                  unix seconds
 * Returns null if not understood.
 */
export function parseWhen(input: string, nowSec: number): number | null {
  const s = input.trim();
  const discord = /^<t:(\d{9,11})(?::[tTdDfFR])?>$/.exec(s);
  if (discord) return Number(discord[1]);
  if (/^\d{9,11}$/.test(s)) return Number(s);

  const rel = /^\+(\d+)\s*([mhd])$/i.exec(s);
  if (rel) return nowSec + Number(rel[1]) * UNIT[rel[2]!.toLowerCase()]!;

  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(s);
  if (full) {
    const [, y, mo, d, hh, mm] = full.map(Number) as [number, number, number, number, number, number];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
    const t = Date.UTC(y, mo - 1, d, hh, mm) / 1000;
    const check = new Date(t * 1000);
    if (check.getUTCDate() !== d) return null; // e.g. 2026-02-31
    return t;
  }

  const clock = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (clock) {
    const hh = Number(clock[1]);
    const mm = Number(clock[2]);
    if (hh > 23 || mm > 59) return null;
    const now = new Date(nowSec * 1000);
    let t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm) / 1000;
    if (t < nowSec) t += 86400;
    return t;
  }
  return null;
}

/** Discord timestamp markup, shown in each reader's own time zone. */
export const discordTime = (unixSec: number, style: 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R' = 'f') =>
  `<t:${Math.floor(unixSec)}:${style}>`;
