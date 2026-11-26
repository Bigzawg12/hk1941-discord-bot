import { randomInt } from 'node:crypto';
import type { RobloxUser, UsersClient } from '../roblox/users.js';
import { TtlCache } from '../util/cache.js';
import { UserFacingError } from '../util/errors.js';
import type { ExternalLinkProvider } from './providers.js';
import type { AccountLink, LinkStore } from './store.js';

/**
 * Discord <-> Roblox account linking.
 *
 * Default flow ("blurb"): /link start <username> gives the member a short phrase; they paste it into
 * their Roblox profile's About section; /link verify reads the About text through the public users API
 * and saves the link. Only someone who can edit that Roblox profile can pass, and no password or
 * OAuth is involved.
 *
 * With LINK_PROVIDER=bloxlink or rover, /link verify asks that service instead.
 */

/** Plain words: Roblox's filter tends to hide long numbers in profile text, so the code avoids digits. */
const WORDS = [
  'anchor', 'badger', 'bamboo', 'banner', 'beacon', 'bugle', 'canteen', 'cedar', 'compass', 'convoy',
  'copper', 'cypress', 'dragon', 'falcon', 'ferry', 'flint', 'garrison', 'harbour', 'hawk', 'heron',
  'island', 'jade', 'junk', 'kestrel', 'kowloon', 'lantern', 'maple', 'marsh', 'meadow', 'mortar',
  'orchard', 'osprey', 'otter', 'paddy', 'pagoda', 'peak', 'pebble', 'pelican', 'pine', 'quarry',
  'rampart', 'raven', 'ridge', 'river', 'rocket', 'saddle', 'sampan', 'signal', 'spruce', 'stallion',
  'summit', 'tanker', 'thistle', 'timber', 'tower', 'tramway', 'valley', 'victoria', 'walrus', 'willow',
  'wolf', 'yew', 'zephyr', 'kettle',
];

export function makeCode(rand: (max: number) => number = randomInt): string {
  const pick = () => WORDS[rand(WORDS.length)]!;
  return `hk1941 ${pick()} ${pick()} ${pick()} ${pick()}`;
}

const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function blurbHasCode(description: string, code: string): boolean {
  return normalise(description).includes(normalise(code));
}

interface Pending {
  robloxId: number;
  robloxName: string;
  code: string;
}

/** What the game wrote for a /verify code typed in game chat (DiscordBridge, sorted map VERIFY_MAP). */
export interface GameCode {
  u?: number;
  n?: string;
  d?: string;
  t?: number;
}

/** "qztr kmpl" / "QZTR-KMPL" -> "QZTRKMPL"; null if it can't be a code. */
export function normaliseGameCode(text: string): string | null {
  const c = text.toUpperCase().replace(/[^A-Z]/g, '');
  return /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(c) ? c : null;
}

/** Wrong codes allowed per member before a pause (guessing protection). */
export const GAME_CODE_TRIES = 5;

export interface LinkServiceDeps {
  store: LinkStore;
  users: UsersClient;
  provider?: ExternalLinkProvider;
  codeTtlMinutes: number;
  now?: () => number;
  makeCode?: () => string;
  /** reads a code written by the game; undefined = verifying in game is off */
  gameCodes?: (code: string) => Promise<GameCode | null>;
}

export class LinkService {
  private readonly pending: TtlCache<string, Pending>;
  private readonly now: () => number;
  /** discordId -> wrong game codes in the last 10 minutes */
  private readonly tries: TtlCache<string, number>;
  /** game codes already used (the bot can't delete them from MemoryStore) */
  private readonly usedCodes: TtlCache<string, true>;

  constructor(private readonly deps: LinkServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.pending = new TtlCache(deps.codeTtlMinutes * 60_000, 5000, this.now);
    this.tries = new TtlCache(10 * 60_000, 5000, this.now);
    this.usedCodes = new TtlCache(15 * 60_000, 20_000, this.now);
  }

  /** The game shows codes for /verify typed in game chat. */
  get gameLinking(): boolean {
    return !!this.deps.gameCodes;
  }

  /** Link with a code the player got from typing /verify in the game. */
  async verifyGameCode(discordId: string, typed: string): Promise<AccountLink> {
    if (!this.deps.gameCodes) throw new UserFacingError('Verifying in game is turned off here.');
    const used = this.tries.get(discordId) ?? 0;
    if (used >= GAME_CODE_TRIES) throw new UserFacingError('Too many wrong codes. Wait 10 minutes, then type /verify in game for a new one.');
    const code = normaliseGameCode(typed);
    const wrong = (msg: string) => {
      this.tries.set(discordId, used + 1);
      return new UserFacingError(msg);
    };
    if (!code) throw wrong('Codes are 8 letters, like QZTR KMPL. Type /verify in the game chat to get yours.');
    if (this.usedCodes.get(code)) throw wrong('That code was already used. Type /verify in game for a new one.');
    const entry = await this.deps.gameCodes(code);
    const robloxId = Number(entry?.u);
    if (!entry || !Number.isSafeInteger(robloxId) || robloxId <= 0) {
      throw wrong("That code isn't right, or it has expired (codes last 10 minutes). Type /verify in game for a new one.");
    }
    this.usedCodes.set(code, true);
    this.tries.delete(discordId);
    let name = typeof entry.n === 'string' && entry.n ? entry.n : '';
    if (!name) name = (await this.deps.users.getById(robloxId))?.name ?? String(robloxId);
    return this.linkVerified(discordId, { id: robloxId, name }, 'game');
  }

  get mode(): 'blurb' | 'bloxlink' | 'rover' {
    return this.deps.provider?.kind ?? 'blurb';
  }

  get(discordId: string): Promise<AccountLink | null> {
    return this.deps.store.get(discordId);
  }

  all(): Promise<AccountLink[]> {
    return this.deps.store.all();
  }

  findByRoblox(robloxId: number): Promise<AccountLink | null> {
    return this.deps.store.findByRoblox(robloxId);
  }

  /** Step 1 (blurb mode): remember the requested account and hand out a code. */
  async start(discordId: string, user: RobloxUser): Promise<{ code: string; expiresInMin: number }> {
    if (this.mode !== 'blurb') throw new UserFacingError(`Linking here goes through ${this.mode === 'bloxlink' ? 'Bloxlink' : 'RoVer'}: verify there, then run /link verify.`);
    const code = (this.deps.makeCode ?? makeCode)();
    this.pending.set(discordId, { robloxId: user.id, robloxName: user.name, code });
    return { code, expiresInMin: this.deps.codeTtlMinutes };
  }

  /** Step 2: check the code (or ask the provider) and save the link. */
  async verify(discordId: string, guildId: string | null): Promise<AccountLink> {
    let robloxId: number;
    let robloxName: string;
    if (this.deps.provider) {
      if (!guildId) throw new UserFacingError('Run this in the server, not in DMs.');
      const id = await this.deps.provider.lookup(discordId, guildId);
      if (!id) throw new UserFacingError(`You aren't verified with ${this.mode === 'bloxlink' ? 'Bloxlink' : 'RoVer'} yet. Verify there first.`);
      const user = await this.deps.users.getById(id);
      if (!user) throw new UserFacingError('That Roblox account no longer exists.');
      robloxId = user.id;
      robloxName = user.name;
    } else {
      const p = this.pending.get(discordId);
      if (!p) throw new UserFacingError('No link in progress (codes last ' + this.deps.codeTtlMinutes + ' minutes). Start again with /link start.');
      const user = await this.deps.users.getById(p.robloxId, { fresh: true });
      if (!user) throw new UserFacingError('That Roblox account no longer exists.');
      if (!blurbHasCode(user.description ?? '', p.code)) {
        throw new UserFacingError(
          `I can't see the code in ${user.name}'s About section yet. Make sure it's saved exactly as given (Roblox can take a minute to update), then try again.`,
        );
      }
      this.pending.delete(discordId);
      robloxId = user.id;
      robloxName = user.name;
    }
    const link: AccountLink = { discordId, robloxId, robloxName, method: this.mode, linkedAt: Math.floor(this.now() / 1000) };
    await this.deps.store.set(link);
    return link;
  }

  /** Save a link already proven another way (Roblox sign-in on the website). */
  async linkVerified(discordId: string, user: { id: number; name: string }, method: AccountLink['method']): Promise<AccountLink> {
    const link: AccountLink = { discordId, robloxId: user.id, robloxName: user.name, method, linkedAt: Math.floor(this.now() / 1000) };
    this.pending.delete(discordId);
    await this.deps.store.set(link);
    return link;
  }

  /** The profile-code check is available (no third-party provider configured). */
  get codeLinking(): boolean {
    return !this.deps.provider;
  }

  unlink(discordId: string): Promise<boolean> {
    return this.deps.store.remove(discordId);
  }
}
