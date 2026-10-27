export interface HopFailure {
  status: number;
  error: string;
}

/**
 * HTTP status and operator text for a refused or unanswered guild data hop.
 * Returns null for codes the caller words itself (invalid, unknown).
 */
export function hopFailure(code: unknown, detail?: string): HopFailure | null {
  switch (code) {
    case 'frozen':
      return { status: 503, error: 'Guild data is frozen for a shard migration; retry after it completes' };
    case 'shard-unassigned':
      return { status: 503, error: "No instance serves this guild's shard, so nothing was changed. Assign the shard on the Fleet tab, or retry after the reshard finishes" };
    case 'owner-disconnected':
      return { status: 503, error: 'The instance that serves this guild is not connected, so nothing was changed. Reconnect it, or move its shards to another instance or declare it lost on the Fleet tab' };
    case 'owner-no-answer':
      return { status: 504, error: `The instance that serves this guild did not answer within 10 s; a change may have been applied there. Reload to check before retrying${detail ? ` (${detail})` : ''}` };
    case 'owner-unreachable':
      return { status: 503, error: detail ? `The instance that serves this guild refused the request: ${detail}` : 'The instance that serves this guild refused the request' };
    case 'not-owner':
      return { status: 503, error: detail ? `This node does not serve this guild, so nothing was changed (${detail})` : 'This node does not serve this guild, so nothing was changed' };
    case 'stale-term':
      return { status: 503, error: 'guild temporarily unavailable' };
    case 'backend-unavailable':
      return { status: 503, error: detail || 'the database backend is unavailable' };
    case 'bot-down':
      return { status: 503, error: 'the bot process is not running' };
    default:
      return null;
  }
}
