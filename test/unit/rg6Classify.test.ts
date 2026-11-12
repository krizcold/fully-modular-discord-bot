import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PostgresBackend, commitMayHaveLanded, commitRolledBack, isSilence,
} from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import type { DatabaseChooser } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

const URL = 'postgres://nobody@127.0.0.1:9/none';
const backends: PostgresBackend[] = [];

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.stop();
  vi.restoreAllMocks();
});

function quietChooser(): DatabaseChooser {
  return {
    chosen: () => URL,
    awaitChoice: async () => URL,
    lastPassLogin: () => 'unreachable',
    holdStarted() {},
    confirmNow() {},
    stop() {},
  };
}

function made(): PostgresBackend {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const backend = new PostgresBackend({ chooser: quietChooser() });
  backends.push(backend);
  return backend;
}

const serverError = (severity: string, code: string, message = 'server said no') => Object.assign(new Error(message), { severity, code });
const socketError = (code: string, message = 'socket failed') => Object.assign(new Error(message), { code });

describe('whether a failed COMMIT may have landed', () => {
  it('counts a FATAL or PANIC outside the session classes as possibly landed', () => {
    expect(commitMayHaveLanded(serverError('FATAL', '42601'))).toBe(true);
    expect(commitMayHaveLanded(serverError('PANIC', '42601'))).toBe(true);
    expect(commitMayHaveLanded(serverError('ERROR', '42601'))).toBe(false);
  });

  it('counts a class only at the start of the SQLSTATE', () => {
    expect(commitMayHaveLanded(serverError('ERROR', '42708'))).toBe(false);
    expect(commitMayHaveLanded(serverError('ERROR', '08006'))).toBe(true);
  });

  it('reads a rollback only for an answered error whose class is not 53 at its start', () => {
    expect(commitRolledBack(serverError('ERROR', '42153'))).toBe(true);
    expect(commitRolledBack(serverError('ERROR', '53300'))).toBe(false);
  });
});

describe('which failures are silence', () => {
  it('counts a FATAL that ended a running session as silence', () => {
    expect(isSilence(serverError('FATAL', 'XX000'))).toBe(true);
  });

  it('does not count an answered error as silence', () => {
    expect(isSilence(serverError('ERROR', '42501'))).toBe(false);
  });
});

describe('the cause a hold names', () => {
  it('names a refused certificate only for a code that starts with a certificate code', () => {
    const backend = made();
    backend.noteObservation(socketError('ERR_UNKNOWN_CERT_STORE'), backend.databaseEpoch());
    expect(backend.holdWords()).toMatch(/^the database did not answer; /);
  });

  it('does not read a longer code as DEPTH_ZERO_SELF_SIGNED_CERT', () => {
    const backend = made();
    backend.noteObservation(socketError('DEPTH_ZERO_SELF_SIGNED_CERTIFICATE'), backend.databaseEpoch());
    expect(backend.holdWords()).toMatch(/^the database did not answer; /);
  });

  it('names DEPTH_ZERO_SELF_SIGNED_CERT itself as a refused certificate', () => {
    const backend = made();
    backend.noteObservation(socketError('DEPTH_ZERO_SELF_SIGNED_CERT'), backend.databaseEpoch());
    expect(backend.holdWords()).toMatch(/^the database's certificate was refused \(DEPTH_ZERO_SELF_SIGNED_CERT\); /);
  });

  it('starts no hold for a login FATAL whose class is only inside its SQLSTATE', () => {
    const backend = made();
    backend.noteObservation(serverError('FATAL', 'XX008'), backend.databaseEpoch(), true);
    expect(backend.holdWords()).toBeNull();
  });

  it('starts the hold for a login FATAL of class 08', () => {
    const backend = made();
    backend.noteObservation(serverError('FATAL', '08006'), backend.databaseEpoch(), true);
    expect(backend.holdWords()).toMatch(/^the database did not answer; /);
  });
});
