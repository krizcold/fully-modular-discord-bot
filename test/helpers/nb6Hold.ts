import type { DatabaseChooser, PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

// NB5's chooser as the backend sees it, for rows that need the hold to last: a hold the backend enters stays until
// the row calls release(), as the watch confirms the entry; confirms counts the drain's confirmNow calls.

export interface Hold {
  confirms: number;
  epochs: number[];
  release(): void;
}

export function installHoldingChooser(backend: PostgresBackend): Hold {
  const url = 'postgres://nobody@127.0.0.1:9/none';
  const hold: Hold = {
    confirms: 0,
    epochs: [],
    release() {
      const epoch = hold.epochs[hold.epochs.length - 1];
      backend.noteEntryAnswered(epoch);
      backend.confirmHold(epoch);
    },
  };
  const chooser: DatabaseChooser = {
    chosen: () => url,
    awaitChoice: async () => url,
    lastPassLogin: () => 'unreachable',
    holdStarted(_b, epoch) {
      hold.epochs.push(epoch);
    },
    confirmNow() {
      hold.confirms += 1;
    },
    stop() {},
  };
  (backend as unknown as { chooser: DatabaseChooser }).chooser = chooser;
  return hold;
}
