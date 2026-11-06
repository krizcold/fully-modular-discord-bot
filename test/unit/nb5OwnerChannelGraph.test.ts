import { describe, expect, it, vi } from 'vitest';

// NB5 section 8 test 17, row change 10 (C's rulings): the bot process loads nothing of the owner channel setting.
// src/webui/utils/ownerChannel.ts is mocked to throw when loaded; bot/index.ts and the real clientInitializer.ts load
// without the throw. The boot decides maintenance and the maintenance boot is a stand-in, so main() stops there.

const ctl = vi.hoisted(() => ({ ownerChannelLoads: 0, maintenanceBoots: 0, exits: [] as unknown[] }));
vi.mock('../../src/webui/utils/ownerChannel', () => {
  ctl.ownerChannelLoads++;
  throw new Error('the owner channel module was loaded');
});
vi.mock('dotenv/config', () => ({}));
vi.mock('tsconfig-paths', () => ({ register: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => ({
  ...(await orig<any>()),
  configureWriterLock: () => undefined,
  takeWriterLockForBoot: async () => undefined,
  onDeposed: () => undefined,
  releaseWriterLockAtExit: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  installStopHandler: () => undefined,
  beginStop: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/maintenance', async orig => ({
  ...(await orig<any>()),
  decideBoot: async () => ({ mode: 'maintenance', cause: 'operator' }),
  runMaintenanceBoot: async () => { ctl.maintenanceBoots++; },
}));

describe('the bot process and the owner channel setting', () => {
  it('the mock bites: the setup routes, which use the setting, fail to load', async () => {
    await expect(import('../../src/webui/routes/setup')).rejects.toThrow();
  });

  it('bot/index.ts and clientInitializer.ts load with the setting module throwing when loaded', async () => {
    const loadsBefore = ctl.ownerChannelLoads;
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { ctl.exits.push(code); }) as any);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await import('../../src/bot/index');
      await vi.waitFor(() => expect(ctl.maintenanceBoots).toBe(1), { timeout: 10_000 });
      await import('../../src/bot/internalSetup/clientInitializer');
      expect(ctl.ownerChannelLoads).toBe(loadsBefore);
      expect(ctl.exits).toEqual([]);
      expect(errors.mock.calls.filter(c => String(c[0]).includes('[Main]'))).toEqual([]);
    } finally {
      exit.mockRestore();
      errors.mockRestore();
    }
  });
});
