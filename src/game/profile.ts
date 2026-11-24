/**
 * The HK1941 player profile, as ServerStorage.PlayerData stores it (ProfileStore, store HK1941_Profiles,
 * key "u<userId>"). Mirrors PD.Template; keep in sync when the template changes.
 */

export interface MedalAward {
  /** times awarded */
  n?: number;
  /** first awarded (unix seconds) */
  t?: number;
  by?: string;
  /** latest citation */
  c?: string;
  /** history, newest first (up to 6) */
  h?: { t?: number; by?: string; c?: string }[];
}

export interface Qualification {
  t?: number;
  by?: string;
}

export interface TrainingEntry {
  title?: string;
  t?: number;
  result?: string;
  host?: string;
  [k: string]: unknown;
}

export interface ServiceLogEntry {
  t?: number;
  n?: number;
  by?: string;
  reason?: string;
}

/** One arrest on a player's own record (MPServer `entry`). */
export interface ArrestEntry {
  t?: number;
  by?: string;
  byId?: number;
  charges?: string[];
  minutes?: number;
  notes?: string;
  team?: string;
}

export interface Profile {
  settings: Record<string, unknown>;
  medals: { a: Record<string, MedalAward>; q: Record<string, Qualification>; wear: boolean };
  loadouts: Record<string, unknown>;
  training: {
    attended: number;
    passed: number;
    failed: number;
    hosted: number;
    last?: number;
    history: TrainingEntry[];
    hostedList: TrainingEntry[];
  };
  service: {
    joins: number;
    firstJoin: number;
    lastJoin: number;
    /** minutes in game */
    playtime: number;
    /** minutes deployed in the field */
    deployedTime: number;
    deployments: number;
    deaths: number;
    kills: number;
    aiKills: number;
    captures: number;
    events: number;
    /** points added or removed by staff */
    manual: number;
    log: ServiceLogEntry[];
  };
  mp: {
    arrests: ArrestEntry[];
    jailUntil: number;
    /** seconds of a sentence still to serve */
    jailLeft: number;
    jailCharges: string;
    jailBy: string;
    /** arrests this player made as an MP */
    made: number;
  };
  migrated: boolean;
}

export interface ActiveSession {
  placeId?: number;
  jobId?: string;
}

export interface ProfileSnapshot {
  userId: number;
  data: Profile;
  /** Best effort: ProfileStore's MetaData.ActiveSession, set while a server holds the profile. */
  activeSession: ActiveSession | null;
  version?: string;
  updatedAt?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const rec = <T>(v: unknown): Record<string, T> => (isObj(v) ? (v as Record<string, T>) : {});

/** Fill missing fields with template defaults, like ProfileStore's Reconcile(). */
export function normalizeProfile(raw: unknown): Profile {
  const d = isObj(raw) ? raw : {};
  const medals = rec<unknown>(d.medals);
  const t = rec<unknown>(d.training);
  const s = rec<unknown>(d.service);
  const mp = rec<unknown>(d.mp);
  return {
    settings: rec(d.settings),
    medals: {
      a: rec<MedalAward>(medals.a),
      q: rec<Qualification>(medals.q),
      wear: medals.wear !== false,
    },
    loadouts: rec(d.loadouts),
    training: {
      attended: num(t.attended),
      passed: num(t.passed),
      failed: num(t.failed),
      hosted: num(t.hosted),
      last: typeof t.last === 'number' ? t.last : undefined,
      history: arr<TrainingEntry>(t.history),
      hostedList: arr<TrainingEntry>(t.hostedList),
    },
    service: {
      joins: num(s.joins),
      firstJoin: num(s.firstJoin),
      lastJoin: num(s.lastJoin),
      playtime: num(s.playtime),
      deployedTime: num(s.deployedTime),
      deployments: num(s.deployments),
      deaths: num(s.deaths),
      kills: num(s.kills),
      aiKills: num(s.aiKills),
      captures: num(s.captures),
      events: num(s.events),
      manual: num(s.manual),
      log: arr<ServiceLogEntry>(s.log),
    },
    mp: {
      arrests: arr<ArrestEntry>(mp.arrests),
      jailUntil: num(mp.jailUntil),
      jailLeft: num(mp.jailLeft),
      jailCharges: str(mp.jailCharges),
      jailBy: str(mp.jailBy),
      made: num(mp.made),
    },
    migrated: d.migrated === true,
  };
}

/**
 * ProfileStore saves `{ Data = <profile>, MetaData = {...}, ... }` under the key. Unwrap `.Data`.
 * Throws if the value isn't a ProfileStore record (so a wrong store name fails loudly).
 */
export function unwrapProfileStore(
  value: unknown,
  userId: number,
  meta: { version?: string; updatedAt?: string } = {},
): ProfileSnapshot {
  if (!isObj(value) || !('Data' in value)) {
    throw new Error(`Entry u${userId} isn't a ProfileStore record (no .Data).`);
  }
  return {
    userId,
    data: normalizeProfile(value.Data),
    activeSession: readActiveSession(value.MetaData),
    version: meta.version,
    updatedAt: meta.updatedAt,
  };
}

function readActiveSession(meta: unknown): ActiveSession | null {
  if (!isObj(meta)) return null;
  const a = meta.ActiveSession;
  // ProfileStore: { place_id, game_job_id, unique_session_id } stored as an array
  if (Array.isArray(a) && a.length >= 2) {
    return { placeId: typeof a[0] === 'number' ? a[0] : undefined, jobId: typeof a[1] === 'string' ? a[1] : undefined };
  }
  if (isObj(a)) {
    return {
      placeId: num(a.place_id ?? a.PlaceId, 0) || undefined,
      jobId: str(a.game_job_id ?? a.JobId) || undefined,
    };
  }
  return null;
}
