import { describe, expect, it } from 'vitest';

import { envKeysText } from '../../src/utils/envLoader';

describe('envKeysText: a key the changes object only inherits', () => {
  it('sc3 inherited key: a line whose key is only on the prototype of the changes is kept byte for byte', () => {
    const changes = Object.create({ FOO: 'inherited' }) as Record<string, string | null>;
    changes.BAR = '2';
    const text = 'FOO=old\nBAR=1\n';
    expect(envKeysText(text, changes)).toBe('FOO=old\nBAR=2\n');
  });
});
