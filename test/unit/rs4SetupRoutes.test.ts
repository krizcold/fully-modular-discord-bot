import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSetupRoutes } from '../../src/webui/routes/setup';
import { dataPath } from '../../src/utils/dataRoot';
import { getDeploymentMode } from '../../src/utils/envLoader';
import { startApp } from '../helpers/configRig';

const KEPT_URL = 'postgresql://bot@a.example:5432/bot';

let app: { url: string; close: () => Promise<void> } | null = null;

beforeEach(() => {
  fs.rmSync(dataPath('.env'), { force: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  await app?.close();
  app = null;
  vi.restoreAllMocks();
});

async function save(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app!.url}/api/setup/credentials`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

describe('the standalone setup save', () => {
  it('a blank database address keeps the stored one and saves', async () => {
    expect(getDeploymentMode()).toBe('standalone');
    fs.writeFileSync(dataPath('.env'), `DATA_BACKEND_URL=${KEPT_URL}\n`);
    app = await startApp(a => a.use('/api/setup', createSetupRoutes()));
    const res = await save({ DATA_BACKEND_URL: '   ', MAIN_GUILD_ID: '123456789012345678' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const stored = fs.readFileSync(dataPath('.env'), 'utf8');
    expect(stored).toContain(`DATA_BACKEND_URL=${KEPT_URL}`);
    expect(stored).toContain('MAIN_GUILD_ID=123456789012345678');
  });

  it('a host without a guild web UI sender answers the save it made as saved', async () => {
    const host = { migrationRunning: () => null, ownerChannelWriteStart: () => undefined } as any;
    app = await startApp(a => a.use('/api/setup', createSetupRoutes(host)));
    const res = await save({ MAIN_GUILD_ID: '123456789012345678' });
    expect(res).toMatchObject({ status: 200, body: { success: true, message: 'Settings saved successfully' } });
    expect(fs.readFileSync(dataPath('.env'), 'utf8')).toContain('MAIN_GUILD_ID=123456789012345678');
  });
});

describe('GET /deployment-mode', () => {
  it('answers the deployment mode', async () => {
    app = await startApp(a => a.use('/api/setup', createSetupRoutes()));
    const res = await fetch(`${app.url}/api/setup/deployment-mode`, { signal: AbortSignal.timeout(1000) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, mode: getDeploymentMode() });
  });
});
