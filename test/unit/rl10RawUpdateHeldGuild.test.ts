import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A development checkout under DATA_DIR/<all-digits folder>/ puts the root config, a shared key, inside a guild folder.
const h = vi.hoisted(() => ({ root: null as string | null }));

vi.mock('../../src/bot/internalSetup/utils/sharedStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/bot/internalSetup/utils/sharedStore')>();
  const nodePath = await import('path');
  return {
    ...actual,
    sharedKeyOf: (absPath: string) =>
      h.root !== null && nodePath.resolve(absPath) === h.root ? actual.ROOT_CONFIG_KEY : actual.sharedKeyOf(absPath),
  };
});

import { dataPath } from '../../src/utils/dataRoot';
import {
  deleteGuildNamespace,
  reopenSharedWrites,
  setGuildDataBackend,
  setGuildWriteGate,
  updateRawTracked,
} from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, ROOT_CONFIG_KEY, rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';

let n = 0;
let warns: string[];

beforeEach(() => {
  _resetRowQueue();
  setGuildDataBackend(null);
  reopenSharedWrites();
  setGuildWriteGate(null);
  setBackendKind('file');
  warns = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  h.root = null;
  setBackendKind(null);
  setGuildDataBackend(null);
  _resetRowQueue();
});

describe('rl10 a raw update of the root config inside a guild folder a retirement holds', () => {
  it('rl10 answers not-ready, logs the refusal and queues nothing', async () => {
    const guildId = `98710${String(process.pid).padStart(7, '0')}${n++}`;
    const config = path.resolve(dataPath(guildId, 'checkout', 'src', 'bot', 'config.json'));
    fs.mkdirSync(path.dirname(config), { recursive: true });
    h.root = config;
    const retire = deleteGuildNamespace(guildId, 'rl10');
    let answer: unknown;
    setBackendKind('postgres');
    try {
      answer = updateRawTracked(config, {}, v => ({ ...v, added: true }));
    } finally {
      setBackendKind('file');
    }
    await retire;
    expect(answer).toEqual({ accepted: false, cause: 'not-ready' });
    expect(warns).toContain(`[Data] Write of ${config} refused: its guild's data is being deleted`);
    expect(rowQueue.ops(ROOT_CONFIG_KEY)).toHaveLength(0);
  });
});
