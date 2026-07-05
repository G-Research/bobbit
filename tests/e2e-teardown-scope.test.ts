import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pin: the E2E global teardown's Docker reaper must stay scoped to
 * E2E-owned bind patterns and must never match manual-integration
 * containers (`.bobbit-manual*`).
 *
 * Why: E2E and manual-integration runs overlap on shared dev machines
 * (multiple worktrees / agents). The manual suite's sandbox containers bind
 * `/…/.bobbit-manual-<port>/…` and stay live for minutes while a real agent
 * streams inside them via `docker exec`. When the E2E teardown reaped
 * `.bobbit-manual` binds, a concurrent `npm run test:e2e` finishing in
 * ANOTHER worktree force-removed the live container mid-turn: the agent
 * process exited 137 and the manual spec failed with `Session … terminated`.
 * Manual-suite debris is cleaned by the manual specs' own afterAll
 * cleanTestDockerContainers and by the next manual run — the E2E janitor
 * must not cover for it.
 */
describe("e2e-teardown docker reap scope", () => {
	it("never matches .bobbit-manual binds (manual suite owns its own cleanup)", () => {
		const src = readFileSync(join(import.meta.dirname, "e2e", "e2e-teardown.ts"), "utf-8");
		// Find the reap filter regex line(s) that gate `docker rm -f`.
		const filterLines = src.split("\n").filter((l) => l.includes(".test(binds)"));
		assert.ok(filterLines.length >= 1, "expected at least one binds filter in e2e-teardown.ts");
		for (const line of filterLines) {
			assert.ok(
				!line.includes("bobbit-manual"),
				`e2e-teardown reap filter must not match manual-suite binds — found: ${line.trim()}`,
			);
			assert.ok(
				line.includes(".e2e-"),
				`e2e-teardown reap filter should stay scoped to .e2e-* binds — found: ${line.trim()}`,
			);
		}
	});
});
