import fs from 'fs';
import path from 'path';
import { beforeEach, expect, it, vi } from 'vitest';
import { writeBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { DATA_ROOT, dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

// NB12 (wip-redesign/sheets/NB12.md): an export of a guild holding a file the database cannot store is refused, and
// from that file on nothing more goes into the bundle it was writing.

let guilds = 9_420_200_000;

beforeEach(() => {
  setBackendKind('file');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

it('an export stops writing the bundle at the first file it cannot carry', async () => {
  const guildId = String(++guilds);
  const dir = dataPath(guildId);
  fs.mkdirSync(path.join(dir, 'm'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'm', 'a.json'), '{"x":"\u0000"}');
  const marker = 'after-the-refused-file';
  fs.writeFileSync(path.join(dir, 'm', 'b.json'), JSON.stringify({ marker, pad: 'p'.repeat(64 * 1024) }));

  const realReaddir = fs.promises.readdir.bind(fs.promises) as (...args: any[]) => Promise<any[]>;
  vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: any[]) => {
    const entries = await realReaddir(...args);
    return [...entries].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  }) as any);

  const target = path.join(DATA_ROOT, `nb12L5t1-${guildId}.dbex`);
  const partial = `${target}.partial`;
  const seen: string[] = [];
  const realRm = fs.promises.rm.bind(fs.promises);
  vi.spyOn(fs.promises, 'rm').mockImplementation((async (p: fs.PathLike, opts?: fs.RmOptions) => {
    if (String(p) === partial && fs.existsSync(partial)) seen.push(fs.readFileSync(partial, 'latin1'));
    return realRm(p, opts);
  }) as any);

  const error = await writeBundle(guildId, target).then(() => null, e => e as Error);
  expect(error?.message).toBe(`[DataInterchange] Guild ${guildId} holds 1 file(s) a bundle cannot carry: m/a.json: it holds U+0000 at character 6, which the database cannot store; move their content to an allowed name or delete them, then export again`);
  expect(seen).toHaveLength(1);
  expect(seen[0]).not.toContain(marker);
  expect(seen[0]).not.toContain('m/b.json');
  expect(fs.existsSync(partial)).toBe(false);
  expect(fs.existsSync(target)).toBe(false);
});
