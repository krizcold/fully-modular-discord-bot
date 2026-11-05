import path from 'path';
import { describe, expect, it } from 'vitest';
import { readServedGuild } from '../../src/webui/utils/servedRead';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

// NB12 (wip-redesign/sheets/NB12.md): a guild read the bot answered with no reply at all is an error, never a throw
// and never content.

describe('a guild read with no reply from the bot', () => {
  for (const kind of ['file', 'postgres'] as const) {
    it(`answers 500 on the ${kind} route`, async () => {
      setBackendKind(kind);
      const botManager = { readGuildData: async () => undefined } as any;
      const target = { guildId: '9414600001', module: 'm', filename: 'x.json', path: path.join(dataPath('9414600001'), 'm', 'x.json') };
      expect(await readServedGuild(botManager, target)).toEqual({ ok: false, status: 500, error: 'Guild data operation failed' });
    });
  }
});
