import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { getPending } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { setBackendKind } from '../helpers/backendKind';

// NB6 test 1 (wip-redesign/sheets/NB6.md section 9, decisions 2, 39 and 40, C13; part 4): which files are shared keys,
// and row 77, a JSON bot's global save on the file route (a guard row). sharedStore.ts is imported in the rows that
// read it, so the guard row runs where the module does not exist yet.

const store = () => import('../../src/bot/internalSetup/utils/sharedStore');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dm.flushAll();
});

const g = (...rel: string[]) => dataPath('global', ...rel);

// Section 1's table, one path per row, with the key it has on a Postgres bot (null: a file of one machine, or no doc).
const TABLE: Array<[string, string, string | null]> = [
  ['module config file', g('mod', 'config.json'), 'global/mod/config.json'],
  ['module settings', g('mod', 'settings.json'), 'global/mod/settings.json'],
  ['premium tiers', g('premium-tiers.json'), 'global/premium-tiers.json'],
  ['premium audit lines', g('premium-tiers.audit.jsonl'), 'global/premium-tiers.audit.jsonl'],
  ['premium events journal (decision 40)', g('premium-tiers.events.jsonl'), 'global/premium-tiers.events.jsonl'],
  ['Dummy provider state', g('payment-providers', 'dummy', 'state.json'), 'global/payment-providers/dummy/state.json'],
  ['provider keys (owner question 2, answer (a))', g('payment-providers', 'credentials.json'), 'global/payment-providers/credentials.json'],
  ['persistent panels', g('_panels', 'persistent-panels.json'), 'global/_panels/persistent-panels.json'],
  ['guild blacklist', g('system', 'guild-blacklist.json'), 'global/system/guild-blacklist.json'],
  ['guild notes', g('system', 'guild-notes.json'), 'global/system/guild-notes.json'],
  ['last test guild', g('internalSetup', 'lastTestGuild.json'), 'global/internalSetup/lastTestGuild.json'],
  ['App Store repositories', g('appstore', 'repos.json'), 'global/appstore/repos.json'],
  ['App Store installed list', g('appstore', 'installed.json'), 'global/appstore/installed.json'],
  ['module credentials (owner question 2, answer (a))', g('appstore', 'credentials', 'mod.json'), 'global/appstore/credentials/mod.json'],
  ['component config', g('appstore', 'component-config.json'), 'global/appstore/component-config.json'],
  ['App Store config', g('appstore', 'config.json'), 'global/appstore/config.json'],
  ['metrics totals (local)', g('metrics', 'totals.json'), null],
  ['node identity (local)', g('fleet', 'node.json'), null],
  ['shard layout (local)', g('fleet', 'shards.json'), null],
  ['App Store store lock (local)', g('appstore', 'cache', '.store.lock'), null],
  ['App Store clone file (local)', g('appstore', 'cache', 'repo-x', 'module.json'), null],
  ['App Store store record (local)', g('appstore', 'cache', '.shared-mirror.json'), null],
  ['module code (a module unit, no doc key)', dataPath('appstore-modules', 'mod', 'index.js'), null],
  ['owner channel record', dataPath('owner-channel.json'), null],
  ['owner messages', dataPath('owner-messages.json'), null],
  ['env file', dataPath('.env'), null],
  ['maintenance record', dataPath('maintenance.json'), null],
  ['a session', dataPath('_sessions', 's1.json'), null],
  ['a guild file', dataPath('123456789012345678', 'mod', 'a.json'), null],
  ['the global folder itself', dataPath('global'), null],
];

describe('sharedKeyOf and sharedKeyFor (decisions 2, 39 and 40)', () => {
  it.each(TABLE)('%s: the key on a Postgres bot, none on a JSON bot, sharedKeyFor on both', async (_name, file, key) => {
    const { sharedKeyOf, sharedKeyFor } = await store();
    setBackendKind('postgres');
    expect(sharedKeyOf(file)).toBe(key);
    expect(sharedKeyFor(file)).toBe(key);
    setBackendKind('file');
    expect(sharedKeyOf(file)).toBeNull();
    expect(sharedKeyFor(file)).toBe(key);
  });

  it('the root config is config.json at the production path, and at src/bot/config.json in development', async () => {
    const { sharedKeyOf, sharedKeyFor } = await store();
    const production = dataPath('dist', 'bot', 'config.json');
    const development = path.resolve(__dirname, '../../src/bot/config.json');
    setBackendKind('postgres');
    const env = process.env.NODE_ENV;
    try {
      expect(sharedKeyOf(production)).toBe('config.json');
      expect(sharedKeyOf(development)).toBeNull();
      process.env.NODE_ENV = 'development';
      expect(sharedKeyOf(development)).toBe('config.json');
      expect(sharedKeyOf(production)).toBeNull();
      setBackendKind('file');
      expect(sharedKeyOf(development)).toBeNull();
      expect(sharedKeyFor(development)).toBe('config.json');
    } finally {
      process.env.NODE_ENV = env;
    }
  });

  it('the journal and the audit keys are lines keys; docs and the root config are not', async () => {
    const { isLinesKey, sharedKeyOf } = await store();
    setBackendKind('postgres');
    expect(isLinesKey(sharedKeyOf(g('premium-tiers.events.jsonl'))!)).toBe(true);
    expect(isLinesKey(sharedKeyOf(g('premium-tiers.audit.jsonl'))!)).toBe(true);
    expect(isLinesKey(sharedKeyOf(g('premium-tiers.json'))!)).toBe(false);
    expect(isLinesKey('config.json')).toBe(false);
  });
});

describe('row 77: a JSON bot', () => {
  it('queues a global save on the file route and writes the file (guard)', async () => {
    setBackendKind('file');
    const file = g('nb6route', 'a.json');
    const res = dm.saveDataTracked('a.json', { scope: 'global', category: 'nb6route' }, { v: 1 });
    expect(res.outcome).toBe('saved');
    expect(res.outcome === 'saved' && res.ticket.kind).toBe('file');
    expect(getPending(file)?.op).toBe('write');
    await dm.flushAll();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ v: 1 });
  });
});
