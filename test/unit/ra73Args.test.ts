import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args';

describe('parseArgs boolean flags never consume the next token', () => {
  for (const name of ['json', 'wait', 'follow', 'help', 'emergency', 'force', 'webui', 'scan']) {
    it(`--${name} stays true and leaves the following positional alone`, () => {
      const parsed = parseArgs(['status', `--${name}`, 'bot-a']);
      expect(parsed.flags[name]).toBe(true);
      expect(parsed.positionals).toEqual(['status', 'bot-a']);
    });
  }

  it('a non-boolean flag takes the next token as its value', () => {
    const parsed = parseArgs(['--name', 'bot-a']);
    expect(parsed.flags.name).toBe('bot-a');
    expect(parsed.positionals).toEqual([]);
  });
});
