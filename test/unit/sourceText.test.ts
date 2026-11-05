import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { readSourceText } from '../helpers/sourceText';

const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'source-text-'));
fs.mkdirSync(path.join(checkout, 'src', 'a'), { recursive: true });
fs.writeFileSync(path.join(checkout, 'src', 'a', 'b.ts'), 'export const b = 1;\n');
const sandbox = path.join(checkout, '.stryker-tmp', 'sandbox-abc');
fs.mkdirSync(path.join(sandbox, 'src', 'a'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'src', 'a', 'b.ts'), '// @ts-nocheck\nfunction stryNS_x() {}\n');
afterAll(() => fs.rmSync(checkout, { recursive: true, force: true }));

describe('readSourceText', () => {
  it('reads the checkout copy of a file in a mutation sandbox, with either separator', () => {
    expect(readSourceText(path.join(sandbox, 'test', 'unit'), '../../src/a/b.ts')).toBe('export const b = 1;\n');
    expect(readSourceText(checkout, '.stryker-tmp\\sandbox-abc\\src\\a\\b.ts')).toBe('export const b = 1;\n');
    expect(readSourceText(checkout, '.stryker-tmp/sandbox-abc/src/a/b.ts')).toBe('export const b = 1;\n');
  });

  it('reads a path outside a sandbox as it is', () => {
    expect(readSourceText(path.join(checkout, 'src'), 'a/b.ts')).toBe('export const b = 1;\n');
    fs.mkdirSync(path.join(checkout, '.stryker-tmp', 'other', 'src'), { recursive: true });
    fs.writeFileSync(path.join(checkout, '.stryker-tmp', 'other', 'src', 'c.ts'), 'other\n');
    expect(readSourceText(checkout, '.stryker-tmp/other/src/c.ts')).toBe('other\n');
  });

  it('throws when the checkout copy is missing', () => {
    fs.writeFileSync(path.join(sandbox, 'src', 'a', 'only.ts'), 'sandbox only\n');
    expect(() => readSourceText(sandbox, 'src/a/only.ts')).toThrow(/checkout copy .*only\.ts does not exist/);
  });
});
