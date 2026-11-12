import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { readJsonUnit, snapshotFromPgRows, stageSnapshot, type Snapshot } from '../../src/bot/internalSetup/utils/dataMigration';
import { root, wipeRoot } from '../helpers/migrationRig';

const G = '880000000000000001';

const graveRow = (usedAt: unknown) => ({ guild_id: G, module: 'mod', filename: 'a.json', kind: 'doc', doc: '{"a":1}', retired_at: '100', reason: 'left', used_at: usedAt });

describe('a Postgres graveyard entry read into a snapshot carries its newest restore', () => {
  it('the largest used_at of the entry\'s rows', () => {
    const rows = [graveRow('5'), { ...graveRow('9'), filename: 'b.json' }, { ...graveRow('7'), filename: 'c.json' }];
    expect(snapshotFromPgRows([], [], rows).graves).toEqual([{ guildId: G, retiredAt: 100, reason: 'left', usedAt: 9 }]);
  });

  it('one row with used_at 5 gives usedAt 5', () => {
    expect(snapshotFromPgRows([], [], [graveRow('5')]).graves[0].usedAt).toBe(5);
  });

  it('rows whose used_at is null give no usedAt', () => {
    const graves = snapshotFromPgRows([], [], [graveRow(null), { ...graveRow(null), filename: 'b.json' }]).graves;
    expect(graves).toHaveLength(1);
    expect(graves[0].usedAt).toBeUndefined();
  });

  it('a null row beside a row of 4 keeps 4', () => {
    expect(snapshotFromPgRows([], [], [graveRow(null), { ...graveRow('4'), filename: 'b.json' }]).graves[0].usedAt).toBe(4);
  });
});

describe('a JSON unit read', () => {
  it('an empty stream stays empty and is not named as closed', async () => {
    wipeRoot();
    const dir = path.join(root, G);
    fs.mkdirSync(path.join(dir, 'mod'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mod', 'e.jsonl'), '');
    const snap = await readJsonUnit({ guildId: G, dir });
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].bytes.length).toBe(0);
    expect(snap.items[0].closedTail).toBeUndefined();
  });

  it('a graveyard note\'s usedAt reaches the snapshot', async () => {
    wipeRoot();
    const dir = path.join(root, '_graveyard', `${G}-100`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.json'), '{"a":1}');
    fs.writeFileSync(path.join(dir, '.graveyard.json'), JSON.stringify({ guildId: G, reason: 'left', ts: 100, usedAt: 123 }));
    const snap = await readJsonUnit({ guildId: G, retiredAt: 100, dir });
    expect(snap.graves).toEqual([{ guildId: G, retiredAt: 100, reason: 'left', usedAt: 123 }]);
  });

  it('a note with no usedAt gives none', async () => {
    wipeRoot();
    const dir = path.join(root, '_graveyard', `${G}-100`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.json'), '{"a":1}');
    fs.writeFileSync(path.join(dir, '.graveyard.json'), JSON.stringify({ guildId: G, reason: 'left', ts: 100 }));
    const snap = await readJsonUnit({ guildId: G, retiredAt: 100, dir });
    expect(snap.graves).toHaveLength(1);
    expect(snap.graves[0].usedAt).toBeUndefined();
  });
});

describe('a staged graveyard note', () => {
  it('holds the entry\'s usedAt, and an entry without one gets none', async () => {
    wipeRoot();
    const staging = path.join(root, '.migrate-ra44');
    const item = (retiredAt: number) => ({ guildId: G, grave: true, retiredAt, module: '', filename: 'a.json', kind: 'doc' as const, bytes: Buffer.from('{"a":1}') });
    const snap: Snapshot = {
      items: [item(100), item(200)],
      graves: [{ guildId: G, retiredAt: 100, reason: 'left', usedAt: 9 }, { guildId: G, retiredAt: 200, reason: 'gone' }],
      guilds: [], leftOut: [], shadow: [],
    };
    await stageSnapshot(snap, staging);
    const note = (at: number) => fs.readFileSync(path.join(staging, '_graveyard', `${G}-${at}`, '.graveyard.json'), 'utf8');
    expect(note(100)).toBe(JSON.stringify({ guildId: G, reason: 'left', ts: 100, usedAt: 9 }, null, 2));
    expect(note(200)).toBe(JSON.stringify({ guildId: G, reason: 'gone', ts: 200 }, null, 2));
  });
});
