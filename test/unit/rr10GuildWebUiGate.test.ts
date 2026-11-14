import { beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ enabled: true, configured: true }));

vi.mock('@webui/auth/oauthConfig', () => ({
  isGuildWebUIEnabled: () => flags.enabled,
  isOAuthConfigured: () => flags.configured,
}));

import { requireGuildWebUIEnabled } from '@webui/auth/oauthMiddleware';

function run(): { status?: number; body?: any; nextCalled: boolean } {
  const out: { status?: number; body?: any; nextCalled: boolean } = { nextCalled: false };
  const res: any = {
    status(code: number) { out.status = code; return res; },
    json(body: any) { out.body = body; return res; },
  };
  requireGuildWebUIEnabled({} as any, res, () => { out.nextCalled = true; });
  return out;
}

beforeEach(() => {
  flags.enabled = true;
  flags.configured = true;
});

describe('requireGuildWebUIEnabled answers the client with the code its guild API checks', () => {
  it('a disabled Guild Web-UI answers 503 with code guild-webui-disabled', () => {
    flags.enabled = false;
    const out = run();
    expect(out.nextCalled).toBe(false);
    expect(out.status).toBe(503);
    expect(out.body).toEqual({
      success: false,
      code: 'guild-webui-disabled',
      error: 'Guild Web-UI is currently disabled. Configure credentials in the Main Web-UI to enable it.',
    });
  });

  it('enabled but with incomplete OAuth credentials answers 503 with the code and the missing settings', () => {
    flags.configured = false;
    const out = run();
    expect(out.nextCalled).toBe(false);
    expect(out.status).toBe(503);
    expect(out.body).toEqual({
      success: false,
      code: 'guild-webui-disabled',
      error: 'Guild Web-UI is enabled but OAuth credentials are incomplete. Check DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and OAUTH_CALLBACK_URL.',
    });
  });

  it('enabled and configured passes the request on without answering', () => {
    const out = run();
    expect(out.nextCalled).toBe(true);
    expect(out.status).toBeUndefined();
    expect(out.body).toBeUndefined();
  });
});
