/**
 * Matching Roblox group ranks to Discord roles by name, for "Bind ranks by name" on the dashboard.
 * Names are compared in a plain form: lower case, no punctuation, company letters and their
 * WWII phonetic words treated alike ("C", "C Coy", "Charlie Company"), and common army
 * abbreviations spelled out ("Cpl" = "Corporal"). First exact matches, then a role whose name
 * contains the rank's words when only one role does. Each role is used once, longer rank names
 * first, so "Master Corporal" isn't taken by "Corporal".
 */

export interface RankToBind {
  rank: number;
  name: string;
}

export interface RoleCandidate {
  id: string;
  name: string;
}

export interface RankMatch {
  rank: number;
  rankName: string;
  role?: RoleCandidate;
  how?: 'exact' | 'contains';
}

/** The 1941 Joint Army/Navy phonetic alphabet (Able, Baker, Charlie…), to the letter. */
const PHONETIC: Record<string, string> = {
  able: 'a', baker: 'b', charlie: 'c', dog: 'd', easy: 'e', fox: 'f', george: 'g', how: 'h', item: 'i',
  jig: 'j', king: 'k', love: 'l', mike: 'm', nan: 'n', oboe: 'o', peter: 'p', queen: 'q', roger: 'r',
  sugar: 's', tare: 't', uncle: 'u', victor: 'v', william: 'w', xray: 'x', yoke: 'y', zebra: 'z',
};

/** Army abbreviations, spelled out. */
const ABBREV: Record<string, string> = {
  pte: 'private', pvt: 'private', lcpl: 'lance corporal', cpl: 'corporal', mcpl: 'master corporal', sgt: 'sergeant',
  ssgt: 'staff sergeant', wo: 'warrant officer', mwo: 'master warrant officer', cwo: 'chief warrant officer',
  '2lt': 'second lieutenant', lt: 'lieutenant', capt: 'captain', maj: 'major', lcol: 'lieutenant colonel',
  ltcol: 'lieutenant colonel', col: 'colonel', brig: 'brigadier', gen: 'general', coy: 'company', bn: 'battalion',
  regt: 'regiment', hq: 'headquarters', cdr: 'commander', cmdr: 'commander',
};

export function normName(s: string): string {
  const words = s
    .toLowerCase()
    .replace(/x-ray/g, 'xray')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  return words
    .flatMap((w) => (ABBREV[w] ?? w).split(' '))
    .map((w) => PHONETIC[w] ?? w)
    .join(' ');
}

export function matchRanksToRoles(ranks: RankToBind[], roles: RoleCandidate[]): RankMatch[] {
  const used = new Set<string>();
  const out = new Map<number, RankMatch>();
  const byLength = [...ranks].sort((a, b) => normName(b.name).length - normName(a.name).length);
  // exact names
  for (const r of byLength) {
    const role = roles.find((x) => !used.has(x.id) && normName(x.name) === normName(r.name));
    if (role) {
      used.add(role.id);
      out.set(r.rank, { rank: r.rank, rankName: r.name, role, how: 'exact' });
    }
  }
  // a role that contains the rank's words, when only one does
  const rankNames = new Set(ranks.map((r) => normName(r.name)));
  for (const r of byLength) {
    if (out.has(r.rank)) continue;
    const want = ` ${normName(r.name)} `;
    if (!want.trim()) continue;
    const found = roles.filter((x) => !used.has(x.id) && !rankNames.has(normName(x.name)) && ` ${normName(x.name)} `.includes(want));
    if (found.length === 1) {
      used.add(found[0]!.id);
      out.set(r.rank, { rank: r.rank, rankName: r.name, role: found[0], how: 'contains' });
    }
  }
  return ranks.map((r) => out.get(r.rank) ?? { rank: r.rank, rankName: r.name });
}
