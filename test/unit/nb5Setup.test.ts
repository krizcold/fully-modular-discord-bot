import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSetupRoutes } from '../../src/webui/routes/setup';
import { dataPath } from '../../src/utils/dataRoot';
import { startApp } from '../helpers/configRig';

// NB5 section 8 test 13, the setup save (decision 18): every entry of a list is checked, and a valid list is kept.

let app: { url: string; close: () => Promise<void> };
beforeEach(async () => {
  fs.rmSync(dataPath('.env'), { force: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  app = await startApp(a => a.use('/api/setup', createSetupRoutes()));
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

async function save(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.url}/api/setup/credentials`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

describe('decision 18: the standalone setup save', () => {
  it('refuses a list whose entry 2 is not postgres, naming it, and saves nothing', async () => {
    expect(await save({ DATA_BACKEND_URL: 'postgresql://a, mysql://b' })).toEqual({ status: 400, body: { success: false, error: 'entry 2 of DATA_BACKEND_URL must start with postgresql:// or postgres://' } });
    expect(fs.existsSync(dataPath('.env'))).toBe(false);
  });

  it('keeps a valid list', async () => {
    const list = 'postgresql://bot:pw@a.example:5432/bot,postgresql://bot:pw@w.example:5432/bot';
    const res = await save({ DATA_BACKEND_URL: list });
    expect(res.body.success).toBe(true);
    expect(fs.readFileSync(dataPath('.env'), 'utf8')).toContain(`DATA_BACKEND_URL=${list}`);
  });
});
