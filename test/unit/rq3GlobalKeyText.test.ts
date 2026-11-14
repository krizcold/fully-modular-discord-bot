import { describe, expect, it } from 'vitest';
import { KEY_MAX_BYTES, globalKeyRefusal, globalTextRefusal } from '../../src/bot/internalSetup/utils/storableData';

function relOfBytes(total: number): string {
  const parts: string[] = [];
  let left = total;
  while (left > 0) {
    if (parts.length > 0) left -= 1;
    const n = Math.min(150, left);
    parts.push('a'.repeat(n));
    left -= n;
  }
  const rel = parts.join('/');
  expect(Buffer.byteLength(rel, 'utf8')).toBe(total);
  return rel;
}

describe('globalKeyRefusal measures the whole key as global/<rel>', () => {
  it('passes a key of exactly KEY_MAX_BYTES bytes counting the global/ prefix', () => {
    const rel = relOfBytes(KEY_MAX_BYTES - 'global/'.length);
    expect(globalKeyRefusal(rel)).toBeNull();
  });

  it('refuses a key one byte over, naming its size counted with the global/ prefix', () => {
    const rel = relOfBytes(KEY_MAX_BYTES - 'global/'.length + 1);
    expect(globalKeyRefusal(rel)).toBe(`the key is ${KEY_MAX_BYTES + 1} bytes; a key holds at most ${KEY_MAX_BYTES}`);
  });

  it('refuses a rel that fits alone but not with the global/ prefix', () => {
    const rel = relOfBytes(KEY_MAX_BYTES - 3);
    expect(globalKeyRefusal(rel, 'save')).toBe(`the key is ${KEY_MAX_BYTES + 4} bytes; a key holds at most ${KEY_MAX_BYTES}`);
  });
});

describe('globalKeyRefusal kind rule', () => {
  it('refuses an append to a file not ending in .jsonl, with the reason', () => {
    expect(globalKeyRefusal('mod/events.json', 'append')).toBe('an appended file must end in .jsonl');
  });

  it('passes an append to a .jsonl file and a save to a .json file', () => {
    expect(globalKeyRefusal('mod/events.jsonl', 'append')).toBeNull();
    expect(globalKeyRefusal('mod/events.json', 'save')).toBeNull();
    expect(globalKeyRefusal('mod/events.json')).toBeNull();
  });
});

describe('globalTextRefusal', () => {
  it('names a value that is not a string', () => {
    expect(globalTextRefusal(5)).toBe('the text is not a string');
    expect(globalTextRefusal({ a: 1 }, 'line')).toBe('the line is not a string');
  });
});
