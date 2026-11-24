import { describe, expect, it } from 'vitest';
import { normalizeProfile } from '../src/game/profile.js';
import { computePoints, hours, standing } from '../src/game/points.js';
import { SAMPLE_PROFILE } from './helpers/fixtures.js';

describe('points (port of ServiceServer.computePoints)', () => {
  const p = normalizeProfile(SAMPLE_PROFILE);

  it('adds up every part with the ServiceConfig weights', () => {
    const { total, parts } = computePoints(p);
    const byName = Object.fromEntries(parts);
    expect(byName['Time in the field']).toBe(30); // 300 min / 10
    expect(byName['Trainings attended']).toBe(40);
    expect(byName['Trainings passed']).toBe(24);
    expect(byName['Events']).toBe(20);
    expect(byName['Captures']).toBe(12);
    expect(byName['AI IJA killed']).toBe(4); // 9 / 2, rounded down
    expect(byName['Enemy killed']).toBe(7);
    expect(byName['Arrests made']).toBe(6);
    expect(byName['Medals']).toBe(40); // MC (gallantry 30) + Pacific Star (10)
    expect(byName['Qualifications']).toBe(15);
    expect(byName['Awarded by staff']).toBe(5);
    expect(total).toBe(203);
  });

  it('ignores unknown medal and tab ids, and never goes below zero', () => {
    const q = normalizeProfile({ medals: { a: { NOPE: { n: 3 } }, q: { NOPE: {} } }, service: { manual: -500 } });
    expect(computePoints(q).total).toBe(0);
  });

  it('checks the next-rank requirements by current army rank', () => {
    expect(standing(p, 2)).toMatchObject({ points: 203, eligible: true, next: { next: 'Corporal', points: 120, trainings: 4 } });
    expect(standing(p, 3)).toMatchObject({ eligible: false, next: { next: 'Master Corporal' } });
    expect(standing(p, 0).next?.next).toBe('Private'); // not in the group: same as rank 1
    expect(standing(p, 9)).toMatchObject({ next: null, eligible: false }); // officers: by selection
  });

  it('needs the trainings as well as the points', () => {
    const q = normalizeProfile({ ...SAMPLE_PROFILE, training: { ...SAMPLE_PROFILE.training, attended: 3 } });
    expect(standing(q, 2).eligible).toBe(false);
  });

  it('formats minutes as hours', () => {
    expect(hours(90)).toBe('1.5 h');
  });
});
