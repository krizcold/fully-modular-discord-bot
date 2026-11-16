import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'express';

import { createManagedRoutes } from '../../src/webui/routes/managed';
import type { BotManager } from '../../src/webui/botManager';
import { maintenanceFilePath } from '../../src/utils/maintenanceFile';

const failWrite = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/bot/internalSetup/utils/atomicWrite', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/atomicWrite')>();
  return {
    ...real,
    atomicWriteFileSync: (file: string, contents: string) => {
      if (failWrite.on) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return real.atomicWriteFileSync(file, contents);
    },
  };
});

const TOKEN = 'sa15-maintenance-token';
let router: Router;
let errors: string[] = [];
const enter = vi.fn(async () => ({ saved: true }));

function invoke(body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    const req: any = { method: 'POST', url: '/maintenance', headers: { 'x-bot-token': TOKEN }, body };
    const res: any = {
      status(code: number) { status = code; return res; },
      json(answer: unknown) { resolve({ status, body: answer }); return res; },
    };
    (router as any)(req, res, (error?: unknown) => reject(error ?? new Error('no route answered /maintenance')));
  });
}

beforeEach(() => {
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
  failWrite.on = false;
  enter.mockClear();
  router = createManagedRoutes({ enterMaintenance: enter, isServingNormally: () => true } as unknown as BotManager);
  fs.rmSync(maintenanceFilePath(), { force: true });
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});
afterEach(() => {
  failWrite.on = false;
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.restoreAllMocks();
});

describe('sa15: a maintenance state that cannot be saved', () => {
  it('logs the cause under [Maintenance] and answers 500 without asking the bot process', async () => {
    failWrite.on = true;
    const res = await invoke({ state: 'maintenance', message: 'Moving servers.' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'The maintenance state could not be saved: ENOSPC: no space left on device' });
    expect(errors).toEqual(['[Maintenance] The maintenance state could not be saved: ENOSPC: no space left on device']);
    expect(enter).not.toHaveBeenCalled();
    expect(fs.existsSync(maintenanceFilePath())).toBe(false);
  });
});
