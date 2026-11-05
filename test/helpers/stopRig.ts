import { runStopSteps, type StopSteps } from '../../src/bot/internalSetup/utils/stopSteps';

// clientInitializer's stop handler body: the real runStopSteps over the steps it passes, the claims, the drain and the
// exit wired as it wires them. The gateway, the samplers and the metric totals are absent in these tests.

export interface StopRigDeps {
  claims: () => { beginStop(): void; finishStop(): Promise<unknown> } | null | undefined;
  drainForExit: (boundMs: number) => Promise<void>;
  hasWorkingSet: () => boolean;
  /** Each step's name, in the order it ran. */
  order?: string[];
  over?: Partial<StopSteps>;
}

export function stopSteps(deps: StopRigDeps): () => Promise<void> {
  const mark = (name: string) => deps.order?.push(name);
  return () => runStopSteps({
    beginStop: () => { mark('beginStop'); deps.claims()?.beginStop(); },
    stopSamplers: () => { mark('stopSamplers'); },
    closeGateway: async () => { mark('closeGateway'); },
    flushTotals: () => { mark('flushTotals'); },
    drain: async () => { mark('drain'); await deps.drainForExit(deps.hasWorkingSet() ? 30000 : 5000); },
    finishStop: async () => { mark('finishStop'); await deps.claims()?.finishStop(); },
    exit: code => { mark('exit'); process.exit(code); },
    ...deps.over,
  });
}
