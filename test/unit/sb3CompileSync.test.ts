import { afterEach, describe, expect, it, vi } from 'vitest';

// The compile's flush of written files: `sync` on Linux, where production runs; Windows has no such command, so
// the scripted shell answers it as cmd.exe does.

const h = vi.hoisted(() => ({ commands: [] as string[] }));

vi.mock('child_process', async orig => {
  const real = await orig<typeof import('child_process')>();
  return {
    ...real,
    exec: (command: string, _options: unknown, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      h.commands.push(command);
      if (command === 'sync' && process.platform === 'win32') {
        const error = Object.assign(new Error('Command failed: sync'), { stdout: '', stderr: "'sync' is not recognized as an internal or external command" });
        callback(error, '', error.stderr);
        return;
      }
      callback(null, '', '');
    },
  };
});

vi.mock('../../src/bot/internalSetup/utils/pathHelpers', async orig => ({ ...(await orig<any>()), getBuildRoot: () => 'Z:/sb3-no-build-root' }));

import { recompileTypeScript } from '../../src/bot/internalSetup/utils/moduleReloader';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const asPlatform = (value: string) => Object.defineProperty(process, 'platform', { ...realPlatform, value });

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  h.commands = [];
});

describe('the compile flushes its output to disk only where a sync command exists', () => {
  it('on Windows runs tsc alone and answers success', async () => {
    asPlatform('win32');
    const result = await recompileTypeScript();
    expect(result).toMatchObject({ success: true, diagnostics: [] });
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toMatch(/tsc\.cmd" -p tsconfig\.json$/);
  });

  it('on Linux runs sync after tsc and answers success', async () => {
    asPlatform('linux');
    const result = await recompileTypeScript();
    expect(result).toMatchObject({ success: true, diagnostics: [] });
    expect(h.commands).toHaveLength(2);
    expect(h.commands[0]).toMatch(/tsc" -p tsconfig\.json$/);
    expect(h.commands[1]).toBe('sync');
  });
});
