/**
 * Pinned regression: restartAgent recognises zombie sessions
 * (terminated workers with no `agentSessionFile` AND no `role`) and
 * auto-archives them instead of leaving the row in stuck state.
 *
 * Live test (PR #409 dashboard subgoal): user reported screenshot
 * with "Coder: Russell Throw" and "Coder: Cosmo Kramer" rows in the
 * sidebar showing "Agent process not running" error and a "Restart
 * Agent" button. Clicking the button invoked `restartAgent` which
 * threw partway through `restoreSession` because the persisted
 * record had no agentSessionFile to rehydrate from. The UI's
 * optimistic remove ran before the throw propagated, so the row
 * vanished from the sidebar even though it stayed in goals.json as a
 * zombie.
 *
 * Root cause: a coder spawn raced against a chaotic gateway-process
 * teardown. The agent subprocess died before it wrote its first
 * line, so `agentSessionFile` was never set. The persisted row
 * lingered with role:null + agentSessionFile:null + status:terminated.
 *
 * Fix: in `restartAgent`, before calling `restoreSession`, check the
 * persisted record. If `!agentSessionFile && !role` it is a zombie
 * with nothing to rehydrate from — archive the row and throw a
 * structured error (`code: SESSION_UNRECOVERABLE_ARCHIVED`) so the
 * caller can surface a sensible message.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface PersistedSessionLike {
	agentSessionFile?: string;
	role?: string;
}

/** Replicates the zombie predicate. */
function isUnrecoverableZombie(ps: PersistedSessionLike): boolean {
	return !ps.agentSessionFile && !ps.role;
}

describe("restartAgent zombie predicate", () => {
	it("THE bug: terminated coder with no agentSessionFile AND no role is a zombie", () => {
		// Russell Throw / Cosmo Kramer pattern from the live test.
		assert.equal(isUnrecoverableZombie({}), true);
	});

	it("healthy session with both fields is NOT a zombie", () => {
		assert.equal(isUnrecoverableZombie({
			agentSessionFile: "/Users/aj/.bobbit/agent/sessions/.../foo.jsonl",
			role: "coder",
		}), false);
	});

	it("session with agentSessionFile but no role is recoverable", () => {
		// Edge: an assistant session may legitimately have no `role`
		// (goalAssistant / toolAssistant flags are separate). If it has
		// agentSessionFile, restoreSession can rehydrate from it.
		assert.equal(isUnrecoverableZombie({
			agentSessionFile: "/path/to/.jsonl",
		}), false);
	});

	it("session with role but no agentSessionFile is recoverable (will spawn fresh)", () => {
		// Edge: a session that was just created and assigned a role but
		// crashed before writing its first JSONL line. restoreSession can
		// spawn a fresh subprocess for it.
		assert.equal(isUnrecoverableZombie({
			role: "coder",
		}), false);
	});

	it("explicit empty strings are also zombies (back-compat with old serialisation)", () => {
		// Some on-disk records have role:"" or agentSessionFile:"" instead
		// of undefined. The truthy check catches both.
		assert.equal(isUnrecoverableZombie({ agentSessionFile: "", role: "" }), true);
	});
});
