import { describe, expect, it } from 'vitest';
import { readSourceText } from '../helpers/sourceText';

describe('System Info versions', () => {
  it.skipIf(process.env.__STRYKER_ACTIVE_MUTANT__ !== undefined)('renders the loaded discord.js version, not a literal', () => {
    const src = readSourceText(__dirname, '../../src/bot/internalSetup/panels/systemInfo.ts');
    expect(src).not.toMatch(/Discord\.js:\*\* v\d/);
    expect(src).toMatch(/Discord\.js:\*\* v\$\{discordJsVersion\}/);
  });
});
