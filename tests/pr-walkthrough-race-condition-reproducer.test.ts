import { it } from "node:test";
import assert from "node:assert/strict";

/**
 * Reproducer for the resolveAndReadBindingBundle race condition (Issue 4).
 *
 * Demonstrates that the OLD code pattern (no in-flight deduplication map) allows
 * concurrent reads for the same jobId to each independently call
 * resolveDiffForBindingTarget. Last write wins; if git yields a different file
 * ordering across calls the block indices in `block:N:path:hM` IDs differ,
 * producing hunk IDs that no longer resolve at finalization.
 *
 * This test is intentionally expected to FAIL — it proves the bug exists in the
 * unfixed pattern. The actual fix lives in src/server/pr-walkthrough/routes.ts
 * (resolvingBundlePromises mutex) and is verified by
 * tests/pr-walkthrough-hunk-id-roundtrip.test.ts.
 */

/**
 * Faithful copy of the OLD buggy lazy-init pattern in resolveAndReadBindingBundle,
 * before the resolvingBundlePromises mutex was added.
 */
async function resolveAndSaveWithoutMutex(
	jobId: string,
	bundleCache: Map<string, string>,
	resolveFunc: () => Promise<string>,
): Promise<void> {
	// OLD CODE: check-then-act with no in-flight deduplication.
	// All three concurrent awaits pass this check before any one saves.
	if (!bundleCache.get(jobId)) {
		const result = await resolveFunc();
		bundleCache.save ? bundleCache.save(jobId, result) : bundleCache.set(jobId, result);
	}
}

it(
	"race condition reproducer: without deduplication mutex, concurrent reads each call resolve independently",
	async () => {
		const bundleCache = new Map<string, string>();
		let resolveCallCount = 0;

		const resolveFunc = async (): Promise<string> => {
			resolveCallCount++;
			// Yield to the event loop so all three concurrent calls can start before any
			// one of them reaches the bundleCache.set() line — exactly what happens in
			// production when resolveDiffForBindingTarget does async git/network I/O.
			await new Promise<void>(resolve => setImmediate(resolve));
			return `bundle-${resolveCallCount}`;
		};

		// Three concurrent calls, none awaited before the next starts —
		// mirrors the three simultaneous read_pr_walkthrough_bundle calls in session cbd17443.
		await Promise.all([
			resolveAndSaveWithoutMutex("job-1", bundleCache, resolveFunc),
			resolveAndSaveWithoutMutex("job-1", bundleCache, resolveFunc),
			resolveAndSaveWithoutMutex("job-1", bundleCache, resolveFunc),
		]);

		// Assert: exactly 1 resolve call expected (deduplicated behaviour).
		// Without the mutex this assertion FAILS because resolveCallCount === 3,
		// proving each concurrent call independently invoked the resolution function.
		assert.equal(
			resolveCallCount,
			1,
			`Expected exactly 1 resolve call (deduplicated) but got ${resolveCallCount}. ` +
			`Demonstrates the race: without resolvingBundlePromises mutex, ` +
			`${resolveCallCount} concurrent reads each call resolveDiffForBindingTarget independently.`,
		);
	},
);
