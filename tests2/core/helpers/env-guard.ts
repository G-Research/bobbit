/**
 * Per-file process.env leak guard for the v2-core suite.
 *
 * Tier-1 runs under pool:"forks" with isolate:false, so a single fork process is
 * reused across every test file it runs. Many migrated tests set env vars
 * (BOBBIT_DIR, BOBBIT_SECRETS_DIR, feature flags, …) at module scope or inside
 * tests. Without restoration those mutations LEAK into whichever file runs next
 * in the same fork, producing order-dependent, non-deterministic failures
 * (retries:0 turns those into hard flakes).
 *
 * `guardProcessEnv()` snapshots process.env at the moment it is called (place it
 * at the very top of a file's module body, BEFORE any top-level env mutation)
 * and registers an afterAll hook that restores the snapshot exactly — deleting
 * keys the file added and reverting keys the file changed, while preserving the
 * missing-vs-empty distinction. This is the file-scoped analogue of withEnv():
 * withEnv() scopes a single mutation; guardProcessEnv() backstops the whole file
 * so nothing bleeds across the fork boundary.
 */
import { afterAll } from "vitest";
import { resetAgentDirStateForTests } from "../../../src/server/agent-dir-config.js";

export function guardProcessEnv(): void {
	const snapshot = new Map<string, string | undefined>();
	for (const key of Object.keys(process.env)) snapshot.set(key, process.env[key]);

	afterAll(() => {
		// The agent-dir runtime is a module-memory singleton derived from
		// BOBBIT_DIR/BOBBIT_AGENT_DIR. Restoring env alone leaves its cache pointing
		// at this file's dir, so the NEXT file in the shared fork reads the wrong
		// auth.json/models.json. Invalidate it alongside the env restore.
		resetAgentDirStateForTests();
		// Delete keys added during the file.
		for (const key of Object.keys(process.env)) {
			if (!snapshot.has(key)) delete process.env[key];
		}
		// Restore keys that existed before (revert changes; re-add deletions).
		for (const [key, value] of snapshot) {
			if (value === undefined) {
				if (Object.prototype.hasOwnProperty.call(process.env, key)) delete process.env[key];
			} else if (process.env[key] !== value) {
				process.env[key] = value;
			}
		}
	});
}
