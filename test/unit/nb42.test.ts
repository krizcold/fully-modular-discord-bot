import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB42: the premium tab's credentials save names each key the container environment pins, in the setup route's
// sentence, and writes /data/.env from what the file holds plus the operator's changes. Values are made up.

const registry = vi.hoisted(() => {
  const provider = (id: string, keys: string[]) => ({
    id,
    getCredentialFields: () => keys.map(key => ({ key, label: key, type: 'secret' })),
    isConfigured: () => true,
  });
  const providers: Record<string, unknown> = {
    stripe: provider('stripe', ['STRIPE_SECRET_KEY', 'WEBUI_BASE_URL']),
    custom: provider('custom', ['STRIPE_NB42_KEY', 'STRIPE_NB42_OTHER', 'NB42_PLAIN']),
  };
  return { get: (id: string) => providers[id] };
});
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({ getPaymentRegistry: () => registry }));

import { dataPath } from '../../src/utils/dataRoot';
import { loadCredentials } from '../../src/utils/envLoader';
import type { BotManager } from '../../src/webui/botManager';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { createSetupRoutes } from '../../src/webui/routes/setup';
import { setBackendKind } from '../helpers/backendKind';
import { heldApi, mount, settle } from '../helpers/jsxRig';

const ENV = dataPath('.env');
const NAMED = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID', 'MAIN_GUILD_ID', 'STRIPE_NB42_KEY', 'STRIPE_NB42_OTHER', 'STRIPE_SECRET_KEY', 'WEBUI_BASE_URL', 'SESSION_SECRET', 'BUILD_MODE', 'NB42_PLAIN', 'UNKNOWN_KEY'];
const note = (key: string) => ({ field: key, message: `${key} is set by the container environment, so it keeps its value` });

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } };

async function handle(router: unknown, method: string, at: string, req: object): Promise<{ status: number; body: any }> {
  const layer = (router as { stack: Layer[] }).stack.find(l => l.route?.path === at && l.route.methods[method]);
  let status = 200;
  let body: any;
  const res = { status(code: number) { status = code; return res; }, json(b: unknown) { body = b; return res; } };
  await layer!.route!.stack[0].handle({ params: {}, body: {}, query: {}, ...req }, res);
  return { status, body };
}

const opCalls: unknown[][] = [];
let opReply: object = { ok: true };
const manager = { runSharedOp: async (...args: unknown[]) => { opCalls.push(args); return opReply; } } as unknown as BotManager;
const put = (providerId: string, body: object) =>
  handle(createAppStoreRoutes(manager), 'put', '/premium/providers/:providerId/credentials', { params: { providerId }, body });

const fileKeys = () => (fs.existsSync(ENV) ? dotenv.parse(fs.readFileSync(ENV)) : {});

/** The loader forgets the keys it seeded from the file only when it reads a file that lacks them. */
function forgetSeeded(): void {
  fs.writeFileSync(ENV, '');
  loadCredentials();
  fs.rmSync(ENV, { force: true });
}

let envBefore: Buffer | null;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  envBefore = fs.existsSync(ENV) ? fs.readFileSync(ENV) : null;
  saved = Object.fromEntries(NAMED.map(key => [key, process.env[key]]));
  fs.mkdirSync(path.dirname(ENV), { recursive: true });
  forgetSeeded();
  for (const key of NAMED) delete process.env[key];
  opCalls.length = 0;
  opReply = { ok: true };
});
afterEach(() => {
  setBackendKind(null);
  forgetSeeded();
  for (const key of NAMED) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  if (envBefore) fs.writeFileSync(ENV, envBefore);
  vi.restoreAllMocks();
});

describe('the answer names each saved key the container environment pins', () => {
  it('a pinned key sent with a new value: named in the sentence the setup route gives, without either value', async () => {
    process.env.STRIPE_NB42_KEY = 'made-up-pinned-value';
    process.env.SESSION_SECRET = 'made-up-pinned-session-secret-00';
    const answer = await put('custom', { values: { STRIPE_NB42_KEY: 'made-up-new-value' } });
    expect(answer.status).toBe(200);
    expect(answer.body.success).toBe(true);
    expect(answer.body.containerSet).toEqual([note('STRIPE_NB42_KEY')]);
    expect(JSON.stringify(answer.body)).not.toContain('made-up');
    expect(fileKeys()).toEqual({ STRIPE_NB42_KEY: 'made-up-new-value' });
    expect(process.env.STRIPE_NB42_KEY).toBe('made-up-pinned-value');

    const setup = await handle(createSetupRoutes(), 'post', '/credentials', { body: { SESSION_SECRET: 'made-up-new-session-secret-0000' } });
    expect(setup.body.containerSet).toEqual([{ field: 'SESSION_SECRET', message: note('SESSION_SECRET').message }]);
    expect(answer.body.containerSet[0].message).toBe(setup.body.containerSet[0].message.replace('SESSION_SECRET', 'STRIPE_NB42_KEY'));
  });

  it('a pinned key the operator clears: named, and the bot still reads the container value', async () => {
    process.env.STRIPE_NB42_KEY = 'made-up-pinned-value';
    fs.writeFileSync(ENV, 'STRIPE_NB42_KEY=made-up-older-save\nSTRIPE_NB42_OTHER=kept\n');
    const answer = await put('custom', { clear: ['STRIPE_NB42_KEY'] });
    expect(answer.body.success).toBe(true);
    expect(answer.body.containerSet).toEqual([note('STRIPE_NB42_KEY')]);
    expect(fileKeys()).toEqual({ STRIPE_NB42_OTHER: 'kept' });
    expect(loadCredentials().STRIPE_NB42_KEY).toBe('made-up-pinned-value');
  });

  it('a pinned key sent with the value the container gives: the file holds the sent value, and no note', async () => {
    process.env.STRIPE_NB42_KEY = 'made-up-pinned-value';
    const answer = await put('custom', { values: { STRIPE_NB42_KEY: 'made-up-pinned-value' } });
    expect(answer.body.success).toBe(true);
    expect('containerSet' in answer.body).toBe(false);
    expect(fileKeys()).toEqual({ STRIPE_NB42_KEY: 'made-up-pinned-value' });
  });

  it('the same over a file that holds another value: the file holds the sent value, not the old one', async () => {
    process.env.STRIPE_NB42_KEY = 'made-up-pinned-value';
    fs.writeFileSync(ENV, 'STRIPE_NB42_KEY=made-up-file-value\nSTRIPE_NB42_OTHER=kept\n');
    const answer = await put('custom', { values: { STRIPE_NB42_KEY: 'made-up-pinned-value' } });
    expect(answer.body.success).toBe(true);
    expect('containerSet' in answer.body).toBe(false);
    expect(fileKeys()).toEqual({ STRIPE_NB42_KEY: 'made-up-pinned-value', STRIPE_NB42_OTHER: 'kept' });
  });

  it('a key the loader reads from the file, set to one value by the container and the file: a new value is read, so no note', async () => {
    process.env.NB42_PLAIN = 'made-up-shared-value';
    fs.writeFileSync(ENV, 'NB42_PLAIN=made-up-shared-value\n');
    const answer = await put('custom', { values: { NB42_PLAIN: 'made-up-new-value' } });
    expect(answer.body.success).toBe(true);
    expect('containerSet' in answer.body).toBe(false);
    expect(fileKeys()).toEqual({ NB42_PLAIN: 'made-up-new-value' });
    expect(loadCredentials().NB42_PLAIN).toBe('made-up-new-value');
  });

  it('a Postgres bot whose doc write fails after the local save: the error ends with the kept-keys sentence and the note', async () => {
    setBackendKind('postgres');
    process.env.WEBUI_BASE_URL = 'https://pinned.example';
    opReply = { ok: false, code: 'disk' };
    const answer = await put('stripe', { values: { STRIPE_SECRET_KEY: 'made-up-new-secret', WEBUI_BASE_URL: 'https://new.example' } });
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({
      success: false,
      error: 'The disk did not take the write, so your change was not saved. Check the disk, then try again.'
        + ' WEBUI_BASE_URL were saved on this machine only (in /data/.env); set them on each machine of the bot.'
        + ' WEBUI_BASE_URL is set by the container environment, so it keeps its value.',
    });
    expect(opCalls).toHaveLength(1);
    expect(fileKeys()).toEqual({ WEBUI_BASE_URL: 'https://new.example' });
  });

  it('an unpinned key gives no note, also when another key of the provider is pinned and not sent', async () => {
    process.env.STRIPE_NB42_OTHER = 'made-up-pinned-value';
    const answer = await put('custom', { values: { STRIPE_NB42_KEY: 'made-up-new-value' } });
    expect(answer.body.success).toBe(true);
    expect('containerSet' in answer.body).toBe(false);
    expect(fileKeys()).toEqual({ STRIPE_NB42_KEY: 'made-up-new-value' });
    expect(loadCredentials().STRIPE_NB42_KEY).toBe('made-up-new-value');
  });

  it('a key saved through the file earlier is not pinned: a second save gives no note and the new value is read', async () => {
    await put('custom', { values: { STRIPE_NB42_KEY: 'made-up-first' } });
    loadCredentials();
    expect(process.env.STRIPE_NB42_KEY).toBe('made-up-first');
    const answer = await put('custom', { values: { STRIPE_NB42_KEY: 'made-up-second' } });
    expect('containerSet' in answer.body).toBe(false);
    expect(loadCredentials().STRIPE_NB42_KEY).toBe('made-up-second');
  });

  it('a key the loader never takes from the container environment gives no note: providers read the saved value', async () => {
    process.env.NB42_PLAIN = 'made-up-container-value';
    const answer = await put('custom', { values: { NB42_PLAIN: 'made-up-new-value' } });
    expect(answer.body.success).toBe(true);
    expect('containerSet' in answer.body).toBe(false);
    expect(loadCredentials().NB42_PLAIN).toBe('made-up-new-value');
  });

  it("a Postgres bot's doc key gives no note and does not reach the file; a pinned key kept in the file is named", async () => {
    setBackendKind('postgres');
    process.env.STRIPE_SECRET_KEY = 'made-up-pinned-secret';
    fs.writeFileSync(ENV, 'STRIPE_NB42_OTHER=kept\n');
    const doc = await put('stripe', { values: { STRIPE_SECRET_KEY: 'made-up-new-secret' } });
    expect(doc.status).toBe(200);
    expect('containerSet' in doc.body).toBe(false);
    expect(opCalls).toEqual([['provider.saveCredentials', { providerId: 'stripe', changes: { STRIPE_SECRET_KEY: 'made-up-new-secret' } }]]);
    expect(fileKeys()).toEqual({ STRIPE_NB42_OTHER: 'kept' });

    process.env.WEBUI_BASE_URL = 'https://pinned.example';
    const local = await put('stripe', { values: { WEBUI_BASE_URL: 'https://new.example' } });
    expect(local.body.containerSet).toEqual([note('WEBUI_BASE_URL')]);
    expect(local.body.message).toBe('Saved. WEBUI_BASE_URL are kept on this machine only (in /data/.env); set them on each machine of the bot.');
    expect(fileKeys()).toEqual({ STRIPE_NB42_OTHER: 'kept', WEBUI_BASE_URL: 'https://new.example' });
  });
});

describe('a save writes the file from what the file holds', () => {
  const pin = () => {
    process.env.DISCORD_TOKEN = 'made-up-container-token-0000000000';
    process.env.CLIENT_ID = '123456789012345678';
    process.env.GUILD_ID = '223456789012345678';
  };

  it('keys only the container environment sets are not added, and no MAIN_GUILD_ID', async () => {
    pin();
    fs.writeFileSync(ENV, 'STRIPE_NB42_OTHER=kept\n');
    const answer = await put('custom', { values: { STRIPE_NB42_KEY: 'made-up-new-value' } });
    expect(answer.body.success).toBe(true);
    expect(fileKeys()).toEqual({ STRIPE_NB42_OTHER: 'kept', STRIPE_NB42_KEY: 'made-up-new-value' });

    // The manager drops its keys: the bot's loader finds none of them in the file.
    for (const key of ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID']) delete process.env[key];
    const read = loadCredentials();
    expect([read.DISCORD_TOKEN, read.CLIENT_ID, read.GUILD_ID, read.MAIN_GUILD_ID]).toEqual([undefined, undefined, undefined, undefined]);
    expect(read.STRIPE_NB42_KEY).toBe('made-up-new-value');
    expect(read.STRIPE_NB42_OTHER).toBe('kept');
  });

  it('the same with no file before the save: the file holds the sent key alone', async () => {
    pin();
    const answer = await put('custom', { values: { STRIPE_NB42_KEY: 'made-up-new-value' } });
    expect(answer.body.success).toBe(true);
    expect(fileKeys()).toEqual({ STRIPE_NB42_KEY: 'made-up-new-value' });
  });

  it('keys in the file that were not sent keep their values, comments and order', async () => {
    pin();
    fs.writeFileSync(ENV, '# head\nMAIN_GUILD_ID=323456789012345678\nSTRIPE_NB42_OTHER=kept\nSTRIPE_NB42_KEY=old\nUNKNOWN_KEY=stays\n');
    const answer = await put('custom', { values: { STRIPE_NB42_KEY: 'made-up-new-value', STRIPE_NB42_OTHER: '' } });
    expect(answer.body.success).toBe(true);
    expect(fs.readFileSync(ENV, 'utf8')).toBe('# head\nMAIN_GUILD_ID=323456789012345678\nSTRIPE_NB42_OTHER=kept\nSTRIPE_NB42_KEY=made-up-new-value\nUNKNOWN_KEY=stays\n');
  });

  it('a cleared key leaves the file, the others stay', async () => {
    fs.writeFileSync(ENV, 'STRIPE_NB42_OTHER=kept\nSTRIPE_NB42_KEY=old\n');
    loadCredentials();
    const answer = await put('custom', { clear: ['STRIPE_NB42_KEY'] });
    expect(answer.body.success).toBe(true);
    expect('containerSet' in answer.body).toBe(false);
    expect(fileKeys()).toEqual({ STRIPE_NB42_OTHER: 'kept' });
    expect(loadCredentials().STRIPE_NB42_KEY).toBeUndefined();
  });
});

describe("the premium tab's credentials modal", () => {
  async function saveWith(answer: object) {
    const { calls, api } = heldApi();
    const toasts: unknown[][] = [];
    const file = path.join(__dirname, '../../src/webui/public/components/AppStorePanel.jsx');
    const m = mount(file, 'ProviderCredentialsModal', { providerId: 'custom', providerName: 'Custom', onClose: () => {}, onSaved: () => {} }, {
      api, showToast: (...args: unknown[]) => { toasts.push(args); }, disabledButtonStyle: () => ({}),
    });
    await settle();
    calls[0].answer({ success: true, fields: [{ key: 'STRIPE_NB42_KEY', label: 'Key', type: 'secret' }], status: { STRIPE_NB42_KEY: { set: true } }, isConfigured: true });
    await settle();
    m.all(el => el.type === 'input')[0].props.onChange({ target: { value: 'made-up-new-value' } });
    await settle();
    m.button(/^Save$/).props.onClick();
    await settle();
    calls[1].answer(answer);
    await settle();
    return { calls, toasts };
  }

  it('shows each note as a warning that stays, as the setup page does, beside the saved toast', async () => {
    const { calls, toasts } = await saveWith({ success: true, status: { STRIPE_NB42_KEY: { set: true } }, isConfigured: true, containerSet: [note('STRIPE_NB42_KEY'), note('STRIPE_NB42_OTHER')] });
    expect(calls[1].method).toBe('PUT');
    expect(toasts).toEqual([
      [note('STRIPE_NB42_KEY').message, 'warning', { sticky: true }],
      [note('STRIPE_NB42_OTHER').message, 'warning', { sticky: true }],
      ['Custom credentials saved', 'success'],
    ]);
  });

  it('shows the saved toast alone when the answer has no notes', async () => {
    const { toasts } = await saveWith({ success: true, status: { STRIPE_NB42_KEY: { set: true } }, isConfigured: true });
    expect(toasts).toEqual([['Custom credentials saved', 'success']]);
  });
});
