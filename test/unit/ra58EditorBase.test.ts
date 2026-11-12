import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDITOR_BASE_LIFE_MS, rememberBase, takeBase } from '../../src/bot/internalSetup/utils/panel/editorBase';

// NB6 decision 50: a Discord editor's remembered base, kept for an interaction's life and taken once.

const T0 = 1_800_000_000_000;
let n = 0;
const fresh = (): [string, string, string] => {
  n += 1;
  return [`user-${n}`, `panel-${n}`, `file-${n}.json`];
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the remembered editor bases', () => {
  it("remembering one user's base keeps another user's fresh base", () => {
    const a = fresh();
    const b = fresh();
    rememberBase(...a, 'sha-a');
    vi.setSystemTime(T0 + 1000);
    rememberBase(...b, 'sha-b');
    expect(takeBase(...a)).toBe('sha-a');
    expect(takeBase(...b)).toBe('sha-b');
  });

  it('a base exactly one interaction life old survives a later remember and is still taken', () => {
    const a = fresh();
    const b = fresh();
    rememberBase(...a, 'sha-a');
    vi.setSystemTime(T0 + EDITOR_BASE_LIFE_MS);
    rememberBase(...b, 'sha-b');
    expect(takeBase(...a)).toBe('sha-a');
  });

  it('a base exactly one interaction life old is taken', () => {
    const a = fresh();
    rememberBase(...a, 'sha-a');
    vi.setSystemTime(T0 + EDITOR_BASE_LIFE_MS);
    expect(takeBase(...a)).toBe('sha-a');
  });

  it('a base past its life is gone', () => {
    const a = fresh();
    rememberBase(...a, 'sha-a');
    vi.setSystemTime(T0 + EDITOR_BASE_LIFE_MS + 1);
    expect(takeBase(...a)).toBeNull();
  });

  it('an expired base dropped by a later remember stays gone when the clock is set back', () => {
    const a = fresh();
    const b = fresh();
    rememberBase(...a, 'sha-a');
    vi.setSystemTime(T0 + EDITOR_BASE_LIFE_MS + 1);
    rememberBase(...b, 'sha-b');
    vi.setSystemTime(T0 + 1000);
    expect(takeBase(...a)).toBeNull();
  });

  it('a base is taken once: a second submit finds none', () => {
    const a = fresh();
    rememberBase(...a, 'sha-a');
    expect(takeBase(...a)).toBe('sha-a');
    expect(takeBase(...a)).toBeNull();
  });
});
