import { afterEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ noticeCheck: undefined as string | undefined, calls: [] as unknown[][] }));
vi.mock('../../src/utils/envLoader', async orig => {
  const real = await orig<typeof import('../../src/utils/envLoader')>();
  return { ...real, loadCredentials: () => ({ ...real.loadCredentials(), DATA_NOTICE_CHECK: mocked.noticeCheck }) };
});
vi.mock('../../src/utils/ownerMessages', async orig => {
  const real = await orig<typeof import('../../src/utils/ownerMessages')>();
  return {
    ...real,
    readNewestNotice: async (...args: unknown[]) => {
      mocked.calls.push(args);
      return { kind: 'none' };
    },
  };
});

import { _setWebuiChoiceDeps, webuiChoiceDeps } from '../../src/webui/utils/webuiDataReader';

afterEach(() => {
  mocked.noticeCheck = undefined;
  mocked.calls.length = 0;
});

describe("ra77: the web UI's real notice read and DATA_NOTICE_CHECK", () => {
  it('the own read asks for the own read with the 40 s budget; the other read asks for the default', async () => {
    _setWebuiChoiceDeps(null);
    await webuiChoiceDeps().readNotice(true);
    await webuiChoiceDeps().readNotice(false);
    expect(mocked.calls).toEqual([[{ own: true, budgetMs: 40_000 }], []]);
  });

  it('DATA_NOTICE_CHECK unset or empty leaves the check on', () => {
    _setWebuiChoiceDeps(null);
    mocked.noticeCheck = undefined;
    expect(webuiChoiceDeps().noticeCheckOff()).toBe(false);
    mocked.noticeCheck = '';
    expect(webuiChoiceDeps().noticeCheckOff()).toBe(false);
  });

  it('DATA_NOTICE_CHECK off in any case and with blanks turns the check off', () => {
    _setWebuiChoiceDeps(null);
    mocked.noticeCheck = 'off';
    expect(webuiChoiceDeps().noticeCheckOff()).toBe(true);
    mocked.noticeCheck = ' OFF ';
    expect(webuiChoiceDeps().noticeCheckOff()).toBe(true);
  });

  it('another value of DATA_NOTICE_CHECK leaves the check on', () => {
    _setWebuiChoiceDeps(null);
    mocked.noticeCheck = 'on';
    expect(webuiChoiceDeps().noticeCheckOff()).toBe(false);
  });
});
