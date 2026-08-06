/**
 * Access-log dispatcher (web-UI parent side). Decouples the request/OAuth hooks
 * from the BotManager: server.ts wires the dispatcher to botManager.postAccessLog,
 * and the hooks (GET '/', OAuth callback) just call fireAccessLog. No-op until wired
 * and inert unless the bot's security.accessLog setting is enabled.
 */

export interface AccessLogInfo {
  uiKind: 'admin' | 'guild';
  ip: string;
  userAgent: string;
  when: number;
  user?: { id: string; username?: string };
}

let dispatcher: ((info: AccessLogInfo) => void) | null = null;

export function setAccessLogDispatcher(fn: (info: AccessLogInfo) => void): void {
  dispatcher = fn;
}

export function fireAccessLog(info: AccessLogInfo): void {
  try {
    dispatcher?.(info);
  } catch {
    /* access logging must never affect serving */
  }
}
