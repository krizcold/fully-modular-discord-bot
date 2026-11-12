import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { _resetMemoryReading, heartbeatMemory, setupMemoryIpc } from '../../src/utils/memoryReading';

const before = process.listeners('message');
const data = { room: true, useMb: 1, freeMb: 2, ageMs: 0 };
const emit = (m: unknown) => process.emit('message' as any, m as any);

afterEach(() => _resetMemoryReading());

afterAll(() => {
  for (const listener of process.listeners('message')) {
    if (!before.includes(listener)) process.removeListener('message', listener);
  }
});

describe('the memory IPC listener', () => {
  it('installs one listener however often it is set up', () => {
    setupMemoryIpc();
    setupMemoryIpc();
    setupMemoryIpc();
    expect(process.listenerCount('message')).toBe(before.length + 1);
  });

  it('keeps the data of a memory:reading message', () => {
    setupMemoryIpc();
    emit({ type: 'memory:reading', data });
    expect(heartbeatMemory()).toMatchObject({ room: true, useMb: 1, freeMb: 2, error: null });
  });

  it('keeps nothing from a message of another type', () => {
    setupMemoryIpc();
    emit({ type: 'memory:other', data });
    expect(heartbeatMemory()).toBeNull();
  });

  it('keeps nothing from a function that carries the type and data', () => {
    setupMemoryIpc();
    emit(Object.assign(() => undefined, { type: 'memory:reading', data }));
    expect(heartbeatMemory()).toBeNull();
  });
});
