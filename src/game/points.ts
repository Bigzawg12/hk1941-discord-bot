import { CERT_BY_ID, MEDAL_BY_ID, POINTS, RANKS, type RankRequirement } from './gameConfig.js';
import type { Profile } from './profile.js';

/** A port of ServiceServer's computePoints / standing. Keep the two in step. */

export type PointsPart = [label: string, points: number];

export function computePoints(d: Profile): { total: number; parts: PointsPart[] } {
  const s = d.service;
  const t = d.training;
  const P = POINTS;
  const parts: PointsPart[] = [
    ['Time in the field', Math.floor(s.deployedTime / 10) * P.deployedPer10Min],
    ['Trainings attended', t.attended * P.trainingAttended],
    ['Trainings passed', t.passed * P.trainingPassed],
    ['Trainings hosted', t.hosted * P.trainingHosted],
    ['Events', s.events * P.eventAttended],
    ['Captures', s.captures * P.capture],
    ['AI IJA killed', Math.floor(s.aiKills / P.aiKillsPer)],
    ['Enemy killed', s.kills * P.enemyKill],
    ['Arrests made', d.mp.made * P.arrestMade],
  ];
  let medals = 0;
  for (const [id, rec] of Object.entries(d.medals.a)) {
    const m = MEDAL_BY_ID.get(id);
    if (m) medals += (rec?.n ?? 1) * (m.kind === 'Gallantry' || m.kind === 'Order' ? P.medalGallantry : P.medalOther);
  }
  let tabs = 0;
  for (const id of Object.keys(d.medals.q)) if (CERT_BY_ID.has(id)) tabs += P.qualification;
  parts.push(['Medals', medals], ['Qualifications', tabs], ['Awarded by staff', s.manual]);
  const total = parts.reduce((sum, [, n]) => sum + n, 0);
  return { total: Math.max(total, 0), parts };
}

export interface Standing {
  points: number;
  /** requirement for the next rank, or null when the record has no next rank (officers, CWO) */
  next: (RankRequirement & { haveTrainings: number }) | null;
  eligible: boolean;
}

/** `rank` is the player's current army group rank (0 if not in the group). */
export function standing(d: Profile, rank: number): Standing {
  const { total } = computePoints(d);
  const req = RANKS[Math.max(rank, 1)];
  if (!req) return { points: total, next: null, eligible: false };
  const have = d.training.attended;
  return { points: total, next: { ...req, haveTrainings: have }, eligible: total >= req.points && have >= req.trainings };
}

/** "12.5 h" from minutes, like the record screen. */
export const hours = (minutes: number) => `${(minutes / 60).toFixed(1)} h`;
