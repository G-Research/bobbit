/**
 * Side-effect opt-in for tier-1 specs that own command-step bookkeeping rather
 * than OS process fidelity. Import this module before in-process-harness.ts so
 * the fork-local flag is set before the gateway singleton boots and injects the
 * non-spawning verification command-step runner.
 */
import type { ManualClock } from "../../harness/clock.js";

const FAKE_CMD_STEP_KEY = Symbol.for("bobbit.tests2.fakeCommandStepEnabled");
type FakeCommandStepGlobal = typeof globalThis & {
	__BOBBIT_V2_FAKE_CMD_STEP__?: boolean;
	[FAKE_CMD_STEP_KEY]?: true;
};
const fakeGlobal = globalThis as FakeCommandStepGlobal;
fakeGlobal.__BOBBIT_V2_FAKE_CMD_STEP__ = true;
fakeGlobal[FAKE_CMD_STEP_KEY] = true;

// Retained-log cap behavior does not need multi-megabyte subprocess output.
// Keeping the cap small lets fake-runner suites exercise identical truncation
// metadata with a bounded in-memory scripted chunk.
process.env.BOBBIT_RETAINED_LOG_MAX_BYTES ??= String(128 * 1024);

/**
 * Drain cancellation closes and due gateway timers at test boundaries. The fake
 * runner deliberately models process events asynchronously; without this drain,
 * a close queued by one test can be observed during the next test in a shared
 * non-isolated integration fork.
 */
export async function resetFakeCommandStepTestState(clock: ManualClock): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	clock.advance(0);
	await new Promise<void>((resolve) => setImmediate(resolve));
}
