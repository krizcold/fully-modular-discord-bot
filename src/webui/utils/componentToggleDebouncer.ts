/**
 * Component Toggle Debouncer
 *
 * Per-key trailing-edge debounce for component toggles.
 * Rapid toggles on the same component collapse into a single execution
 * of the final state after a silence period.
 *
 * Example: off→on→off→on→off in quick succession → single "off" after 1.5s
 */

interface PendingToggle {
  timer: ReturnType<typeof setTimeout>;
  finalEnabled: boolean;
}

export class ComponentToggleDebouncer {
  private pending: Map<string, PendingToggle> = new Map();
  private delayMs: number;

  constructor(delayMs: number = 1500) {
    this.delayMs = delayMs;
  }

  /**
   * Schedule a toggle. If one is already pending for this key,
   * cancel it and reschedule with the new state.
   * The action callback fires once after the debounce settles.
   */
  debounce(
    key: string,
    enabled: boolean,
    action: (enabled: boolean) => Promise<void>
  ): void {
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(async () => {
      this.pending.delete(key);
      try {
        await action(enabled);
      } catch (err) {
        console.error(`[ToggleDebouncer] Action failed for ${key}:`, err);
      }
    }, this.delayMs);

    this.pending.set(key, { timer, finalEnabled: enabled });
  }

  /**
   * Cancel all pending toggles (for shutdown).
   */
  cancelAll(): void {
    for (const { timer } of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }
}
