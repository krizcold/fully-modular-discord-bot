import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clock = vi.hoisted(() => ({ queue: [] as bigint[] }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/postgresBackend', async importOriginal => {
  const real = await importOriginal<any>();
  return { ...real, monoNow: () => clock.queue.shift() ?? real.monoNow() };
});

import { listGraveyardEntries } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { flushAll, saveData } from '../../src/bot/internalSetup/utils/dataManager';
import { applyOperatorDataWrite, operationDeadline, type GuildDataWriteRequest } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

// NB11 survivors, chunk 7 (wip-redesign/sheets/NB11.md): the restore and delete route's body, deadline and answer on a
// JSON bot.

const OUT_OF_TIME = 'the restore ran out of its 40 s before it could commit; nothing was restored; try again in a moment';
const WHOLE_MS = 'retiredAt must be a whole number of milliseconds';

let guilds = 870_000_000_000_000_000n;
const freshGuild = () => String(++guilds);
const entryDir = (g: string, ms: number) => dataPath('_graveyard', `${g}-${ms}`);

function bury(g: string, ms: number): void {
  const dir = entryDir(g, ms);
  fs.mkdirSync(path.join(dir, 'm'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'm', 'a.json'), '{"n":5}');
  fs.writeFileSync(path.join(dir, '.graveyard.json'), JSON.stringify({ guildId: g, reason: 'webui-operator-delete', ts: ms }, null, 2));
}

const listed = async (g: string) => (await listGraveyardEntries()).filter(e => e.guildId === g);
const restoreReq = (g: string, extra: Partial<GuildDataWriteRequest> = {}): GuildDataWriteRequest =>
  ({ guildId: g, module: '', filename: '', op: 'restore-graveyard', ...extra });

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  clock.queue = [];
  vi.restoreAllMocks();
  setMaintenanceGate(null);
  await flushAll();
});

describe('the operation deadline', () => {
  it('ignores an answerByMono that is not all digits and keeps the receipt bound', () => {
    expect(operationDeadline('x123', 0n)).toBe(40_000_000_000n);
    expect(operationDeadline('123x', 0n)).toBe(40_000_000_000n);
    expect(operationDeadline('9000000000', 0n)).toBe(4_000_000_000n);
  });
});

describe('a restore on a JSON bot through the route', () => {
  it('refuses a body that is not JSON and leaves the entry in the graveyard', async () => {
    const g = freshGuild();
    bury(g, 1000);
    const reply = await applyOperatorDataWrite(restoreReq(g, { contentJson: '{not json' }));
    expect(reply).toStrictEqual({ ok: false, code: 'invalid', error: 'contentJson is not valid JSON' });
    expect(await listed(g)).toEqual([{ guildId: g, retiredAt: 1000, reason: 'webui-operator-delete' }]);
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });

  it('restores the entry deleted at retiredAt 0', async () => {
    const g = freshGuild();
    bury(g, 0);
    const reply = await applyOperatorDataWrite(restoreReq(g, { contentJson: JSON.stringify({ retiredAt: 0 }) }));
    expect(reply).not.toMatchObject({ error: WHOLE_MS });
    expect(reply).toMatchObject({ ok: true, retiredAt: 0 });
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
  });

  it('answers ok with the entry and no moved count, and the data is back', async () => {
    const g = freshGuild();
    bury(g, 2000);
    const reply = await applyOperatorDataWrite(restoreReq(g));
    expect(reply).toStrictEqual({ ok: true, retiredAt: 2000, reason: 'webui-operator-delete', keptUntil: expect.any(Number) });
    expect(fs.readFileSync(dataPath(g, 'm', 'a.json'), 'utf8')).toBe('{"n":5}');
    expect(await listed(g)).toEqual([{ guildId: g, retiredAt: 2000, reason: 'webui-operator-delete' }]);
  });

  it('is out of time when the clock reads exactly its deadline, and nothing is restored', async () => {
    const g = freshGuild();
    bury(g, 3000);
    const receivedAt = process.hrtime.bigint();
    const answerByMono = receivedAt + 60_000_000_000n;
    clock.queue = [receivedAt, operationDeadline(String(answerByMono), receivedAt)];
    const reply = await applyOperatorDataWrite(restoreReq(g, { answerByMono: String(answerByMono) }));
    expect(reply).toMatchObject({ ok: false, code: 'backend-unavailable', error: OUT_OF_TIME });
    expect(await listed(g)).toEqual([{ guildId: g, retiredAt: 3000, reason: 'webui-operator-delete' }]);
    expect(fs.existsSync(dataPath(g))).toBe(false);
  });
});

describe('a delete on a JSON bot through the route', () => {
  it('buries the data with the operator delete reason', async () => {
    const g = freshGuild();
    expect(saveData('a.json', { guildId: g, category: 'm' }, { n: 1 })).toBe(true);
    await flushAll();
    const reply = await applyOperatorDataWrite({ guildId: g, module: '', filename: '', op: 'delete-namespace' });
    expect(reply).toMatchObject({ ok: true });
    const entries = await listed(g);
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toBe('webui-operator-delete');
  });
});
