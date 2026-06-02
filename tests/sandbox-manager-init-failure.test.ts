/**
 * Regression test: a failing sandbox bootstrap/init must not wedge the gateway.
 *
 * `SandboxManager.ensureForProject(projectId)` runs the bootstrap closure and,
 * on success, initialises a ProjectSandbox. The original bug surfaced sandbox
 * setup failures BOTH on the awaited boundary AND as a dangling global
 * `unhandledRejection`, which under load could make the gateway unreachable for
 * unrelated sessions.
 *
 * This pins three invariants using a stub bootstrap we control (no Docker):
 *   (a) the awaited `ensureForProject` call rejects with the bootstrap error;
 *   (b) NO global `unhandledRejection` fires while/after that failure;
 *   (c) the manager stays usable — a subsequent `ensureForProject` for a
 *       different project whose bootstrap returns `null` (sandbox not
 *       applicable) resolves without throwing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SandboxManager, type SandboxBootstrap } from "../src/server/agent/sandbox-manager.js";

describe("SandboxManager.ensureForProject failure isolation", () => {
	it("rejects on the awaited boundary, leaks no unhandledRejection, and stays usable", async () => {
		const BOOT_FAIL = "forced bootstrap failure local origin outside project root";

		// Stub bootstrap: throw for the broken project, return null (sandbox not
		// applicable) for any other project. Never returns real options, so we
		// never touch Docker.
		const bootstrap: SandboxBootstrap = async (projectId) => {
			if (projectId === "broken-project") {
				throw new Error(BOOT_FAIL);
			}
			return null;
		};

		const manager = new SandboxManager({ bootstrap });

		const rejections: unknown[] = [];
		const listener = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", listener);

		try {
			// (a) The awaited call must reject with the bootstrap error.
			await assert.rejects(
				() => manager.ensureForProject("broken-project"),
				new RegExp(BOOT_FAIL),
			);

			// Flush microtasks + timers so any dangling rejection can surface.
			await new Promise((r) => setTimeout(r, 100));

			// (b) No global unhandled rejection from the failed init.
			assert.equal(
				rejections.length,
				0,
				`failed sandbox init leaked ${rejections.length} unhandled rejection(s): ` +
					rejections.map((r) => (r instanceof Error ? r.message : String(r))).join(", "),
			);

			// (c) The manager is still usable for other projects.
			await assert.doesNotReject(() => manager.ensureForProject("healthy-other-project"));
			assert.equal(manager.has("healthy-other-project"), false, "null bootstrap registers nothing");

			// And the broken project can be retried (in-flight entry was cleared).
			await assert.rejects(
				() => manager.ensureForProject("broken-project"),
				new RegExp(BOOT_FAIL),
			);
			await new Promise((r) => setTimeout(r, 50));
			assert.equal(rejections.length, 0, "retry must not leak a rejection either");
		} finally {
			process.off("unhandledRejection", listener);
		}
	});
});
