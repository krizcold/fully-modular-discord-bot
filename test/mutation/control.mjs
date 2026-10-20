// The time check of the run with no mutant after the reruns alone
// (mutation/README.md; touched.mjs control() runs it).
import fs from 'fs';
import path from 'path';

/**
 * Why a run with no mutant that passed still clears no timeout of the reruns:
 * a time could not be read; Stryker's own time for the reruns' run with no
 * mutant (targets.mjs leaves it in dry-timing.json) does not match that run's
 * monotonic time, by more than a second plus a tenth of it, so the clock of
 * Stryker's process stepped and the budget it built is not what the reruns
 * took (a step of days overflows Node's timer, which then holds each rerun to
 * 1 ms); or this run's monotonic time did not fit in that budget
 * (`timeoutFactor` times Stryker's net time, plus `timeoutMS`, plus its
 * overhead, as Stryker built it), so the machine was as slow as the mutants
 * seemed. '' when it fits. runner.mjs leaves each run's monotonic time in its
 * dir's dry-ms.txt.
 * @param {string} reruns the reruns' report dir
 * @param {string} out this run's report dir
 * @param {{ timeoutFactor: number, timeoutMS: number }} budget
 */
export function pastBudget(reruns, out, { timeoutFactor, timeoutMS }) {
  /** @param {string} dir */
  const msOf = dir => { try { const text = fs.readFileSync(path.join(dir, 'dry-ms.txt'), 'utf8').trim(); return text === '' ? NaN : Number(text); } catch { return NaN; } };
  /** @type {{ net?: unknown, overhead?: unknown }} */
  let timing = {};
  try { timing = JSON.parse(fs.readFileSync(path.join(reruns, 'dry-timing.json'), 'utf8')) ?? {}; } catch { timing = {}; }
  const [net, overhead, rerunsTook, took] = [Number(timing.net), Number(timing.overhead), msOf(reruns), msOf(out)];
  if (![net, overhead, rerunsTook, took].every(Number.isFinite)) return "its time, or the time of the reruns' own run with no mutant, could not be read";
  const margin = 1000 + 0.1 * Math.abs(rerunsTook);
  if (Math.abs(net - rerunsTook) > margin || overhead < 0 || overhead > margin) {
    return "Stryker's own time for the reruns' run with no mutant does not match that run's monotonic time, so the clock of Stryker's process stepped and the budget it gave each rerun was not four times what they took";
  }
  const budget = timeoutFactor * net + timeoutMS + overhead;
  if (took <= budget) return '';
  return `it took ${Math.round(took / 1000)} s, past the ${Math.round(budget / 1000)} s Stryker gave each rerun, so the machine was too slow then to tell a slow mutant from a slow run`;
}
