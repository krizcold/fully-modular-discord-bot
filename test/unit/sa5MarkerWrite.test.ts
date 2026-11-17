import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MARKER_FILE, writeFileMarker } from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';

afterEach(() => {
  fs.rmSync(MARKER_FILE, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('sa5: a backend marker write that fails', () => {
  it('logs that the marker was not written, with the error, and does not throw', () => {
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
    fs.mkdirSync(MARKER_FILE, { recursive: true });
    expect(() => writeFileMarker({ live: 'file', storeId: null, flippedAt: 1 })).not.toThrow();
    expect(fs.statSync(MARKER_FILE).isDirectory()).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe('[Data] Failed to write backend marker:');
    expect(errors[0][1]).toBeInstanceOf(Error);
  });
});
