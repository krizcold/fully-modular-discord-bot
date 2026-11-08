import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';

// NB6 test 51, the config editor's rows (wip-redesign/sheets/NB6.md decision 50, rows 174 and 175, T14 and T22; part
// 21): the global config editor carries the sha of the body its view or edit modal showed into the save, upload or
// reset, so a change another machine made in between (already in this mirror) refuses the write with T22; a submit
// with no remembered base, or one older than 15 minutes, is refused with T14 before anything is queued. The rows run
// the real panel, configManager and facade, with the real flush over scripted clients that answer as the shared tables
// do (helpers/sharedRows.ts); only the config discovery is a fixture.

const MODULE = 'nb6ed';
const MODULE_FILE = 'nb6ed.json';
const schema = {
  id: MODULE_FILE,
  name: 'NB6 editor',
  description: 'test schema',
  properties: { a: { type: 'number', default: 0, description: 'a' }, b: { type: 'string', default: 'x', description: 'b' } },
};

const discovery = vi.hoisted(() => ({ files: [] as any[], dataFiles: [] as any[] }));
vi.mock('../../src/bot/internalSetup/utils/configDiscovery', async orig => ({
  ...(await orig<any>()),
  discoverConfigFiles: () => discovery.files,
  discoverGlobalDataFiles: () => discovery.dataFiles,
  getConfigFileMetadata: (id: string) => discovery.files.find(f => f.id === id) ?? null,
}));

import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { ROOT_CONFIG_PATH, saveGlobalConfig } from '../../src/bot/internalSetup/utils/configManager';
import panel from '../../src/bot/internalSetup/panels/configEditorGlobalPanel';
import browser from '../../src/bot/internalSetup/panels/dataBrowserGlobalPanel';
import { truthText, verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { _resetRowQueue, rowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { setBackendKind } from '../helpers/backendKind';
import { scriptedBackend } from '../helpers/scriptedPg';
import { sha, sharedRows } from '../helpers/sharedRows';
import { handleJsonEditorButton, handleJsonEditorModal, type JsonEditorConfig } from '../../src/bot/internalSetup/utils/json/jsonEditorSubpanel';

const T14 = 'This editor was opened before the bot restarted, or more than 15 minutes ago, so it may show old values; nothing was saved. Open it again to see the current values.';
const t22 = (at: string) => `This data was changed on BRAVO at ${at} after your change read it, so your change was not saved. Reload to see the current values, then try again.`;

const moduleFile = dataPath('global', MODULE, MODULE_FILE);
const text = (value: unknown) => JSON.stringify(value, null, 2);

interface Target {
  id: string;
  key: string;
  file: string;
}
const MODULE_TARGET: Target = { id: MODULE_FILE, key: `global/${MODULE}/${MODULE_FILE}`, file: moduleFile };
const ROOT_TARGET: Target = { id: 'config.json', key: 'config.json', file: ROOT_CONFIG_PATH };

let rows: ReturnType<typeof sharedRows>;
let rig: ReturnType<typeof scriptedBackend>;
let users = 0;
let uploaded = '';

const context = (userId: string, interaction: unknown = null) => ({ userId, panelId: 'config_editor_global', data: {}, interaction, accessMethod: 'system_panel' }) as any;

/** The modal submit Discord sends for action, with what the operator typed or uploaded. */
function submitted(action: 'edit' | 'upload' | 'reset', value: unknown): unknown {
  if (action === 'upload') uploaded = text(value);
  return {
    fields: {
      getTextInputValue: (id: string) => (id === 'confirm_text' ? 'RESET' : text(value)),
      getUploadedFiles: () => ({ size: 1, first: () => ({ url: 'https://cdn.invalid/upload.json' }) }),
    },
  };
}

/** A first version stored by the real save and flush: its row and its mirror. */
async function stored(target: Target, value: unknown): Promise<void> {
  saveGlobalConfig(target.id, value);
  await dm.flushAll();
  expect(rows.docs.get(target.key)).toBeDefined();
}

/** Another machine's version: its row, and the mirror the pass wrote from it. */
function changedElsewhere(target: Target, value: unknown): void {
  rows.put(target.key, text(value));
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  fs.writeFileSync(target.file, text(value));
}

/**
 * The modal submit in a ledger of its own, judged before the ledger seals as runPanelAction judges a panel action:
 * the reply is the panel's payload, or the truth text the verdict gives.
 */
async function submit(target: Target, userId: string, action: 'edit' | 'upload' | 'reset', value: unknown): Promise<{ reply: string; response: unknown }> {
  let response: unknown;
  const reply = await runSealed('panel', null, null, async ledger => {
    response = await panel.handleModal!(context(userId, submitted(action, value)), `${action}_${target.id}`);
    const verdict = await verdictOf([ledger]);
    return verdict.ok ? 'payload' : truthText(verdict.answer, verdict.partial, verdict.changed);
  });
  await dm.flushAll();
  return { reply, response };
}

const storedText = (target: Target) => rows.docs.get(target.key)?.body.toString('utf8');

beforeEach(async () => {
  users += 1;
  uploaded = '';
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => uploaded }));
  discovery.files = [
    { id: 'config.json', path: ROOT_CONFIG_PATH, name: 'Main Bot Config', description: '', category: 'config', exists: true },
    { id: MODULE_FILE, path: moduleFile, name: schema.name, description: '', category: 'config', exists: true, schema, moduleName: MODULE },
  ];
  _resetRowQueue();
  fs.rmSync(dataPath('global', MODULE), { recursive: true, force: true });
  fs.rmSync(ROOT_CONFIG_PATH, { force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  setBackendKind('postgres');
  rows = sharedRows();
  rig = scriptedBackend(rows.answer);
  dm.setGuildDataBackend(rig.backend);
});

afterEach(async () => {
  dm.setGuildDataBackend(null);
  _resetRowQueue();
  await rig.backend.stop();
  setBackendKind(null);
  fs.rmSync(dataPath('global', MODULE), { recursive: true, force: true });
  fs.rmSync(ROOT_CONFIG_PATH, { force: true });
  fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});


describe('row 174: a write after another machine\'s change reached this mirror is refused with T22', () => {
  const cases: Array<[string, Target, 'edit' | 'upload' | 'reset']> = [
    ['the edit modal', MODULE_TARGET, 'edit'],
    ['the upload modal', MODULE_TARGET, 'upload'],
    ['the reset modal', MODULE_TARGET, 'reset'],
    ['the edit modal of the root config.json', ROOT_TARGET, 'edit'],
  ];
  for (const [name, target, action] of cases) {
    it(name, async () => {
      const user = `u174-${users}`;
      await stored(target, { a: 1 });
      await panel.handleButton!(context(user), `select_${target.id}`);
      await panel.handleButton!(context(user), `${action}_${target.id}`);
      changedElsewhere(target, { a: 9 });

      const { reply } = await submit(target, user, action, { a: 2 });

      expect(reply).toBe(t22(rows.clock.now.toISOString()));
      expect(storedText(target)).toBe(text({ a: 9 }));
    });
  }

  it('a save from a view rendered after that change lands (a guard)', async () => {
    const user = `u174g-${users}`;
    await stored(MODULE_TARGET, { a: 1 });
    changedElsewhere(MODULE_TARGET, { a: 9 });
    await panel.handleButton!(context(user), `select_${MODULE_FILE}`);
    await panel.handleButton!(context(user), `edit_${MODULE_FILE}`);

    const { reply } = await submit(MODULE_TARGET, user, 'edit', { a: 2 });

    expect(reply).toBe('payload');
    expect(storedText(MODULE_TARGET)).toBe(text({ a: 2 }));
  });
});

describe('row 175: a submit with no remembered base is refused with T14 before anything is queued', () => {
  for (const action of ['edit', 'upload', 'reset'] as const) {
    it(`${action}, with no view or modal opened since the start`, async () => {
      await stored(MODULE_TARGET, { a: 1 });
      const historyBefore = rows.history.length;

      const { response } = await submit(MODULE_TARGET, `u175-${users}`, action, { a: 2 });

      expect(JSON.stringify(response)).toContain(T14);
      expect(rowQueue.keys()).not.toContain(MODULE_TARGET.key);
      await dm.flushAll();
      expect(rows.history.length).toBe(historyBefore);
      expect(storedText(MODULE_TARGET)).toBe(text({ a: 1 }));
    });
  }

  it('edit, with a base remembered more than 15 minutes before the submit', async () => {
    const user = `u175t-${users}`;
    await stored(MODULE_TARGET, { a: 1 });
    await panel.handleButton!(context(user), `select_${MODULE_FILE}`);
    await panel.handleButton!(context(user), `edit_${MODULE_FILE}`);
    const opened = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(opened + 15 * 60_000 + 1);

    const { response } = await submit(MODULE_TARGET, user, 'edit', { a: 2 });
    now.mockRestore();

    expect(JSON.stringify(response)).toContain(T14);
    expect(rowQueue.keys()).not.toContain(MODULE_TARGET.key);
    expect(storedText(MODULE_TARGET)).toBe(text({ a: 1 }));
  });

  it('a JSON bot remembers nothing and saves as today (a guard)', async () => {
    setBackendKind('file');
    const { response } = await submit(MODULE_TARGET, `u175j-${users}`, 'edit', { a: 2 });
    await dm.flushAll();

    expect(JSON.stringify(response)).not.toContain(T14);
    expect(JSON.parse(fs.readFileSync(moduleFile, 'utf8'))).toEqual({ a: 2 });
  });
});

describe('the json editor subpanel carries the base of the file it shows', () => {
  const editor = (saved: Array<{ data: unknown; options: unknown }>): JsonEditorConfig => ({
    panelId: 'nb6_json_panel',
    dataKey: 'nb6ed',
    title: 'NB6 editor',
    getData: () => dm.loadData(MODULE_FILE, { scope: 'global', category: MODULE }, {}),
    saveData: (data, options) => { saved.push({ data, options }); },
    baseFile: moduleFile,
  });
  const jsonModal = (value: unknown) => ({
    fields: { getTextInputValue: () => text(value) },
    deferUpdate: async () => undefined,
    followUp: async (message: { content: string }) => { followUps.push(message.content); },
  });
  let followUps: string[];
  beforeEach(() => { followUps = []; });

  it('an edit after the view and the modal saves with the sha of the body they showed', async () => {
    const user = `uj-${users}`;
    const saved: Array<{ data: unknown; options: unknown }> = [];
    await stored(MODULE_TARGET, { a: 1 });
    await handleJsonEditorButton(editor(saved), context(user), 'jsonedit_nb6ed');
    changedElsewhere(MODULE_TARGET, { a: 9 });

    await handleJsonEditorModal(editor(saved), context(user, jsonModal({ a: 2 })), 'jsonedit_nb6ed');

    expect(saved).toEqual([{ data: { a: 2 }, options: { baseSha: sha(text({ a: 1 })) } }]);
  });

  it('an edit with no remembered base is refused with T14 and saves nothing', async () => {
    const saved: Array<{ data: unknown; options: unknown }> = [];
    await stored(MODULE_TARGET, { a: 1 });

    await handleJsonEditorModal(editor(saved), context(`ujn-${users}`, jsonModal({ a: 2 })), 'jsonedit_nb6ed');

    expect(saved).toEqual([]);
    expect(followUps).toEqual([`**Error:** ${T14}`]);
  });
});

// NB6 test 51, the data browser's rows (part 22): the global data browser's json editor carries the base of the body
// its view or edit modal showed into the edit and upload submits, and the Delete button's confirm modal uses the
// view's base; the same T22 and T14 answers as the config editor.
describe('the data browser carries the base of the body it showed', () => {
  const DATA_FILE = 'nb6db.json';
  const fileKey = `${MODULE}/${DATA_FILE}`;
  const DATA_TARGET: Target = { id: fileKey, key: `global/${MODULE}/${DATA_FILE}`, file: dataPath('global', MODULE, DATA_FILE) };
  type Action = 'edit' | 'upload' | 'delete';
  let followUps: string[];

  beforeEach(() => {
    followUps = [];
    discovery.dataFiles = [{ id: DATA_FILE, moduleName: MODULE, name: 'NB6 data', description: '', exists: true }];
  });

  const browserContext = (userId: string, interaction: unknown = null) => ({ ...context(userId, interaction), panelId: 'data_browser_global' }) as any;

  /** The modal submit Discord sends: the typed body, the uploaded file, or DELETE in the confirm field. */
  function browserSubmitted(action: Action, value: unknown): unknown {
    if (action === 'upload') uploaded = text(value);
    return {
      fields: {
        getTextInputValue: (id: string) => (id === 'confirm_text' ? 'DELETE' : text(value)),
        getUploadedFiles: () => ({ size: 1, first: () => ({ url: 'https://cdn.invalid/upload.json' }) }),
      },
      deferUpdate: async () => undefined,
      followUp: async (message: { content: string }) => { followUps.push(message.content); },
    };
  }

  const modalId = (action: Action) => (action === 'delete' ? `delete_${fileKey}` : `json${action}_${fileKey}`);

  /** Opens the action from the view: the edit and upload buttons of the json editor, or the Delete button. */
  async function open(userId: string, action: Action): Promise<void> {
    await browser.handleButton!(browserContext(userId), `select_${fileKey}`);
    await browser.handleButton!(browserContext(userId), modalId(action));
  }

  async function browserSubmit(userId: string, action: Action, value: unknown): Promise<{ reply: string; response: unknown }> {
    let response: unknown;
    const reply = await runSealed('panel', null, null, async ledger => {
      response = await browser.handleModal!(browserContext(userId, browserSubmitted(action, value)), modalId(action));
      const verdict = await verdictOf([ledger]);
      return verdict.ok ? 'payload' : truthText(verdict.answer, verdict.partial, verdict.changed);
    });
    await dm.flushAll();
    return { reply, response };
  }

  async function storedData(value: unknown): Promise<void> {
    dm.saveGlobalData(fileKey, value);
    await dm.flushAll();
    expect(storedText(DATA_TARGET)).toBe(text(value));
  }

  for (const action of ['edit', 'upload', 'delete'] as const) {
    it(`row 174: the ${action} after another machine's change reached this mirror is refused with T22`, async () => {
      const user = `ub174-${action}-${users}`;
      await storedData({ a: 1 });
      await open(user, action);
      changedElsewhere(DATA_TARGET, { a: 9 });

      const { reply } = await browserSubmit(user, action, { a: 2 });

      expect(reply).toBe(t22(rows.clock.now.toISOString()));
      expect(storedText(DATA_TARGET)).toBe(text({ a: 9 }));
    });
  }

  it('row 174 guard: an edit from a view rendered after that change lands', async () => {
    const user = `ub174g-${users}`;
    await storedData({ a: 1 });
    changedElsewhere(DATA_TARGET, { a: 9 });
    await open(user, 'edit');

    const { reply } = await browserSubmit(user, 'edit', { a: 2 });

    expect(reply).toBe('payload');
    expect(storedText(DATA_TARGET)).toBe(text({ a: 2 }));
  });

  for (const action of ['edit', 'upload', 'delete'] as const) {
    it(`row 175: the ${action} with no view or modal opened since the start is refused with T14`, async () => {
      await storedData({ a: 1 });
      const historyBefore = rows.history.length;

      const { response } = await browserSubmit(`ub175-${action}-${users}`, action, { a: 2 });

      const answered = action === 'delete' ? JSON.stringify(response) : followUps.join('\n');
      expect(answered).toContain(T14);
      expect(rowQueue.keys()).not.toContain(DATA_TARGET.key);
      expect(rows.history.length).toBe(historyBefore);
      expect(storedText(DATA_TARGET)).toBe(text({ a: 1 }));
    });
  }

  it('row 175: an edit with a base remembered more than 15 minutes before the submit is refused with T14', async () => {
    const user = `ub175t-${users}`;
    await storedData({ a: 1 });
    await open(user, 'edit');
    const opened = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(opened + 15 * 60_000 + 1);

    await browserSubmit(user, 'edit', { a: 2 });
    now.mockRestore();

    expect(followUps).toEqual([`**Error:** ${T14}`]);
    expect(rowQueue.keys()).not.toContain(DATA_TARGET.key);
    expect(storedText(DATA_TARGET)).toBe(text({ a: 1 }));
  });

  it('a JSON bot remembers nothing and saves as today (a guard)', async () => {
    setBackendKind('file');
    const { response } = await browserSubmit(`ubj-${users}`, 'edit', { a: 2 });
    await dm.flushAll();

    expect(JSON.stringify(response)).not.toContain(T14);
    expect(followUps).toEqual([]);
    expect(JSON.parse(fs.readFileSync(DATA_TARGET.file, 'utf8'))).toEqual({ a: 2 });
  });
});
