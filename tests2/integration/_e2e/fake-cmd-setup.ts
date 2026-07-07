/**
 * vitest setupFile for the `v2-integration-fake` project ONLY.
 *
 * Sets a fork-local flag BEFORE any test file (and therefore before the
 * per-fork gateway singleton boots), so tests2/harness/gateway.ts injects the
 * non-spawning fake verification command-step runner. This project runs in its
 * own dedicated fork (see vitest.config.ts), so the flag never leaks into the
 * real-runner forks used by the default v2-integration project.
 */
(globalThis as { __BOBBIT_V2_FAKE_CMD_STEP__?: boolean }).__BOBBIT_V2_FAKE_CMD_STEP__ = true;
