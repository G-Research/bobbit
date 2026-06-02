/**
 * Regression test for the dangling-rejection bug in ProjectSandbox.init().
 *
 * `init()` creates a dedicated `_readyPromise` whose only consumer is
 * `getContainerId()`. When init fails and nobody is concurrently awaiting
 * `getContainerId()`, the internal `_readyReject!(err)` rejects a promise that
 * NO ONE is awaiting — even though the awaited `init()` boundary already
 * observes the same error via `throw err`. That dangling rejection surfaces as
 * a global `unhandledRejection`, which under load can wedge the gateway for
 * unrelated sessions.
 *
 * This test drives `init()` down its failure path WITHOUT a real Docker daemon
 * by stubbing the private `_initContainer()` to throw. It awaits `init()`
 * inside a try/catch (so the awaited boundary observes the error), flushes
 * timers/microtasks, and asserts that ZERO `unhandledRejection` events fired.
 *
 * On the current branch this FAILS because `_readyPromise` is rejected with no
 * awaiter. After the fix (a no-op `.catch` attached to `_readyPromise`, or
 * equivalent), it passes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProjectSandbox } from "../src/server/agent/project-sandbox.js";

describe("ProjectSandbox.init() failure does not leak an unhandled rejection", () => {
	it("does not emit a global unhandledRejection when init fails", async () => {
		const sandbox = new ProjectSandbox({
			projectId: "test-rejection-project",
			projectDir: "/tmp/nonexistent-project",
			repoUrl: "file:///workspace-src",
			image: "bobbit-sandbox:nonexistent-test-image",
		});

		const FORCED = "forced init failure for dangling-rejection test";

		// Stub the private container-init step so we exercise the real init()
		// failure path deterministically without touching Docker. Assigning to
		// the instance shadows the prototype method; init() calls
		// `this._initContainer()` which resolves to this stub.
		(sandbox as unknown as { _initContainer: () => Promise<void> })._initContainer =
			async () => {
				throw new Error(FORCED);
			};

		const rejections: unknown[] = [];
		const listener = (reason: unknown) => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", listener);

		try {
			// The awaited boundary MUST observe the thrown error.
			let observed: Error | null = null;
			try {
				await sandbox.init();
			} catch (err) {
				observed = err as Error;
			}
			assert.ok(observed, "init() should reject on the awaited path");
			assert.match(String(observed?.message), new RegExp(FORCED));

			// Flush microtasks + timers so any dangling rejection has a chance to
			// surface to the global handler.
			await new Promise((r) => setTimeout(r, 100));

			assert.equal(
				rejections.length,
				0,
				`init() failure leaked ${rejections.length} unhandled rejection(s): ` +
					rejections.map((r) => (r instanceof Error ? r.message : String(r))).join(", "),
			);
		} finally {
			process.off("unhandledRejection", listener);
		}
	});
});
