/**
 * Side-effect opt-in for tier-1 specs that own command-step bookkeeping rather
 * than OS process fidelity. Import this module before in-process-harness.ts so
 * the fork-local flag is set before the gateway singleton boots and injects the
 * non-spawning verification command-step runner.
 */
(globalThis as { __BOBBIT_V2_FAKE_CMD_STEP__?: boolean }).__BOBBIT_V2_FAKE_CMD_STEP__ = true;

// Retained-log cap behavior does not need multi-megabyte subprocess output.
// Keeping the cap small lets fake-runner suites exercise identical truncation
// metadata with a bounded in-memory scripted chunk.
process.env.BOBBIT_RETAINED_LOG_MAX_BYTES ??= String(128 * 1024);
