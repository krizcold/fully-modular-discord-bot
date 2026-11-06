import { afterAll, describe, expect, it, vi } from 'vitest';
import { installStopHandler } from '../../src/bot/internalSetup/utils/dataManager';
import { decideBoot } from '../../src/bot/internalSetup/utils/maintenance';

// NB5 section 5, B1 (R3-C2): an operator stop during the boot pass runs the real stop handler, installed before the
// pass as src/bot/index.ts does. The stop runs once per process, so this file holds only this case.

const signals = process.listeners('SIGTERM');
afterAll(() => {
  for (const l of process.listeners('SIGTERM')) if (!signals.includes(l)) process.off('SIGTERM', l);
  for (const l of process.listeners('SIGINT')) process.off('SIGINT', l);
  vi.restoreAllMocks();
});

describe('B1: SIGTERM while decideBoot waits on its pass', () => {
  it('exits 0 within 1 s, with no stop step and no probe after the signal', async () => {
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
    const exits: Array<{ code: unknown; at: number }> = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exits.push({ code, at: Date.now() }); }) as typeof process.exit);
    installStopHandler();
    let probes = 0;
    const decision = decideBoot(() => {
      probes += 1;
      return new Promise(() => undefined);
    });
    let settled = false;
    void decision.then(() => { settled = true; });
    await vi.waitFor(() => expect(probes).toBe(1));

    const sentAt = Date.now();
    for (const l of process.listeners('SIGTERM')) if (!signals.includes(l)) (l as (signal: string) => void)('SIGTERM');
    await vi.waitFor(() => expect(exits).toHaveLength(1), { timeout: 1000, interval: 10 });
    expect(exits[0].code).toBe(0);
    expect(exits[0].at - sentAt).toBeLessThan(1000);
    expect(console.error).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(probes).toBe(1);
    expect(settled).toBe(false);
  });
});
