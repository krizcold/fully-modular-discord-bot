import fs from 'fs';
import path from 'path';
import fc from 'fast-check';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonBot, realService, resetDatabase, schemas, startRig, stopRig, type PgRig } from '../helpers/pgMigrationRig';
import { FakeHost, root, seedFile, useDatabaseUrl, wipeRoot, why } from '../helpers/migrationRig';

// NB3 decisions 7, 9, 10 and 13: JSON to Postgres to JSON gives back the same files.

let rig: PgRig;

beforeAll(async () => { rig = await startRig(); }, 180_000);
afterAll(async () => { await stopRig(rig); });
beforeEach(async () => {
  wipeRoot();
  await resetDatabase(rig);
  useDatabaseUrl(rig.url);
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

function guildFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.name !== '.graveyard.json') out[r] = fs.readFileSync(path.join(dir, e.name)).toString('hex');
    }
  };
  for (const name of fs.readdirSync(root)) {
    if (/^\d+$/.test(name) || name === '_graveyard') walk(path.join(root, name), name);
  }
  return out;
}

function notes(): Array<[string, string]> {
  const dir = path.join(root, '_graveyard');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(n => {
    const note = JSON.parse(fs.readFileSync(path.join(dir, n, '.graveyard.json'), 'utf-8'));
    return [note.guildId, note.reason] as [string, string];
  }).sort();
}

/** A store's identity and every row's sha256, so a store moved aside can be compared with itself before the move. */
async function storeRows(schema: string) {
  const q = async (sql: string) => (await rig.admin.query(sql)).rows;
  return {
    storeId: JSON.parse((await q(`SELECT value FROM "${schema}".meta WHERE key = 'store_id'`))[0].value),
    docs: await q(`SELECT guild_id::text, module, filename, encode(sha256(convert_to(doc, 'UTF8')), 'hex') AS h FROM "${schema}".guild_data ORDER BY 1, 2, 3`),
    streams: await q(`SELECT guild_id::text, module, filename, count(*)::int AS chunks, encode(sha256(convert_to(string_agg(chunk, '' ORDER BY seq), 'UTF8')), 'hex') AS h FROM "${schema}".guild_append GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`),
    graves: await q(`SELECT guild_id::text, retired_at::text, module, filename, kind, reason, encode(sha256(convert_to(doc, 'UTF8')), 'hex') AS h FROM "${schema}".guild_data_graveyard ORDER BY 1, 2, 3, 4`),
    owners: await q(`SELECT guild_id::text, node_id, retired_at::text FROM "${schema}".guild_ownership ORDER BY 1`),
  };
}

const content = fc.oneof(fc.constant(''), fc.constant('﻿{"bom":1}'), fc.constant('a\r\nb\r\n'), fc.string({ unit: 'grapheme', maxLength: 40 }).filter(s => !s.includes('\u0000')));
const name = fc.constantFrom('a', 'b', 'données', 'ключ', 'x y');
const file = fc.record({ guild: fc.constantFrom('250000000000000001', '250000000000000002'), module: name, file: name, stream: fc.boolean(), text: content });

describe('the round trip', () => {
  it('JSON to Postgres to JSON gives the same files and notes, and keeps the first store aside unchanged', async () => {
    await fc.assert(fc.asyncProperty(fc.uniqueArray(file, { selector: f => `${f.guild}/${f.module}/${f.file}`, minLength: 1, maxLength: 8 }), fc.boolean(), async (files, withGrave) => {
      wipeRoot();
      await resetDatabase(rig);
      jsonBot();
      for (const f of files) seedFile(`${f.guild}/${f.module}/${f.file}${f.stream ? '.jsonl' : '.json'}`, f.text);
      if (withGrave) {
        seedFile('_graveyard/250000000000000003-1700000000000/m/g.json', '{"g":1}');
        seedFile('_graveyard/250000000000000003-1700000000000/.graveyard.json', JSON.stringify({ guildId: '250000000000000003', reason: 'left the guild', ts: 1 }));
      }
      const before = guildFiles();
      const notesBefore = notes();
      const there = realService(new FakeHost());
      await there.post({ jobId: 'job-round-001', to: 'postgres' });
      await there.idle();
      expect(there.status().body.job?.state, why(there.status().body.job)).toBe('done');
      const seeded = {
        documents: files.filter(f => !f.stream).length,
        appendFiles: files.filter(f => f.stream).length,
        graveyardEntries: withGrave ? 1 : 0,
      };
      expect(there.status().body.job.counts).toMatchObject(seeded);
      const first = await storeRows('smdb_data');
      expect(first.docs.length + first.streams.length + first.graves.length).toBe(files.length + (withGrave ? 1 : 0));
      const back = realService(new FakeHost());
      await back.post({ jobId: 'job-round-002', to: 'file' });
      await back.idle();
      expect(back.status().body.job?.state, why(back.status().body.job)).toBe('done');
      expect(back.status().body.job.counts).toMatchObject(seeded);
      expect(guildFiles()).toEqual(before);
      expect(notes()).toEqual(notesBefore);
      const names = await schemas(rig);
      const aside = names.filter(n => n.startsWith('smdb_superseded_'));
      expect(aside).toHaveLength(1);
      expect(names).not.toContain('smdb_data');
      expect(await storeRows(aside[0])).toEqual(first);
    }), { numRuns: 6 });
  }, 240_000);
});
