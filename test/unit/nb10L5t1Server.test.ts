import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The guild gate covers only the guild paths: with Guild Web-UI disabled, the owner API mounted after the guild
// subscription routes still answers.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager } from '../../src/webui/botManager';
import { createServer } from '../../src/webui/server';
import { isGuildWebUIEnabled } from '../../src/webui/auth/oauthConfig';

let close: (() => Promise<void>) | null = null;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await close?.();
  close = null;
  vi.restoreAllMocks();
});

describe('the guild gate with Guild Web-UI disabled', () => {
  it('answers 503 under /guild/api/subscriptions and lets the owner API after it answer', async () => {
    expect(isGuildWebUIEnabled()).toBe(false);
    const server = http.createServer(await createServer(new BotManager()));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    close = () => new Promise<void>(resolve => server.close(() => resolve()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const gated = await fetch(`${url}/guild/api/subscriptions/123456789012345678`);
    expect(gated.status).toBe(503);
    const status = await fetch(`${url}/api/bot/status`);
    expect(status.status).toBe(200);
    const body = await status.json();
    expect(body.success).toBe(true);
    expect(body.error).toBeUndefined();
  });
});
