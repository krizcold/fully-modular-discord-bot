import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue, useWebuiSessions } from '../../src/bot/internalSetup/utils/sharedStore';
import { _resetSharedMirror, refreshShared } from '../../src/bot/internalSetup/utils/sharedMirror';
import { writeStoreRecord } from '../../src/bot/internalSetup/utils/sharedRecords';
import { setBackendKind } from '../helpers/backendKind';
import { setView } from '../helpers/nb6Mirror';
import { sharedRows } from '../helpers/sharedRows';

// L5 run A, chunk 64: sharedMirror.ts's pass in a process with no data pool of its own: the web UI's (its reader
// sessions over helpers/sharedRows.ts's tables) and one with no connection at all.

let rows: ReturnType<typeof sharedRows>;
let lines: string[];

function webui(): void {
  useWebuiSessions({
    target: async () => ({ entry: 'postgres://bot@db:5432/bot', tag: '1:ALPHA', countAtStart: 0 }),
    commitCheck: () => null,
    select: async (text: string, values: unknown[]) => {
      const res = await rows.answer(text, values, 0, 999);
      if (res instanceof Error) throw res;
      return (res ?? { rows: [] }) as { rows: any[] };
    },
    tag: () => '1:ALPHA',
  } as never);
}

function superseded(): string[] {
  const root = dataPath('_superseded');
  return fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).map(String) : [];
}

beforeEach(() => {
  lines = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  }
  _resetRowQueue();
  _resetSharedMirror();
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.rmSync(dataPath('_superseded'), { recursive: true, force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  setView(1, 'ALPHA');
  dm.setGuildDataBackend(null);
  rows = sharedRows();
});
afterEach(() => {
  useWebuiSessions(null);
  _resetSharedMirror();
  _resetRowQueue();
  setBackendKind(null);
  fs.rmSync(dataPath('global'), { recursive: true, force: true });
  fs.rmSync(dataPath('_superseded'), { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('ra64: a process with no connection to the database', () => {
  it("refreshShared answers that it has none, and writes nothing", async () => {
    useWebuiSessions(null);
    rows.put('global/ra64/n.json', '{"n":1}');
    expect(await refreshShared(['global/ra64/n.json'])).toEqual({ ok: false, cause: "this process has no connection to the bot's database" });
    expect(fs.existsSync(dataPath('global', 'ra64', 'n.json'))).toBe(false);
  });
});

describe("ra64: the web UI's pass", () => {
  beforeEach(() => webui());

  it('brings a doc key up to its row', async () => {
    rows.put('global/ra64/d.json', '{"d":1}');
    expect(await refreshShared(['global/ra64/d.json'])).toEqual({ ok: true });
    expect(fs.readFileSync(dataPath('global', 'ra64', 'd.json'), 'utf8')).toBe('{"d":1}');
  });

  it('leaves an App Store key to the store docs pass', async () => {
    rows.put('global/appstore/w.json', '{"w":1}');
    expect(await refreshShared(['global/appstore/w.json'])).toEqual({ ok: true });
    expect(fs.existsSync(dataPath('global', 'appstore', 'w.json'))).toBe(false);
  });

  it("does not take keys from the store record: a machine-local file named there is left alone", async () => {
    const local = dataPath('global', 'fleet', 'w.json');
    writeStoreRecord({ docs: { 'global/fleet/w.json': { sha: 'f'.repeat(64), stamp: null, main: null } }, modules: {} });
    fs.mkdirSync(dataPath('global', 'fleet'), { recursive: true });
    fs.writeFileSync(local, '{"mine":1}');
    expect(await refreshShared(null)).toEqual({ ok: true });
    expect(fs.readFileSync(local, 'utf8')).toBe('{"mine":1}');
    expect(superseded()).toEqual([]);
    expect(lines.filter(l => l.startsWith('[Shared] Moved'))).toEqual([]);
  });
});
