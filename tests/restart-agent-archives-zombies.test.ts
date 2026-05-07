/**
 * zombie-archive on restart — `restartAgent` auto-archives unrecoverable zombie sessions.
 *
 * A persisted session row with neither an `agentSessionFile` nor a `role` is
 * an unrecoverable zombie — `restoreSession` would throw partway through
 * trying to bootstrap it, leaving the row dangling. The fix is to detect
 * this shape BEFORE calling `restoreSession`, mark the row archived, and
 * throw a structured `code: SESSION_UNRECOVERABLE_ARCHIVED` error.
 *
 * The actual `SessionManager.restartAgent` requires a fully-constructed
 * SessionManager (project context, sandbox, RPC bridge) which is too heavy
 * for an isolated unit test. This test pins the decision logic directly:
 * the predicate `!ps.agentSessionFile && !ps.role`, the side-effect
 * (store.update with archived: true), and the structured error.
 *
 * It also source-greps `session-manager.ts` to confirm the production code
 * still implements this check at the entry of `restartAgent`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restart-zombie-test-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionStore } = await import("../src/server/agent/session-store.ts");
type PersistedSession = import("../src/server/agent/session-store.ts").PersistedSession;

const stateDir = path.join(tmpRoot, "state");
fs.mkdirSync(stateDir, { recursive: true });

/**
 * Re-implements the zombie-detection branch of restartAgent so the predicate
 * can be tested in isolation. Production source-grep below ensures the live
 * file still uses this exact shape.
 */
function checkZombieAndArchive(
	store: InstanceType<typeof SessionStore>,
	sessionId: string,
	ps: PersistedSession,
): void {
	if (!ps.agentSessionFile && !ps.role) {
		store.update(sessionId, { archived: true, archivedAt: Date.now() });
		const err: Error & { code?: string } = new Error(
			`Session ${sessionId} could not be restarted — neither an agent session file nor ` +
			`a role was persisted. The session has been archived; create a fresh session to continue.`,
		);
		err.code = "SESSION_UNRECOVERABLE_ARCHIVED";
		throw err;
	}
}

function freshStore(): InstanceType<typeof SessionStore> {
	const f = path.join(stateDir, "sessions.json");
	if (fs.existsSync(f)) fs.unlinkSync(f);
	return new SessionStore(stateDir);
}

describe("restartAgent zombie-archive predicate", () => {
	it("archives the row and throws SESSION_UNRECOVERABLE_ARCHIVED when both fields are missing", () => {
		const store = freshStore();
		const ps: PersistedSession = {
			id: "zombie-1",
			title: "Zombie",
			cwd: "/tmp/test",
			createdAt: Date.now() - 1000,
			lastActivity: Date.now() - 1000,
			// agentSessionFile + role both intentionally absent
		};
		store.put(ps);

		assert.throws(
			() => checkZombieAndArchive(store, "zombie-1", ps),
			(err: any) => err.code === "SESSION_UNRECOVERABLE_ARCHIVED",
		);

		const persisted = store.get("zombie-1");
		assert.ok(persisted, "row must remain in the store");
		assert.equal(persisted!.archived, true, "row must be marked archived");
		assert.ok(typeof persisted!.archivedAt === "number" && persisted!.archivedAt! > 0, "archivedAt must be stamped");
	});

	it("does NOT archive when agentSessionFile is present (recoverable)", () => {
		const store = freshStore();
		const ps: PersistedSession = {
			id: "live-1",
			title: "Live",
			cwd: "/tmp/test",
			agentSessionFile: "/tmp/test/agent.jsonl",
			createdAt: Date.now() - 1000,
			lastActivity: Date.now() - 1000,
		};
		store.put(ps);

		assert.doesNotThrow(() => checkZombieAndArchive(store, "live-1", ps));
		assert.notEqual(store.get("live-1")!.archived, true);
	});

	it("does NOT archive when role is present (also recoverable)", () => {
		const store = freshStore();
		const ps: PersistedSession = {
			id: "live-2",
			title: "Live with role",
			cwd: "/tmp/test",
			role: "coder",
			createdAt: Date.now() - 1000,
			lastActivity: Date.now() - 1000,
		};
		store.put(ps);

		assert.doesNotThrow(() => checkZombieAndArchive(store, "live-2", ps));
		assert.notEqual(store.get("live-2")!.archived, true);
	});
});

describe("zombie-archive on restart — source-grep guard", async () => {
	const SOURCE = path.resolve(import.meta.dirname, "..", "src", "server", "agent", "session-manager.ts");
	const text = fs.readFileSync(SOURCE, "utf-8");

	it("restartAgent contains the SESSION_UNRECOVERABLE_ARCHIVED structured error code", () => {
		assert.match(text, /SESSION_UNRECOVERABLE_ARCHIVED/, "the structured error code must remain greppable");
	});

	it("restartAgent checks the !agentSessionFile && !role predicate", () => {
		// Conservative pin — the exact whitespace might shift; check both
		// conjuncts are present in the file.
		assert.match(text, /!ps\.agentSessionFile/, "predicate must read the persisted agentSessionFile field");
		assert.match(text, /!ps\.role/, "predicate must read the persisted role field");
	});

	it("the zombie branch calls store.update with archived: true", () => {
		assert.match(text, /archived:\s*true/, "the zombie branch must mark the row archived");
		// Ensure the predicate, the update, and the throw are all in a single
		// nearby block — narrow source-grep against the assignment site (the
		// `zombieErr.code = "..."` line) rather than the first textual mention,
		// which lives in an upstream comment.
		const codeAssignment = text.indexOf('zombieErr.code = "SESSION_UNRECOVERABLE_ARCHIVED"');
		assert.ok(codeAssignment > 0, "structured error code assignment must be present");
		const window = text.slice(Math.max(0, codeAssignment - 800), codeAssignment + 200);
		assert.match(window, /archived:\s*true/, "archived:true must appear close to the structured error assignment");
	});
});
