import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The mutation gate draws one seed per run (SMDB_TEST_SEED, read by
// helpers/setup.ts), so a property draws the same inputs with a mutant as
// without one. unit/mutationRunner.test.ts runs this file under a seed.
describe('the property seed', () => {
  it("is the gate's when it set one, and fast-check's own otherwise", () => {
    const seed = process.env.SMDB_TEST_SEED;
    expect(fc.readConfigureGlobal().seed).toBe(seed ? Number(seed) : undefined);
    if (seed) expect(fc.sample(fc.integer(), 5)).toEqual(fc.sample(fc.integer(), 5));
  });
});
