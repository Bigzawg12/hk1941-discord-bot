/** An error whose message is safe and useful to show to the Discord user as-is. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

/** A failed call to a Roblox web or Open Cloud API. Never carries the API key. */
export class RobloxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'RobloxApiError';
  }

  /** Short text for staff: what failed, without internals. */
  describe(): string {
    if (this.status === 401 || this.status === 403) {
      return 'Roblox refused the request (check the Open Cloud key, its scopes and its IP allow-list).';
    }
    if (this.status === 429) return 'Roblox is rate limiting the bot. Try again in a minute.';
    if (this.status >= 500) return 'Roblox had a server error. Try again shortly.';
    return `Roblox API error (${this.status}).`;
  }
}

/** Raised by loadConfig with every problem found, so all of them can be fixed in one go. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
