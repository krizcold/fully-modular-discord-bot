import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { applyOperatorDataWrite, applyOperatorGlobalRead, shaOfRaw } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { flushAll, readRawStrict, saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import fc from 'fast-check';
import { put, readJson } from '../helpers/configRig';
import fs from 'fs';

// NB10 test 5: a write built on a read carries the read's sha, and the executor compares it in the write's own turn.

const G = '123456789012345678';
const guildFile = () => dataPath(G, 'mod', 'x.json');
const globalFile = () => dataPath('global', 'mod', 'x.json');
const raw = (p: string) => fs.readFileSync(p, 'utf8');

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await flushAll();
  fs.rmSync(dataPath(G), { recursive: true, force: true });
  fs.rmSync(dataPath('global', 'mod'), { recursive: true, force: true });
});

afterEach(() => vi.restoreAllMocks());

describe('the executor compares the read a write was built on', () => {
  it('a guild write with the current sha writes; another sha or absent against a file answers changed and writes nothing', async () => {
    put(guildFile(), { v: 1 });
    const stale = shaOfRaw(raw(guildFile()));
    expect(await applyOperatorDataWrite({ guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: '{"v":2}', expectSha: stale })).toMatchObject({ ok: true });
    await flushAll();
    expect(readJson(guildFile())).toEqual({ v: 2 });
    expect(await applyOperatorDataWrite({ guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: '{"v":3}', expectSha: stale })).toMatchObject({ ok: false, code: 'changed' });
    expect(await applyOperatorDataWrite({ guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: '{"v":3}', expectSha: 'absent' })).toMatchObject({ ok: false, code: 'changed' });
    await flushAll();
    expect(readJson(guildFile())).toEqual({ v: 2 });
  });

  it('a module write made after the read survives: the route\'s write answers changed', async () => {
    put(guildFile(), { count: 1 });
    const read = shaOfRaw(raw(guildFile()));
    saveDataTracked('x.json', { guildId: G, category: 'mod' }, { count: 2 });
    const reply = await applyOperatorDataWrite({ guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: '{"count":1,"op":true}', expectSha: read });
    expect(reply).toMatchObject({ ok: false, code: 'changed', error: 'This file changed while the save was being made; nothing was saved. Reload it to see the current values.' });
    await flushAll();
    expect(readJson(guildFile())).toEqual({ count: 2 });
  });

  it('a guild save whose global twin changed after the read answers changed, and the guild file is unchanged', async () => {
    put(guildFile(), { a: 1 });
    put(globalFile(), { a: 0 });
    const twinRead = shaOfRaw(raw(globalFile()));
    put(globalFile(), { a: 5 });
    const reply = await applyOperatorDataWrite({
      guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: '{"a":2}',
      expectSha: shaOfRaw(raw(guildFile())), twin: { rel: 'mod/x.json', expectSha: twinRead },
    });
    expect(reply).toMatchObject({ ok: false, code: 'changed' });
    expect(readJson(guildFile())).toEqual({ a: 1 });
  });

  it('the data editor\'s save answers changed-since-open with its own text', async () => {
    put(guildFile(), { a: 1 });
    const reply = await applyOperatorDataWrite({ guildId: G, module: 'mod', filename: 'x.json', op: 'write', contentJson: '{}', expectSha: 'absent', sinceOpen: true });
    expect(reply).toMatchObject({ ok: false, code: 'changed-since-open', error: 'This file changed since you opened it; nothing was saved. Reload it to see the current values.' });
  });

  it('global.write compares the same way', async () => {
    put(globalFile(), { g: 1 });
    const read = shaOfRaw(raw(globalFile()));
    expect(await applySharedOp({ op: 'global.write', args: { rel: 'mod/x.json', contentJson: '{"g":2}', expectSha: read } })).toMatchObject({ ok: true });
    expect(await applySharedOp({ op: 'global.write', args: { rel: 'mod/x.json', contentJson: '{"g":3}', expectSha: read } })).toMatchObject({ ok: false, code: 'changed' });
    await flushAll();
    expect(readJson(globalFile())).toEqual({ g: 2 });
  });

  it('a guild-root file (module empty) is a valid write target', async () => {
    const reply = await applyOperatorDataWrite({ guildId: G, module: '', filename: 'foo.json', op: 'write', contentJson: '{"r":1}', expectSha: 'absent' });
    expect(reply).toMatchObject({ ok: true });
    await flushAll();
    expect(readJson(dataPath(G, 'foo.json'))).toEqual({ r: 1 });
  });
});

describe('random interleavings of module writes and route read-then-write pairs (NB10 test 5, property)', () => {
  it('every accepted write is in the final body: a route write lands only over the body it read', async () => {
    const rel = 'mod/prop.json';
    const file = dataPath('global', 'mod', 'prop.json');
    const bodyNow = (): { ids: string[] } => { const r = readRawStrict(file); return r === null ? { ids: [] } : JSON.parse(r); };
    await fc.assert(fc.asyncProperty(
      fc.array(fc.oneof(fc.constant({ kind: 'module' as const }), fc.record({ kind: fc.constant('read' as const), route: fc.integer({ min: 0, max: 2 }) }), fc.record({ kind: fc.constant('write' as const), route: fc.integer({ min: 0, max: 2 }) }), fc.constant({ kind: 'flush' as const })), { maxLength: 25 }),
      async steps => {
        await flushAll();
        fs.rmSync(file, { force: true });
        const accepted: string[] = [];
        const reads = new Map<number, { sha: string; body: { ids: string[] } }>();
        let n = 0;
        for (const step of steps) {
          if (step.kind === 'module') {
            const id = `m${n++}`;
            const outcome = saveDataTracked('prop.json', { scope: 'global', category: 'mod' }, { ids: [...bodyNow().ids, id] });
            if (outcome.outcome === 'saved') accepted.push(id);
          } else if (step.kind === 'read') {
            const served = applyOperatorGlobalRead({ rel }) as any;
            reads.set(step.route, { sha: shaOfRaw(served.contentJson ?? null), body: served.contentJson ? JSON.parse(served.contentJson) : { ids: [] } });
          } else if (step.kind === 'write') {
            const read = reads.get(step.route);
            if (!read) continue;
            reads.delete(step.route);
            const id = `r${n++}`;
            const reply = await applySharedOp({ op: 'global.write', args: { rel, contentJson: JSON.stringify({ ids: [...read.body.ids, id] }), expectSha: read.sha } });
            if (reply.ok) accepted.push(id);
            else expect(reply).toMatchObject({ code: 'changed' });
          } else {
            await flushAll();
          }
        }
        await flushAll();
        const final = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { ids: [] };
        for (const id of accepted) expect(final.ids).toContain(id);
      },
    ), { numRuns: 40 });
  }, 120_000);
});
