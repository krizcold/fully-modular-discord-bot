import { EventEmitter } from 'events';
import { vi } from 'vitest';

// The fork stand-in of nb2Restart.test.ts, shared by NB3's BotManager tests: a child that logs in and exits on a
// signal unless the test holds its exit.

export const forks = { children: [] as any[], exitCode: 0 as number | null, holdExit: false, onFork: null as null | ((child: any) => void) };
// Off: a new child prints no login line, as one booting slowly or into maintenance.
export const forkLogin = { on: true };

export function fakeFork(): any {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 2000 + forks.children.length;
  child.signals = [] as string[];
  child.send = vi.fn();
  child.kill = vi.fn((signal: string) => {
    child.signals.push(signal);
    child.killed = true;
    if (forks.holdExit) return true;
    setTimeout(() => {
      child.exitCode = forks.exitCode;
      child.emit('exit', forks.exitCode, null);
    }, 10);
    return true;
  });
  forks.children.push(child);
  forks.onFork?.(child);
  if (forkLogin.on) setTimeout(() => child.stdout.emit('data', Buffer.from('Logged in as test#0001!\n')), 5);
  return child;
}

export function crash(child: any, code = 1): void {
  child.exitCode = code;
  child.emit('exit', code, null);
}
