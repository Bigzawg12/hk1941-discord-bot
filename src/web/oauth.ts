import { randomBytes } from 'node:crypto';
import type { FetchLike } from '../roblox/http.js';
import type { WebUser } from './session.js';

/**
 * Discord sign-in for the dashboard (OAuth2, "identify" scope only): it tells the bot who you are,
 * and the dashboard then checks you're on the admin list. No password, and the token isn't kept.
 */

const DISCORD_API = 'https://discord.com/api/v10';

export class OAuthError extends Error {}

export function randomState(): string {
  return randomBytes(18).toString('base64url');
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new OAuthError(`${what} failed (HTTP ${res.status})`);
  return (await res.json()) as T;
}

export class DiscordOAuth {
  constructor(private readonly opts: { clientId: string; clientSecret: string; redirectUri: string; fetch: FetchLike }) {}

  authorizeUrl(state: string): string {
    const q = new URLSearchParams({
      client_id: this.opts.clientId,
      response_type: 'code',
      redirect_uri: this.opts.redirectUri,
      scope: 'identify',
      state,
      prompt: 'none',
    });
    return `https://discord.com/oauth2/authorize?${q}`;
  }

  async finish(code: string): Promise<WebUser> {
    const tokenRes = await this.opts.fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.opts.redirectUri,
      }).toString(),
    });
    const token = await readJson<{ access_token?: string }>(tokenRes, 'Discord sign-in');
    if (!token.access_token) throw new OAuthError('Discord sign-in returned no token');
    const me = await readJson<{ id: string; username: string; global_name?: string | null; avatar?: string | null }>(
      await this.opts.fetch(`${DISCORD_API}/users/@me`, { headers: { authorization: `Bearer ${token.access_token}` } }),
      'Reading your Discord account',
    );
    return { id: me.id, username: me.username, globalName: me.global_name, avatar: me.avatar };
  }
}

export function discordAvatar(u: WebUser): string {
  if (u.avatar) return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`;
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`;
}
