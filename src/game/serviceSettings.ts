import type { Logger } from '../logger.js';
import type { DataStoreWriter } from '../roblox/datastores.js';
import type { GlobalData } from '../roblox/globalData.js';
import type { MessagingPublisher } from '../roblox/messaging.js';
import { UserFacingError } from '../util/errors.js';
import { POINTS, RANKS, type PointWeights, type RankRequirement } from './gameConfig.js';

/**
 * Point values and rank requirements set on the dashboard. They are saved in HK1941_Global
 * "HK1941_Config/service"; game servers (ServiceServer) read the same entry, so the game, the
 * record screen, /record and the dashboard all use the same numbers. Anything not set keeps the
 * game's default from ServiceConfig. Publishing "HK1941Config" tells live servers to re-read it.
 */

export const SETTINGS_AREA = 'HK1941_Config';
export const SETTINGS_KEY = 'service';
export const SETTINGS_TOPIC = 'HK1941Config';

export interface ServiceSettings {
  v: 1;
  points?: Partial<PointWeights>;
  /** by current rank: what the next rank needs */
  ranks?: Record<string, { points?: number; trainings?: number }>;
  /** unix ms and who, for the dashboard */
  t?: number;
  by?: string;
}

export const POINT_FIELDS: { key: keyof PointWeights; label: string; hint: string; max: number; min?: number }[] = [
  { key: 'deployedPer10Min', label: 'Time in the field', hint: 'per 10 minutes deployed', max: 1000 },
  { key: 'trainingAttended', label: 'Training attended', hint: 'per training', max: 10000 },
  { key: 'trainingPassed', label: 'Training passed', hint: 'on top of attending', max: 10000 },
  { key: 'trainingHosted', label: 'Training hosted', hint: 'per training hosted', max: 10000 },
  { key: 'eventAttended', label: 'Event', hint: 'deployed when an event starts', max: 10000 },
  { key: 'capture', label: 'Capture', hint: 'helped capture a point', max: 10000 },
  { key: 'aiKillsPer', label: 'AI IJA kills per point', hint: '1 point per this many AI killed', max: 10000, min: 1 },
  { key: 'enemyKill', label: 'Enemy player killed', hint: 'per kill', max: 10000 },
  { key: 'medalGallantry', label: 'Gallantry medal or order', hint: 'per award', max: 100000 },
  { key: 'medalOther', label: 'Other medal', hint: 'campaign, service, long service', max: 100000 },
  { key: 'qualification', label: 'Qualification', hint: 'per qualification badge', max: 100000 },
  { key: 'arrestMade', label: 'Arrest made (MP)', hint: 'per prisoner charged and held', max: 10000 },
];

export const DEFAULT_POINTS: Readonly<PointWeights> = Object.freeze({ ...POINTS });
export const DEFAULT_RANKS: Readonly<Record<number, Readonly<RankRequirement>>> = Object.freeze(
  Object.fromEntries(Object.entries(RANKS).map(([k, v]) => [k, Object.freeze({ ...v })])),
);

const whole = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.floor(v) : undefined;

/** Check a settings value, keeping only what's valid (the game does the same). */
export function cleanSettings(raw: unknown): ServiceSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<ServiceSettings>;
  const out: ServiceSettings = { v: 1 };
  if (s.points && typeof s.points === 'object') {
    const points: Partial<PointWeights> = {};
    for (const f of POINT_FIELDS) {
      const v = whole((s.points as Record<string, unknown>)[f.key], f.min ?? 0, f.max);
      if (v !== undefined) points[f.key] = v;
    }
    out.points = points;
  }
  if (s.ranks && typeof s.ranks === 'object') {
    const ranks: NonNullable<ServiceSettings['ranks']> = {};
    for (const [k, req] of Object.entries(s.ranks)) {
      if (!DEFAULT_RANKS[Number(k)] || !req || typeof req !== 'object') continue;
      const points = whole(req.points, 0, 10_000_000);
      const trainings = whole(req.trainings, 0, 100_000);
      if (points !== undefined || trainings !== undefined) ranks[k] = { points, trainings };
    }
    out.ranks = ranks;
  }
  if (typeof s.t === 'number') out.t = s.t;
  if (typeof s.by === 'string') out.by = s.by.slice(0, 60);
  return out;
}

/** Put settings into effect for the bot: the shared POINTS / RANKS tables change in place. */
export function applySettings(raw: unknown): ServiceSettings {
  const s = cleanSettings(raw);
  Object.assign(POINTS, DEFAULT_POINTS, s.points ?? {});
  for (const [k, def] of Object.entries(DEFAULT_RANKS)) {
    const over = s.ranks?.[k];
    RANKS[Number(k)] = { ...def, points: over?.points ?? def.points, trainings: over?.trainings ?? def.trainings };
  }
  return s;
}

export class ServiceSettingsStore {
  /** what's in effect (null = the game's defaults) */
  current: ServiceSettings | null = null;
  lastError: string | null = null;

  constructor(
    private readonly deps: { global: GlobalData; writer: DataStoreWriter; publisher: MessagingPublisher; storeName: string; logger: Logger },
  ) {}

  /** Read the saved settings and use them. Never throws: the defaults stay if it fails. */
  async load(): Promise<ServiceSettings | null> {
    try {
      this.deps.global.invalidate(SETTINGS_AREA, SETTINGS_KEY);
      const raw = await this.deps.global.get<unknown>(SETTINGS_AREA, SETTINGS_KEY);
      this.current = raw ? applySettings(raw) : (applySettings({}), null);
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn({ err }, 'could not read the point settings; using the defaults');
    }
    return this.current;
  }

  /** Save new settings, use them here, and tell live game servers. */
  async save(raw: unknown, by: string): Promise<ServiceSettings> {
    const s = { ...cleanSettings(raw), t: Date.now(), by };
    try {
      await this.deps.writer.setEntry(this.deps.storeName, `${SETTINGS_AREA}/${SETTINGS_KEY}`, s);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) {
        throw new UserFacingError(
          'Roblox refused to save the settings. The bot’s Open Cloud key needs Data Stores “create entry” and “update entry” (universe-datastores.objects:create and :update) for Hong Kong 1941.',
        );
      }
      throw err;
    }
    this.deps.global.invalidate(SETTINGS_AREA, SETTINGS_KEY);
    this.current = applySettings(s);
    await this.deps.publisher.publish(SETTINGS_TOPIC, 'changed').catch((err) => this.deps.logger.warn({ err }, 'could not tell live servers about the new point settings (they pick it up within 5 minutes)'));
    return s;
  }
}
