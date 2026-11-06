import type { DatabaseChooser, PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

// NB5 (sheet section 6): a chooser that answers one entry at once and confirms a hold on the next timer turn, with no
// probe, so a test built on one URL keeps one line, and an outage row still sees the hold right after the failure.

export function fixedChooser(url: string): DatabaseChooser {
  let stopped = false;
  return {
    chosen: () => url,
    awaitChoice: async () => (stopped ? null : url),
    lastPassLogin: () => 'unreachable',
    holdStarted(backend: PostgresBackend, epoch: number) {
      setTimeout(() => {
        if (stopped || backend.databaseEpoch() !== epoch) return;
        backend.noteEntryAnswered(epoch);
        backend.confirmHold(epoch);
      }, 0);
    },
    confirmNow() {},
    stop() {
      stopped = true;
    },
  };
}

export function fixedDatabase(url: string): { chooser: DatabaseChooser } {
  return { chooser: fixedChooser(url) };
}
