// NB9 decision 41: one process id for the life of the OS process, read by every holder field NB4 and NB9 write or
// match. A random UUID holds no colon, so no process id equals a spread row's 'spread:<attempt>' holder (36).

import { randomUUID } from 'crypto';

let minted: string | null = null;

export function processId(): string {
  minted ??= randomUUID();
  return minted;
}
