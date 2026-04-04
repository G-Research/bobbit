/**
 * Sandbox Session Restore E2E Tests
 *
 * Verifies that when a sandboxed session is restored after server restart,
 * the correct `sandboxClaim` (with branch and teamRepoPath) is reconstructed
 * from persisted session fields and passed to `applySandboxWiring`.
 *
 * No Docker required — tests intercept at the `applySandboxWiring` boundary.
 */
import { test, expect } from "./in-process-harness.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Build a minimal PersistedSession with required fields. */
function makePersistedSession(
	overrides: Record<string, unknown>,
	bobbitDir: string,
): Record<string, unknown> {
	const id = crypto.randomUUID();
	const agentSessionFile = path.join(bobbitDir, "state", `${id}.jsonl`);
	// Create a minimal .jsonl so the restore path doesn't skip it
	fs.writeFileSync(agentSessionFile, '{"type":"init"}\n');
	return {
		id,
		title: "Test sandbox session",
		cwd: bobbitDir,
		agentSessionFile,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		...overrides,
	};
}

/** Get the default project ID from the session manager's PCM. */
function getDefaultProjectId(sm: any): string | undefined {
	const pcm = sm.getProjectContextManager?.() ?? sm.projectContextManager;
	return pcm?.getDefaultProjectId?.();
}

test.describe("sandbox session restore", () => {
	test.describe.configure({ mode: 'serial' });

	test("restores sandboxed session with branch and teamRepoPath", async ({ gateway }) => {
		const sm = gateway.sessionManager as any;
		const projectId = getDefaultProjectId(sm);
		const ps = makePersistedSession(
			{
				sandboxed: true,
				branch: "goal/test-branch",
				teamGoalId: "test-goal-123",
				projectId,
			},
			gateway.bobbitDir,
		);

		// Inject into the session store
		const store = sm.getSessionStore(projectId);
		store.put(ps);

		// Create the fake team repo directory at the expected pool path
		let teamRepoDir: string | undefined;
		if (sm.sandboxPool) {
			teamRepoDir = path.join(sm.sandboxPool.poolDir, "team-test-goal-123.git");
			fs.mkdirSync(teamRepoDir, { recursive: true });
		}

		// Spy on applySandboxWiring
		const original = sm.applySandboxWiring.bind(sm);
		let capturedArgs: unknown[] | undefined;
		sm.applySandboxWiring = async (...args: unknown[]) => {
			capturedArgs = args;
			// Return false = "sandbox not configured" — prevents actual Docker calls
			return false;
		};

		try {
			// restoreSession is private — call via (any) cast.
			// It will proceed past applySandboxWiring (which returns false) and
			// continue to try launching the agent process. It may throw since the
			// mock agent doesn't have a real session to resume — that's fine,
			// we only care that applySandboxWiring was called with the right args.
			await sm.restoreSession(ps).catch(() => {});

			expect(capturedArgs).toBeDefined();
			// Args: (bridgeOptions, sessionId, opts)
			const opts = capturedArgs![2] as any;
			expect(opts.skipMountValidation).toBe(true);
			expect(opts.sandboxClaim).toBeDefined();
			expect(opts.sandboxClaim.branch).toBe("goal/test-branch");

			if (teamRepoDir) {
				expect(opts.sandboxClaim.teamRepoPath).toBe(teamRepoDir);
			}
		} finally {
			sm.applySandboxWiring = original;
			if (teamRepoDir) {
				fs.rmSync(teamRepoDir, { recursive: true, force: true });
			}
		}
	});

	test("restores sandboxed session without branch — no sandboxClaim", async ({ gateway }) => {
		const sm = gateway.sessionManager as any;
		const projectId = getDefaultProjectId(sm);
		const ps = makePersistedSession(
			{
				sandboxed: true,
				projectId,
				// No branch
			},
			gateway.bobbitDir,
		);

		const store = sm.getSessionStore(projectId);
		store.put(ps);

		const original = sm.applySandboxWiring.bind(sm);
		let capturedArgs: unknown[] | undefined;
		sm.applySandboxWiring = async (...args: unknown[]) => {
			capturedArgs = args;
			return false;
		};

		try {
			await sm.restoreSession(ps).catch(() => {});

			expect(capturedArgs).toBeDefined();
			const opts = capturedArgs![2] as any;
			expect(opts.skipMountValidation).toBe(true);
			// No branch → no sandboxClaim (or undefined)
			expect(opts.sandboxClaim).toBeUndefined();
		} finally {
			sm.applySandboxWiring = original;
		}
	});

	test("sandboxed session with branch but no teamGoalId — branch only", async ({ gateway }) => {
		const sm = gateway.sessionManager as any;
		const projectId = getDefaultProjectId(sm);
		const ps = makePersistedSession(
			{
				sandboxed: true,
				branch: "some-branch",
				projectId,
				// No teamGoalId
			},
			gateway.bobbitDir,
		);

		const store = sm.getSessionStore(projectId);
		store.put(ps);

		const original = sm.applySandboxWiring.bind(sm);
		let capturedArgs: unknown[] | undefined;
		sm.applySandboxWiring = async (...args: unknown[]) => {
			capturedArgs = args;
			return false;
		};

		try {
			await sm.restoreSession(ps).catch(() => {});

			expect(capturedArgs).toBeDefined();
			const opts = capturedArgs![2] as any;
			expect(opts.skipMountValidation).toBe(true);
			expect(opts.sandboxClaim).toBeDefined();
			expect(opts.sandboxClaim.branch).toBe("some-branch");
			// No teamGoalId → no teamRepoPath
			expect(opts.sandboxClaim.teamRepoPath).toBeUndefined();
		} finally {
			sm.applySandboxWiring = original;
		}
	});

	test("team repo missing from disk — graceful degradation", async ({ gateway }) => {
		const sm = gateway.sessionManager as any;
		const projectId = getDefaultProjectId(sm);
		const ps = makePersistedSession(
			{
				sandboxed: true,
				branch: "goal/test",
				teamGoalId: "missing-goal",
				projectId,
			},
			gateway.bobbitDir,
		);

		const store = sm.getSessionStore(projectId);
		store.put(ps);

		// Do NOT create the team repo directory — it should degrade gracefully

		const original = sm.applySandboxWiring.bind(sm);
		let capturedArgs: unknown[] | undefined;
		sm.applySandboxWiring = async (...args: unknown[]) => {
			capturedArgs = args;
			return false;
		};

		try {
			await sm.restoreSession(ps).catch(() => {});

			expect(capturedArgs).toBeDefined();
			const opts = capturedArgs![2] as any;
			expect(opts.skipMountValidation).toBe(true);
			expect(opts.sandboxClaim).toBeDefined();
			expect(opts.sandboxClaim.branch).toBe("goal/test");
			// Team repo doesn't exist on disk → no teamRepoPath
			expect(opts.sandboxClaim.teamRepoPath).toBeUndefined();
		} finally {
			sm.applySandboxWiring = original;
		}
	});
});
