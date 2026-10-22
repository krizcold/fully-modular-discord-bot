// The factor on the config's time limits (each test's and each hook's, and a
// child scenario step's default bound): 1, or 4 when the mutation gate reruns
// a mutant alone (mutation/runner.mjs sets SMDB_TEST_TIME_SCALE), so a rerun
// that times out means the mutant hangs or slows the tests that much, not that
// the machine was slow. A limit a test, hook or step sets itself is not scaled.
export const TIME_SCALE = Math.max(1, Number(process.env.SMDB_TEST_TIME_SCALE) || 1);

// How long one child scenario step may take (helpers/child.ts). The child
// tier's test limit is 15 steps (vitest.config.ts), so in a test of up to 14
// steps a step that hangs fails by this bound before the test's own limit.
export const STEP_MS = 20_000 * TIME_SCALE;
