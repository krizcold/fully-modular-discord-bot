import { afterEach, expect, it } from 'vitest';
import fs from 'fs';
import { crashFilePath, endStart, keptEnds, retryKeptEnds, startModule, type ModuleStart } from '../../src/bot/internalSetup/utils/moduleCrashes';

afterEach(() => {
  process.removeListener('exit', retryKeptEnds);
  fs.rmSync(crashFilePath(), { recursive: true, force: true });
});

it('a start whose crash line cannot be deleted arms the exit retry the first time in a fresh process', async () => {
  fs.mkdirSync(crashFilePath(), { recursive: true });
  const start = startModule('ra52arm', 'sha-arm', '1.0.0', '/nowhere') as ModuleStart;
  expect(typeof start).toBe('object');
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    await endStart(start, 'ok');
  } finally {
    console.error = orig;
  }
  expect(errors.some(e => e.startsWith('[Error] The module crash count could not be written'))).toBe(true);
  expect(keptEnds.get('ra52arm')).toBe('sha-arm');
  expect(process.listeners('exit')).toContain(retryKeptEnds);
});
