export interface HopFailure {
  status: number;
  error: string;
}

/**
 * HTTP status and operator text for a guild data request the bot refused.
 * Returns null for codes the caller words itself (invalid, unknown).
 */
export function hopFailure(code: unknown, detail?: string): HopFailure | null {
  switch (code) {
    case 'frozen':
      return { status: 503, error: "This guild's shard is not served by this bot process right now, so nothing was changed; retry in a moment" };
    case 'not-owner':
      return { status: 503, error: detail ? `Another bot process took over this guild's data, so the change was not saved (${detail})` : "Another bot process took over this guild's data, so the change was not saved" };
    case 'backend-unavailable':
      return { status: 503, error: detail || 'the database backend is unavailable' };
    case 'bot-down':
      return { status: 503, error: 'the bot process is not running' };
    case 'maintenance':
      return { status: 503, error: detail || 'the bot is in maintenance, so nothing was changed' };
    default:
      return null;
  }
}
