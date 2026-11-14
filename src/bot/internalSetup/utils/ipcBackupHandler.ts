import { addStopStep, isStopping } from './dataManager';
import { containerPath, onFolderSyncFlag } from './folderChain';
import { abortRunningTake, takeSnapshot, type TakeAnswer, type TakeKind } from './backups/snapshotTake';

let installed = false;

/** The answer to one `backup:take`; a stop that has begun answers `stopping` without a take. */
export async function answerBackupTake(data: unknown): Promise<TakeAnswer> {
  if (isStopping()) return { ok: false, stopping: true };
  const req = (data ?? {}) as { name?: unknown; kind?: unknown };
  const name = typeof req.name === 'string' ? req.name : '';
  const kind = req.kind === 'daily' ? 'daily' : 'hourly';
  return takeSnapshot({ name, kind: kind as TakeKind });
}

/**
 * Decision 32: `backup:take` beside the early shared handler, in a normal boot and in a maintenance boot, with the take's
 * stop step. A first folder sync error whose record this process could not write is sent to the web UI (H1, I3, N1).
 */
export function setupBackupIPC(): void {
  if (installed || !process.send) return;
  installed = true;
  addStopStep(() => abortRunningTake());
  onFolderSyncFlag(write => {
    if (write.recorded) return;
    try {
      process.send?.({ type: 'disk:folder-sync-failed', data: { dir: containerPath(write.flag.dir), errno: write.flag.errno, at: write.flag.at } });
    } catch (error) {
      console.error('[Backup] Could not report the disk error to the web UI:', error);
    }
  });
  process.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const { type, requestId, data } = message as { type?: unknown; requestId?: unknown; data?: unknown };
    if (type !== 'backup:take' || typeof requestId !== 'string' || !requestId) return;
    void answerBackupTake(data)
      .catch((error: unknown): TakeAnswer => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      .then(answer => {
        try {
          process.send?.({ requestId, data: answer });
        } catch (error) {
          console.error('[Backup] Could not send the backup answer to the web UI:', error);
        }
      });
  });
}

/** Tests only: lets a fresh registration run in the same module copy. */
export function _resetBackupIPCForTests(): void {
  installed = false;
}
