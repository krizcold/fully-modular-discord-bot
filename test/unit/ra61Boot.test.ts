import { afterEach, describe, expect, it } from 'vitest';
import { sharedBootCause, sharedBootCauseLocal, sharedBootDone } from '../../src/bot/internalSetup/utils/sharedMirror';
import { setBackendKind } from '../helpers/backendKind';

// L5 run A, chunk 61: a Postgres bot process that has not run bootShared yet serves no shared op (C24). The module's
// state is read as it loads, so this file never resets it.

afterEach(() => setBackendKind(null));

describe('C24 before the boot pass', () => {
  it('a Postgres process that never ran bootShared is not done booting', () => {
    setBackendKind('postgres');
    expect(sharedBootDone()).toBe(false);
    expect(sharedBootCause()).toBeNull();
    expect(sharedBootCauseLocal()).toBe(false);
  });
});
