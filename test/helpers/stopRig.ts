import type * as DataManager from '../../src/bot/internalSetup/utils/dataManager';

// The bot's one stop handler (dataManager's installStopHandler) with the claims wired as clientInitializer wires them:
// beginStop in a stop step, finishStop in a release step. The gateway, the samplers and the metric totals are absent.

type StopModule = Pick<typeof DataManager, 'addStopStep' | 'addFinalStopStep' | 'addReleaseStep' | 'installStopHandler' | 'beginStop' | '_resetStopHandler'>;

export interface StopRigDeps {
  claims: () => { beginStop(): void; finishStop(): Promise<unknown> } | null | undefined;
  /** Run as the last final step, right before the handler's own drain. */
  drain?: () => Promise<void>;
  /** Each step's name, in the order it ran. */
  order?: string[];
}

const EVENTS = ['SIGTERM', 'SIGINT', 'uncaughtException'] as const;

/**
 * Installs a fresh stop handler on dm (the original under a vi.mock of it outlives vi.resetModules) and answers a
 * function that starts the stop as a signal would. The process listeners the handler adds, at install and during
 * the stop (the exit drain's uncaughtException guard), are removed, so none outlives the rig.
 */
export function stopSteps(dm: StopModule, deps: StopRigDeps): () => Promise<void> {
  const mark = (name: string) => deps.order?.push(name);
  const emitter = process as unknown as { listeners(event: string): Function[]; off(event: string, listener: Function): void };
  const before = Object.fromEntries(EVENTS.map(event => [event, emitter.listeners(event)])) as Record<(typeof EVENTS)[number], Function[]>;
  const dropAdded = () => {
    for (const event of EVENTS) {
      for (const listener of emitter.listeners(event)) if (!before[event].includes(listener)) emitter.off(event, listener);
    }
  };
  dm._resetStopHandler();
  dm.addStopStep(() => { mark('beginStop'); deps.claims()?.beginStop(); });
  dm.addFinalStopStep(async () => { mark('drain'); await deps.drain?.(); });
  dm.addReleaseStep(async () => {
    mark('finishStop');
    try {
      await deps.claims()?.finishStop();
    } finally {
      dropAdded();
    }
  });
  dm.installStopHandler();
  dropAdded();
  return async () => {
    await dm.beginStop();
    mark('exit');
  };
}
