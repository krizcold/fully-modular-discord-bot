import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';

// The global config editor: a submit whose every value is a default resets the file (deletes it) on the edit and the
// upload modals, a reset the data layer did not take answers so, and the base the view remembered (under the panel's
// own id and the root config's own path) guards the save.

const MODULE = 'ra33ed';
const MODULE_FILE = 'ra33ed.json';
const schema = {
  id: MODULE_FILE,
  name: 'RA33 editor',
  description: 'test schema',
  properties: { a: { type: 'number', default: 0, description: 'a' }, b: { type: 'string', default: 'x', description: 'b' } },
};

const h = vi.hoisted(() => ({ files: [] as any[], refuseDelete: false }));
vi.mock('../../src/bot/internalSetup/utils/configDiscovery', async orig => ({
  ...(await orig<any>()),
  discoverConfigFiles: () => h.files,
  discoverGlobalDataFiles: () => [],
  getConfigFileMetadata: (id: string) => h.files.find(f => f.id === id) ?? null,
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<any>();
  return { ...real, deleteRawAtomic: (...args: unknown[]) => (h.refuseDelete ? false : real.deleteRawAtomic(...args)) };
});

import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { ROOT_CONFIG_PATH, saveGlobalConfig } from '../../src/bot/internalSetup/utils/configManager';
import panel from '../../src/bot/internalSetup/panels/configEditorGlobalPanel';
import { rememberBase } from '../../src/bot/internalSetup/utils/panel/editorBase';
import { truthText, verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { _resetRowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sha, sharedRows } from '../helpers/sharedRows';

const T14 = 'This editor was opened before the bot restarted, or more than 15 minutes ago, so it may show old values; nothing was saved. Open it again to see the current values.';
const t22 = (at: string) => `This data was changed on BRAVO at ${at} after your change read it, so your change was not saved. Reload to see the current values, then try again.`;
const RESET_REFUSED = 'Save failed: the reset was not saved because disk writes are failing';

const moduleFile = dataPath('global', MODULE, MODULE_FILE);
const moduleKey = `global/${MODULE}/${MODULE_FILE}`;
const text = (value: unknown) => JSON.stringify(value, null, 2);
const DEFAULTS = { a: 0, b: 'x' };

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;
let users = 0;
let uploaded = '';

const context = (userId: string, interaction: unknown = null) => ({ userId, panelId: 'config_editor_global', data: {}, interaction, accessMethod: 'system_panel' }) as any;

function submitted(action: 'edit' | 'upload', value: unknown): unknown {
  if (action === 'upload') uploaded = text(value);
  return {
    fields: {
      getTextInputValue: () => text(value),
      getUploadedFiles: () => ({ size: 1, first: () => ({ url: 'https://cdn.invalid/upload.json' }) }),
    },
  };
}

async function submit(fileId: string, userId: string, action: 'edit' | 'upload', value: unknown): Promise<{ reply: string; shown: string }> {
  let response: unknown;
  const reply = await runSealed('panel', null, null, async ledger => {
    response = await panel.handleModal!(context(userId, submitted(action, value)), `${action}_${fileId}`);
    const verdict = await verdictOf([ledger]);
    return verdict.ok ? 'payload' : truthText(verdict.answer, verdict.partial, verdict.changed);
  });
  await dm.flushAll();
  return { reply, shown: JSON.stringify(response) };
}

function clean(): void {
  fs.rmSync(dataPath('global', MODULE), { recursive: true, force: true });
  fs.rmSync(ROOT_CONFIG_PATH, { force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
}

beforeEach(() => {
  users += 1;
  uploaded = '';
  h.refuseDelete = false;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => uploaded }));
  h.files = [
    { id: 'config.json', path: ROOT_CONFIG_PATH, name: 'Main Bot Config', description: '', category: 'config', exists: true },
    { id: MODULE_FILE, path: moduleFile, name: schema.name, description: '', category: 'config', exists: true, schema, moduleName: MODULE },
  ];
  _resetRowQueue();
  clean();
});

afterEach(() => {
  h.refuseDelete = false;
  _resetRowQueue();
  setBackendKind(null);
  clean();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a JSON bot: a submit of only default values resets the file', () => {
  beforeEach(async () => {
    setBackendKind('file');
    saveGlobalConfig(MODULE_FILE, { a: 1 });
    await dm.flushAll();
    expect(JSON.parse(fs.readFileSync(moduleFile, 'utf8'))).toEqual({ a: 1 });
  });

  for (const action of ['edit', 'upload'] as const) {
    it(`the ${action} modal deletes the stored file and shows no error`, async () => {
      const { shown } = await submit(MODULE_FILE, `j-${action}-${users}`, action, DEFAULTS);

      expect(shown).not.toContain('## Error');
      expect(fs.existsSync(moduleFile)).toBe(false);
    });
  }

  it('the edit modal of a file that was never stored shows the view, not a failed reset', async () => {
    fs.rmSync(moduleFile, { force: true });

    const { shown } = await submit(MODULE_FILE, `j-absent-${users}`, 'edit', DEFAULTS);

    expect(shown).not.toContain('## Error');
    expect(shown).toContain(schema.name);
    expect(fs.existsSync(moduleFile)).toBe(false);
  });

  it('a reset the data layer did not take while the file is still there answers that it was not saved', async () => {
    h.refuseDelete = true;

    const { shown } = await submit(MODULE_FILE, `j-refused-${users}`, 'edit', DEFAULTS);

    expect(shown).toContain(RESET_REFUSED);
    expect(JSON.parse(fs.readFileSync(moduleFile, 'utf8'))).toEqual({ a: 1 });
  });
});

describe('a Postgres bot: the base the editor remembered guards the save', () => {
  beforeEach(() => {
    setBackendKind('postgres');
    rows = sharedRows();
    rig = scriptedBackend(rows.answer);
    dm.setGuildDataBackend(rig.backend);
  });

  afterEach(async () => {
    dm.setGuildDataBackend(null);
    _resetRowQueue();
    await rig.backend.stop();
  });

  it('a base remembered under the panel id config_editor_global is the one the submit saves over', async () => {
    saveGlobalConfig(MODULE_FILE, { a: 1 });
    await dm.flushAll();
    const user = `pg-id-${users}`;
    rememberBase(user, 'config_editor_global', moduleKey, sha(text({ a: 1 })));

    const { reply, shown } = await submit(MODULE_FILE, user, 'edit', { a: 2 });

    expect(shown).not.toContain(T14);
    expect(reply).toBe('payload');
    expect(rows.docs.get(moduleKey)?.body.toString('utf8')).toBe(text({ a: 2 }));
  });

  it('the root config.json is guarded by its own path even when discovery names another path for it', async () => {
    h.files[0] = { ...h.files[0], path: dataPath('ra33-dev', 'config.json') };
    saveGlobalConfig('config.json', { a: 1 });
    await dm.flushAll();
    const user = `pg-root-${users}`;
    await panel.handleButton!(context(user), 'select_config.json');
    await panel.handleButton!(context(user), 'edit_config.json');
    rows.put('config.json', text({ a: 9 }));
    fs.mkdirSync(path.dirname(ROOT_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(ROOT_CONFIG_PATH, text({ a: 9 }));

    const { reply } = await submit('config.json', user, 'edit', { a: 2 });

    expect(reply).toBe(t22(rows.clock.now.toISOString()));
    expect(rows.docs.get('config.json')?.body.toString('utf8')).toBe(text({ a: 9 }));
  });
});
