// The time check of the run with no mutant after the reruns alone
// (mutation/README.md; touched.mjs control() runs it).
import fs from 'fs';
import path from 'path';

/**
 * Why a run with no mutant that passed still clears no timeout of the reruns:
 * it did not fit in the budget Stryker gave each rerun (`timeoutFactor` times
 * the reruns' own run with no mutant, plus `timeoutMS`), so the machine was as
 * slow as the mutants seemed; or a time could not be read. '' when it fits.
 * runner.mjs leaves the time of each run with no mutant in its dir's dry-ms.txt,
 * by the wall clock and then by a monotonic one. The budget is built from the
 * reruns' wall time, as Stryker built it; this run is held to it by its
 * monotonic time, as Stryker's timer holds a rerun, so no clock step moves it.
 * @param {string} reruns the reruns' report dir
 * @param {string} out this run's report dir
 * @param {{ timeoutFactor: number, timeoutMS: number }} budget
 */
export function pastBudget(reruns, out, { timeoutFactor, timeoutMS }) {
  /**
   * @param {string} dir
   * @param {number} at 0 for the wall time, 1 for the monotonic one
   */
  const msOf = (dir, at) => { try { return Number(fs.readFileSync(path.join(dir, 'dry-ms.txt'), 'utf8').trim().split(/\s+/)[at]); } catch { return NaN; } };
  const took = msOf(out, 1);
  const budget = timeoutFactor * msOf(reruns, 0) + timeoutMS;
  if (took <= budget) return '';
  if (!Number.isFinite(took) || !Number.isFinite(budget)) return "its time, or the time of the reruns' own run with no mutant, could not be read";
  return `it took ${Math.round(took / 1000)} s, past the ${Math.round(budget / 1000)} s Stryker gave each rerun, so the machine was too slow then to tell a slow mutant from a slow run`;
}
