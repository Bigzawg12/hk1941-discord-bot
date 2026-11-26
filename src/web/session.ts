import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** A signed-in Discord user, from Discord's OAuth "identify" scope. */
export interface WebUser {
  id: string;
  username: string;
  globalName?: string | null;
  avatar?: string | null;
}

export interface Session {
  id: string;
  /** sent back in every form, so other sites can't post forms as you */
  csrf: string;
  createdAt: number;
  seenAt: number;
  user?: WebUser;
  /** the Discord sign-in in progress */
  oauth?: { state: string; next?: string };
  /** one-off message for the next page */
  flash?: { kind: 'ok' | 'bad'; text: string };
}

const COOKIE = 'hk1941_session';
const MAX_AGE_SEC = 7 * 86400;
const IDLE_MS = 2 * 86400_000;

/**
 * Sessions live in memory (a restart signs everyone out, which is fine for a staff dashboard).
 * The cookie holds only a random ID plus an HMAC, so it can't be guessed or forged.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly secret: string,
    private readonly secure: boolean,
    private readonly now: () => number = Date.now,
  ) {}

  private sign(id: string): string {
    return createHmac('sha256', this.secret).update(id).digest('base64url');
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, s] of this.sessions) if (now - s.seenAt > IDLE_MS || now - s.createdAt > MAX_AGE_SEC * 1000) this.sessions.delete(id);
  }

  /** The session named by the request's cookie, or a new one (with the cookie to set). */
  fromCookie(header: string | undefined): { session: Session; setCookie?: string } {
    const raw = parseCookies(header)[COOKIE];
    if (raw) {
      const dot = raw.lastIndexOf('.');
      const id = raw.slice(0, dot);
      const sig = raw.slice(dot + 1);
      const want = this.sign(id);
      if (dot > 0 && sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want))) {
        const s = this.sessions.get(id);
        if (s && this.now() - s.seenAt <= IDLE_MS) {
          s.seenAt = this.now();
          return { session: s };
        }
      }
    }
    return this.create();
  }

  create(): { session: Session; setCookie: string } {
    if (this.sessions.size > 5000) this.sweep();
    const id = randomBytes(24).toString('base64url');
    const session: Session = { id, csrf: randomBytes(18).toString('base64url'), createdAt: this.now(), seenAt: this.now() };
    this.sessions.set(id, session);
    return { session, setCookie: this.cookie(`${id}.${this.sign(id)}`, MAX_AGE_SEC) };
  }

  /** New ID after signing in (stops session fixation); keeps nothing but what's passed. */
  renew(old: Session, keep: Partial<Session>): { session: Session; setCookie: string } {
    this.sessions.delete(old.id);
    const fresh = this.create();
    Object.assign(fresh.session, keep);
    return fresh;
  }

  destroy(s: Session): string {
    this.sessions.delete(s.id);
    return this.cookie('', 0);
  }

  private cookie(value: string, maxAge: number): string {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function sameToken(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
