import type { RobloxHttp } from '../roblox/http.js';
import { RobloxApiError } from '../util/errors.js';

/**
 * An outside verification service that already knows who is who (Bloxlink, RoVer).
 * Used instead of the profile-blurb code when LINK_PROVIDER is set to one of them.
 */
export interface ExternalLinkProvider {
  readonly kind: 'bloxlink' | 'rover';
  /** The Roblox user ID verified for this Discord member, or null if they haven't verified there. */
  lookup(discordId: string, guildId: string): Promise<number | null>;
}

/**
 * Bloxlink API v4 (server key from the Bloxlink dashboard).
 * TODO: confirm against https://blox.link/dashboard (API docs) before going live; Bloxlink has changed paths before.
 */
export class BloxlinkProvider implements ExternalLinkProvider {
  readonly kind = 'bloxlink' as const;

  constructor(
    private readonly http: RobloxHttp,
    private readonly apiKey: string,
  ) {}

  async lookup(discordId: string, guildId: string): Promise<number | null> {
    try {
      const res = await this.http.get<{ robloxID?: string | number }>(
        `https://api.blox.link/v4/public/guilds/${guildId}/discord-to-roblox/${discordId}`,
        { headers: { Authorization: this.apiKey }, allowNotFound: true },
      );
      const id = Number(res?.data?.robloxID);
      return Number.isFinite(id) && id > 0 ? id : null;
    } catch (err) {
      if (err instanceof RobloxApiError && err.status === 400) return null; // "user not verified"
      throw err;
    }
  }
}

/**
 * RoVer API (key from the RoVer dashboard).
 * TODO: confirm against https://rover.link/docs before going live.
 */
export class RoVerProvider implements ExternalLinkProvider {
  readonly kind = 'rover' as const;

  constructor(
    private readonly http: RobloxHttp,
    private readonly apiKey: string,
  ) {}

  async lookup(discordId: string, guildId: string): Promise<number | null> {
    const res = await this.http.get<{ robloxId?: number }>(
      `https://registry.rover.link/api/guilds/${guildId}/discord-to-roblox/${discordId}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` }, allowNotFound: true },
    );
    const id = Number(res?.data?.robloxId);
    return Number.isFinite(id) && id > 0 ? id : null;
  }
}
