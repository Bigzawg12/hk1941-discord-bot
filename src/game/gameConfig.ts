/**
 * Copies of the in-game config the bot needs to explain records. Source of truth is the place:
 *   ReplicatedStorage.ServiceConfig  (points and rank requirements)
 *   ReplicatedStorage.MedalConfig    (medals and qualification tabs)
 *   ReplicatedStorage.MPConfig       (provost limits)
 * Copied 2026-11-23. When those modules change, update this file too, or records shown in
 * Discord will disagree with the game.
 * TODO: optionally have the bridge publish these tables to HK1941_Global so the bot can read them live.
 */

/**
 * Point weights (ServiceConfig.Points). These are the game's defaults; the dashboard can change them
 * live (src/game/serviceSettings.ts), and the values here are then replaced in place.
 */
export const POINTS: PointWeights = {
  deployedPer10Min: 1,
  trainingAttended: 8,
  trainingPassed: 6,
  trainingHosted: 15,
  eventAttended: 10,
  capture: 4,
  aiKillsPer: 2,
  enemyKill: 1,
  medalGallantry: 30,
  medalOther: 10,
  qualification: 15,
  arrestMade: 3,
};

export interface PointWeights {
  deployedPer10Min: number;
  trainingAttended: number;
  trainingPassed: number;
  trainingHosted: number;
  eventAttended: number;
  capture: number;
  aiKillsPer: number;
  enemyKill: number;
  medalGallantry: number;
  medalOther: number;
  qualification: number;
  arrestMade: number;
}

export interface RankRequirement {
  next: string;
  nextRank: number;
  points: number;
  trainings: number;
}

/** Indexed by the CURRENT army group rank (ServiceConfig.Ranks). Officers are by selection, so it stops at CWO. */
export const RANKS: Record<number, RankRequirement> = {
  1: { next: 'Private', nextRank: 2, points: 20, trainings: 1 },
  2: { next: 'Corporal', nextRank: 3, points: 120, trainings: 4 },
  3: { next: 'Master Corporal', nextRank: 4, points: 260, trainings: 8 },
  4: { next: 'Sergeant', nextRank: 5, points: 450, trainings: 12 },
  5: { next: 'Warrant Officer', nextRank: 6, points: 700, trainings: 18 },
  6: { next: 'Master Warrant Officer', nextRank: 7, points: 1000, trainings: 24 },
  7: { next: 'Chief Warrant Officer', nextRank: 8, points: 1400, trainings: 30 },
};

/** ServiceConfig.AdjustTier / AdjustCap */
export const ADJUST_TIER = 2;
export const ADJUST_CAP = 50;

export type MedalKind =
  | 'Gallantry'
  | 'Order'
  | 'Order of St John'
  | 'Campaign'
  | 'Service'
  | 'Long service'
  | 'Commendation';

export interface Medal {
  id: string;
  name: string;
  kind: MedalKind;
  post?: string;
  /** VC and GC: need TOP_AWARD_TIER */
  top?: boolean;
}

/** MedalConfig.List, in order of precedence (most senior first). Checked against the place 2026-11-26. */
export const MEDALS: Medal[] = [
  { id: 'VC', name: 'Victoria Cross', post: 'VC', kind: 'Gallantry', top: true },
  { id: 'GC', name: 'George Cross', post: 'GC', kind: 'Gallantry', top: true },
  { id: 'DSO', name: 'Distinguished Service Order', post: 'DSO', kind: 'Order' },
  { id: 'MBE', name: 'Member of the Order of the British Empire (Military)', post: 'MBE', kind: 'Order' },
  { id: 'MC', name: 'Military Cross', post: 'MC', kind: 'Gallantry' },
  { id: 'STJ_GC', name: 'Bailiff / Dame Grand Cross of the Order of St. John', post: 'GCStJ', kind: 'Order of St John' },
  { id: 'STJ_K', name: 'Knight / Dame of the Order of St. John', post: 'KStJ', kind: 'Order of St John' },
  { id: 'STJ_C', name: 'Commander of the Order of St. John', post: 'CStJ', kind: 'Order of St John' },
  { id: 'STJ_O', name: 'Officer of the Order of St. John', post: 'OStJ', kind: 'Order of St John' },
  { id: 'STJ_M', name: 'Member (Serving Brother / Sister) of the Order of St. John', post: 'MStJ', kind: 'Order of St John' },
  { id: 'STJ_E', name: 'Esquire of the Order of St. John', post: 'EsqStJ', kind: 'Order of St John' },
  { id: 'DCM', name: 'Distinguished Conduct Medal', post: 'DCM', kind: 'Gallantry' },
  { id: 'GM', name: 'George Medal', post: 'GM', kind: 'Gallantry' },
  { id: 'MM', name: 'Military Medal', post: 'MM', kind: 'Gallantry' },
  { id: 'STAR39', name: '1939–45 Star', kind: 'Campaign' },
  { id: 'PACIFIC', name: 'Pacific Star', kind: 'Campaign' },
  { id: 'DEFENCE', name: 'Defence Medal', kind: 'Service' },
  { id: 'CVSM', name: 'Canadian Volunteer Service Medal', kind: 'Service' },
  { id: 'WAR', name: 'War Medal 1939–45', kind: 'Service' },
  { id: 'LSGC', name: 'Long Service and Good Conduct Medal', kind: 'Long service' },
  { id: 'EM', name: 'Efficiency Medal (Canada)', kind: 'Long service' },
  { id: 'MID', name: 'Mention in Despatches', post: 'MiD', kind: 'Commendation' },
  { id: 'CINC', name: 'Commander-in-Chief Unit Commendation', kind: 'Commendation' },
  { id: 'GGCB', name: "Governor General's Commendation for Bravery", kind: 'Commendation' },
  { id: 'CDS', name: 'Chief of the Defence Staff Commendation', kind: 'Commendation' },
  { id: 'CMD', name: 'Command Commendation', kind: 'Commendation' },
  { id: 'STJ_CHAN', name: "St. John Chancellor's Commendation", kind: 'Commendation' },
  { id: 'STJ_PROV', name: 'St. John Provincial / Territorial Commendation', kind: 'Commendation' },
];

export interface Cert {
  id: string;
  name: string;
  /** Service stripes: each award adds one, up to MAX_STRIPES (the game counts them in rec.n) */
  stripes?: boolean;
}

/** MedalConfig.Certs (sleeve badges), most senior first. */
export const CERTS: Cert[] = [
  { id: 'RIFLE_QUAL', name: 'Rifle Qualification Badge' },
  { id: 'RIFLE_PROF', name: 'Rifle Proficiency Badge' },
  { id: 'SERVICE', name: 'Service Stripes', stripes: true },
];

/** MedalConfig.MaxStripes */
export const MAX_STRIPES = 6;

export const MEDAL_BY_ID: ReadonlyMap<string, Medal> = new Map(MEDALS.map((m) => [m.id, m]));
export const CERT_BY_ID: ReadonlyMap<string, Cert> = new Map(CERTS.map((c) => [c.id, c]));
export const MEDAL_RANK: ReadonlyMap<string, number> = new Map(MEDALS.map((m, i) => [m.id, i]));
export const CERT_RANK: ReadonlyMap<string, number> = new Map(CERTS.map((c, i) => [c.id, i]));

/** MedalConfig.MinAwardTier / TopAwardTier / MinCertTier */
export const MIN_AWARD_TIER = 3;
export const TOP_AWARD_TIER = 4;
export const MIN_CERT_TIER = 2;

/** MPConfig.MaxSentence (minutes) */
export const MAX_SENTENCE_MIN = 30;
