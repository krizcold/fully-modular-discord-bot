import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { readServedGlobal, readServedGuild } from '../../src/webui/utils/servedRead';

// A read the bot answered with no reply at all is refused with the read's own failure text, never thrown.

const target = path.join(os.tmpdir(), 'nb10L5s13Served-none', 'settings.json');

describe('a served read with no reply', () => {
  it('a global read answers 500 Data read failed', async () => {
    const manager = { isRunning: () => true, readGlobalData: async () => undefined } as any;
    expect(await readServedGlobal(manager, { rel: 'settings.json', path: target })).toEqual({ ok: false, status: 500, error: 'Data read failed' });
  });

  it('a guild read answers 500 Guild data operation failed', async () => {
    const manager = { isRunning: () => true, readGuildData: async () => undefined } as any;
    expect(await readServedGuild(manager, { guildId: '123456789012345678', module: 'm', filename: 'f.json', path: target }))
      .toEqual({ ok: false, status: 500, error: 'Guild data operation failed' });
  });
});
