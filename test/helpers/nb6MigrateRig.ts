import fs from 'fs';
import path from 'path';
import { root, seedFile } from './migrationRig';

// NB6's data of no guild on a JSON bot, for the migration rows against real Postgres (tests 28, 29, 42 and 71): the
// root config and the source modules dir are temp paths under DATA_DIR, as test 17's.

export const CFG = path.join(root, 'cfg', 'config.json');
export const MODS = path.join(root, 'srcmods');
/** Not UTF-8, with a NUL byte and a lone continuation byte. */
export const BIN = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a, 0xc3]);
/** Valid UTF-8 holding U+0000. */
export const NUL = Buffer.from('{"a":"\u0000"}', 'utf8');
export const NODE_BIN = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
export const INSTALLED = { modules: { mod1: { name: 'mod1', version: '1.2.0', installedFrom: 'repo', installedAt: '2026-11-01T00:00:00.000Z' } } };
export const MODULE_JSON = '{"name":"mod1","version":"1.2.0"}';

export function writeAt(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** The shared files the rows copy, by their path under DATA_DIR (the root config and the module under their temp places). */
export function sharedFiles(): Record<string, Buffer> {
  return {
    [CFG]: Buffer.from('{"prefix":"!"}'),
    [path.join(root, 'global', 'm', 'a.json')]: Buffer.from('{"a":1}'),
    [path.join(root, 'global', 'm', 'bin.dat')]: BIN,
    [path.join(root, 'global', 'm', 'zero.json')]: NUL,
    [path.join(root, 'global', 'appstore', 'installed.json')]: Buffer.from(JSON.stringify(INSTALLED)),
    [path.join(MODS, 'mod1', 'module.json')]: Buffer.from(MODULE_JSON),
    [path.join(MODS, 'mod1', 'lib', 'bin.node')]: NODE_BIN,
  };
}

/** A JSON bot's data of no guild beside a guild document, a stream with no closing newline and the files of one machine. */
export function seedShared(guildId: string): void {
  seedFile(`${guildId}/m/a.json`, '{"g":1}');
  for (const [file, bytes] of Object.entries(sharedFiles())) writeAt(file, bytes);
  seedFile('global/m/log.jsonl', '{"e":1}\n{"e":2}');
  seedFile('global/fleet/node.json', '{"node":"local"}');
  seedFile('global/metrics/totals.json', '{"n":3}');
}

export const sharedOpts = { rootConfigPath: CFG, sourceModulesDir: MODS };
