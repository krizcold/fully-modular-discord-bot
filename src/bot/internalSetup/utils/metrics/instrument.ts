// Wraps a handler call with CPU + wall-clock measurement. cpuMicros and wallMicros
// are recorded separately and never summed. Pass-through when metrics are disabled.

import { getMetricsCollector, MetricKind } from './metricsCollector';
import { withModule } from '../dataBackends/writeLedger';

export async function instrument<T>(
  kind: MetricKind,
  guildId: string | null,
  moduleName: string | null | undefined,
  label: string,
  fn: () => T | Promise<T>
): Promise<T> {
  // The writes fn makes are recorded under its module in the entry's write ledger.
  const tagged = () => withModule(moduleName, fn);
  const collector = getMetricsCollector();
  if (!collector.isEnabled()) {
    return tagged();
  }
  const cpuStart = process.cpuUsage();
  const wallStart = process.hrtime.bigint();
  let errored = false;
  try {
    return await tagged();
  } catch (error) {
    errored = true;
    throw error;
  } finally {
    const cpu = process.cpuUsage(cpuStart);
    const wallMicros = Math.round(Number(process.hrtime.bigint() - wallStart) / 1000);
    collector.record(kind, guildId, moduleName ?? null, label, cpu.user + cpu.system, wallMicros, errored);
  }
}
