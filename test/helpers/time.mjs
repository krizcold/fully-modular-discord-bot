// The factor on every test's time limits (each test, each hook, each child
// scenario step): 1, or 4 when the mutation gate reruns a mutant alone
// (mutation/runner.mjs sets SMDB_TEST_TIME_SCALE), so a rerun that times out
// means the mutant hangs, not that the machine was slow.
export const TIME_SCALE = Math.max(1, Number(process.env.SMDB_TEST_TIME_SCALE) || 1);
