// The time check of the run with no mutant after the reruns alone
// (mutation/README.md; touched.mjs control() runs it).
import fs from 'fs';
import path from 'path';

/**
 * Why a run with no mutant that passed still clears no timeout of the reruns:
 * a time could not be read; the clock stepped during this run or the reruns'
 * own run with no mutant (its wall time and its monotonic time disagree by more
 * than a second and a tenth), so the budget Stryker built from the reruns'
 * wall time is not what they took (a step of days overflows Node's timer, which
 * then holds each rerun to 1 ms); or this run did not fit in that budget
 * (`timeoutFactor` times the reruns' own run with no mutant, plus `timeoutMS`),
 * so the machine was as slow as the mutants seemed. '' when it fits.
 * runner.mjs leaves each run's wall time and monotonic time in its dir's
 * dry-ms.txt.
 * @param {string} reruns the reruns' report dir
 * @param {string} out this run's report dir
 * @param {{ timeoutFactor: number, timeoutMS: number }} budget
 */
export function pastBudget(reruns, out, { timeoutFactor, timeoutMS }) {
  /** @param {string} dir */
  const timesOf = dir => { try { return fs.readFileSync(path.join(dir, 'dry-ms.txt'), 'utf8').trim().split(/\s+/).map(Number); } catch { return []; } };
  const [rerunsWall, rerunsMono] = timesOf(reruns);
  const [wall, took] = timesOf(out);
  if (![rerunsWall, rerunsMono, wall, took].every(Number.isFinite)) return "its time, or the time of the reruns' own run with no mutant, could not be read";
  /**
   * @param {number} a
   * @param {number} b
   */
  const stepped = (a, b) => Math.abs(a - b) > 1000 + 0.1 * Math.abs(b);
  if (stepped(rerunsWall, rerunsMono) || stepped(wall, took)) {
    return "the clock stepped during it or during the reruns' own run with no mutant, so the budget Stryker gave each rerun was not four times what they took";
  }
  const budget = timeoutFactor * rerunsWall + timeoutMS;
  if (took <= budget) return '';
  return `it took ${Math.round(took / 1000)} s, past the ${Math.round(budget / 1000)} s Stryker gave each rerun, so the machine was too slow then to tell a slow mutant from a slow run`;
}
