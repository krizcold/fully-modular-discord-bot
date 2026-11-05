import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { textRefusal } from '../../src/bot/internalSetup/utils/storableData';
import { setBackendKind } from '../helpers/backendKind';

// NB10 decision 1 with NB12 rule P: the web UI's check before a backup runs outside the writer, so it reads the guild
// folder and never removes a folder or temp file there; the writer's own check still does.

let guilds = 9_740_000_000;
const BAD = 'a\u0000b';

function guild(files: Record<string, string> = {}, dirs: string[] = []) {
  const g = String(++guilds);
  const p = (rel = '') => (rel ? dataPath(g, ...rel.split('/')) : dataPath(g));
  fs.mkdirSync(p(), { recursive: true });
  for (const d of dirs) fs.mkdirSync(p(d), { recursive: true });
  for (const [key, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(p(key)), { recursive: true });
    fs.writeFileSync(p(key), text);
  }
  return { g, p };
}

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dm.flushAll();
});

describe('the check outside the writer', () => {
  it('passes a keyless folder in the way and leaves it and its old temp file on disk', () => {
    const { p } = guild({ 'm/a/w.tmp': '' });
    const old = Date.now() / 1000 - 7_200;
    fs.utimesSync(p('m/a/w.tmp'), old, old);
    expect(dm.rawCheckRefusal(p('m/a'), '{}')).toBeNull();
    expect(fs.existsSync(p('m/a/w.tmp'))).toBe(true);
  });

  it('passes an empty folder in the way and leaves it on disk, where the writer\'s check removes it', () => {
    const { p } = guild({}, ['m/a']);
    expect(dm.rawCheckRefusal(p('m/a'), '{}')).toBeNull();
    expect(fs.statSync(p('m/a')).isDirectory()).toBe(true);
    expect(dm.rawWriteRefusal(p('m/a'), '{}')).toBeNull();
    expect(fs.existsSync(p('m/a'))).toBe(false);
  });

  it('refuses a key that collides with a stored key, with the writer\'s reason', () => {
    const { p } = guild({ 'm/a': '{}' });
    const checked = dm.rawCheckRefusal(p('m/a/b'), '{}');
    expect(checked).toMatchObject({ accepted: false, cause: 'unstorable' });
    expect(dm.rawWriteRefusal(p('m/a/b'), '{}')).toEqual(checked);
    expect(fs.readFileSync(p('m/a'), 'utf8')).toBe('{}');
  });

  it('refuses text the store cannot hold, as the writer does', () => {
    const { p } = guild();
    expect(dm.rawCheckRefusal(p('m/x.json'), BAD)).toEqual({ accepted: false, cause: 'unstorable', reason: textRefusal(BAD, 'text') });
  });
});
