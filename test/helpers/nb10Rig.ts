import fs from 'fs';
import { vi } from 'vitest';
import { BotManager } from '../../src/webui/botManager';
import { configureWriterLock, releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { forkLogin, forks, forkStage } from './forkMock';

// NB10's rig for a real BotManager in front of the forkMock child: the test files mock child_process with fakeFork and
// updateSafety, as nb10Route.test.ts does. A child answers each request through a handler the test gives it.

export interface Sent { type: string; requestId?: string; data?: any }

/** Every message BotManager sent this child, of one type when given. */
export function sentTo(child: any, type?: string): Sent[] {
  const all = (child.send.mock.calls as any[][]).map(c => c[0] as Sent);
  return type ? all.filter(m => m.type === type) : all;
}

/** The child answers each request with the handler's value; undefined leaves it unanswered. */
export function answering(child: any, handler: (message: Sent) => unknown): void {
  child.send = vi.fn((message: Sent) => {
    if (message?.requestId) {
      void Promise.resolve(handler(message)).then(data => {
        if (data !== undefined) child.emit('message', { requestId: message.requestId, data });
      });
    }
    return true;
  });
}

export const report = (child: any, data: object): void => { child.emit('message', { type: 'data:writer', data }); };

export const tick = (ms = 5): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** A free writer lock, its depth 0, and this process configured with a role and the live pids given. */
export function freshWriterLock(role: 'webui' | 'bot' | 'import' = 'webui', live: Set<number> = new Set([process.pid])): void {
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  fs.rmSync(`${writerLockPath()}.takeover`, { recursive: true, force: true });
  configureWriterLock(role, { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
}

export function resetForks(): void {
  forks.children.length = 0;
  forks.exitCode = 0;
  forks.holdExit = false;
  forks.onFork = null;
  forkLogin.on = true;
  forkStage.stages = [];
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
}

/** A started BotManager whose child reported the stages given (none: it has not opened its data files). */
export async function startedWith(stages: object[], manager = new BotManager()): Promise<{ manager: BotManager; child: any }> {
  forkStage.stages = [];
  forks.onFork = child => { setTimeout(() => { for (const data of stages) report(child, data); }, 1); };
  forks.holdExit = true;
  await manager.start();
  forks.onFork = null;
  const child = forks.children.at(-1);
  await tick();
  return { manager, child };
}

/** The child exits with this code, as the real one would after a stop. */
export function exitChild(child: any, code: number | null = 0): void {
  child.exitCode = code;
  child.emit('exit', code, null);
}

export const quiet = (): void => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
};

export const logged = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map(c => c.map(String).join(' '));
