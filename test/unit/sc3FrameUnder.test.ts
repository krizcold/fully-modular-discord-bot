import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { frameUnder } from '../../src/bot/internalSetup/utils/moduleCrashes';

describe('frameUnder: a stack frame with no function name', () => {
  const dir = path.join(os.tmpdir(), 'sc3-frames', 'm');
  const errorAt = (column: string) => {
    const error = new Error('boom');
    error.stack = `Error: boom\n    at ${path.join(dir, 'index.js')}:10:${column}`;
    return error;
  };

  it('sc3 bare frame: a frame whose column has two digits names a file under the folder', () => {
    expect(frameUnder(errorAt('15'), dir)).toBe(true);
  });

  it('sc3 bare frame: a frame whose column has one digit names a file under the folder', () => {
    expect(frameUnder(errorAt('5'), dir)).toBe(true);
  });

  it('sc3 bare frame: a frame under another folder does not', () => {
    expect(frameUnder(errorAt('15'), path.join(os.tmpdir(), 'sc3-frames', 'other'))).toBe(false);
  });
});
