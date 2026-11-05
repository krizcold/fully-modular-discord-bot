// NB4 decisions 12 and 19: the steps of the one way the bot process ends on purpose, in their order.

export interface StopSteps {
  beginStop(): void;
  stopSamplers(): void;
  closeGateway(): Promise<unknown>;
  flushTotals(): void;
  drain(): Promise<unknown>;
  finishStop(): Promise<unknown>;
  exit(code: number): void;
}

/** The claims lane renews through the gateway close and the drain, then releases; a step that throws still exits. */
export async function runStopSteps(steps: StopSteps): Promise<void> {
  try {
    steps.beginStop();
    steps.stopSamplers();
    // No event is handled while the writes drain. Bounded, since a destroy stalls on a shard caught mid-connect.
    await Promise.race([
      steps.closeGateway().catch(err => console.warn('[clientInitializer] Could not close the gateway on shutdown:', err)),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]);
    // It writes through saveData, so it runs before the drain.
    steps.flushTotals();
    await steps.drain();
    await steps.finishStop();
  } catch (error) {
    console.error('[clientInitializer] A stop step failed; the bot process exits:', error);
  } finally {
    steps.exit(0);
  }
}
