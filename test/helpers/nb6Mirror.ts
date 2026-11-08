import fs from 'fs';
import path from 'path';
import { expect, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { setMainChooser, type MainChooser } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { _resetRowQueue, rowTicketState, type RowTicket } from '../../src/bot/internalSetup/utils/sharedStore';
import { readDocRecord, type DocEntry } from '../../src/bot/internalSetup/utils/sharedRecords';
import { _resetSharedMirror } from '../../src/bot/internalSetup/utils/sharedMirror';
import { setBackendKind } from './backendKind';
import { scriptedBackend } from './scriptedPg';
import { sharedRows } from './sharedRows';

// The mirror pass's rig (NB6 part 8): a Postgres bot whose data pool is the real PostgresBackend over scripted clients
// answering as the shared tables do (sharedRows.ts), a temp /data, and NB5's chooser view for the main tag. Mirrors,
// rows and records start from the real writers: the facade's save through the real flush, another machine's row
// stored with rows.put, and the real pass.

export interface MirrorRig {
  rows: ReturnType<typeof sharedRows>;
  pg: ReturnType<typeof scriptedBackend>;
  lines: string[];
}

export function mirrorRig(category: string) {
  const state = {} as MirrorRig;
  const file = (name: string) => dataPath('global', category, name);
  const keyOf = (name: string) => `global/${category}/${name}`;
  const opts: dm.DataOptions = { scope: 'global', category };

  return {
    state,
    file,
    keyOf,
    opts,
    async setup(): Promise<void> {
      state.lines = [];
      for (const level of ['log', 'warn', 'error'] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { state.lines.push(args.map(String).join(' ')); });
      }
      _resetRowQueue();
      _resetSharedMirror();
      setMainChooser(null);
      fs.rmSync(dataPath('global'), { recursive: true, force: true });
      fs.rmSync(dataPath('_superseded'), { recursive: true, force: true });
      fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
      setBackendKind('postgres');
      state.rows = sharedRows();
      state.pg = scriptedBackend(state.rows.answer);
      dm.setGuildDataBackend(state.pg.backend);
    },
    async teardown(): Promise<void> {
      _resetSharedMirror();
      dm.setGuildDataBackend(null);
      _resetRowQueue();
      setMainChooser(null);
      await state.pg.backend.stop();
      vi.useRealTimers();
      vi.restoreAllMocks();
    },
    /** A first version stored and mirrored by the real flush. */
    async landed(name: string, value: unknown): Promise<RowTicket> {
      const res = dm.saveDataTracked(name, opts, value) as { ticket?: RowTicket };
      await dm.flushAll();
      expect(rowTicketState(res.ticket!)).toBe('landed');
      state.pg.sent.length = 0;
      state.rows.notices.length = 0;
      return res.ticket!;
    },
    entry(name: string): DocEntry | undefined {
      const record = readDocRecord();
      if (!record.ok) throw new Error(record.reason);
      return record.record.docs[keyOf(name)];
    },
    read(name: string): string | null {
      try {
        return fs.readFileSync(file(name), 'utf8');
      } catch {
        return null;
      }
    },
    /** Every file moved aside so far, by its path below _superseded, with its bytes. */
    superseded(): Record<string, string> {
      const out: Record<string, string> = {};
      const root = dataPath('_superseded');
      const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(abs);
          else out[path.relative(root, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8');
        }
      };
      walk(root);
      return out;
    },
    /** The SQL the pass sent, in order. */
    sql(): string[] {
      return state.pg.sent.map(s => s.sql);
    },
  };
}

/** NB5's chooser view at a main generation and machine, as the watch reports it. */
export function setView(generation: number, machine: string | null): void {
  const view = { chosen: 'postgres://nobody@127.0.0.1:9/none', generation, machine, state: 'main', reason: null, addresses: [] };
  setMainChooser({ view: () => view, stop: () => undefined } as unknown as MainChooser);
}

export const text = (value: unknown) => JSON.stringify(value, null, 2);

/** T11's heads and tails (decision 56, round 2). */
export const T11 = {
  a: (from: string, to: string) => `[Shared] Moved ${from} to ${to}: it differed from the version this machine last took from the database (changed outside the bot, or left by a crash); `,
  b: (from: string, to: string, machine: string, g: number) => `[Shared] Moved ${from} to ${to}: it held the version this machine took from the database before the switch to ${machine} (generation ${g}); `,
  written: "the database's version is back in its place",
  noRow: 'the database holds no such file, so nothing was put back',
  writeFailed: (errno: string) => `the database's version could not be written (${errno}); the next pass tries again`,
  tagChanged: 'the main database changed during this pass, so the next pass puts its version in place',
};
