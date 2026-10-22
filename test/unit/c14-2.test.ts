import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('System Info versions', () => {
  it.skipIf(process.env.__STRYKER_ACTIVE_MUTANT__ !== undefined)('renders the loaded discord.js version, not a literal', () => {
    const src = readFileSync(path.join(__dirname, '../../src/bot/internalSetup/panels/systemInfo.ts'), 'utf8');
    expect(src).not.toMatch(/Discord\.js:\*\* v\d/);
    expect(src).toMatch(/Discord\.js:\*\* v\$\{discordJsVersion\}/);
  });
});
