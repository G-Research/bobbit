/**
 * E2E tests for sandbox delegate session bugs.
 *
 * Reproduces two bugs in createDelegateSession():
 * 1. CWD path mismatch — container path /workspace is not remapped to host path
 * 2. No sandbox propagation — delegate sessions don't inherit sandbox config
 *
 * These tests do NOT require Docker. They verify behavior at the REST API
 * level using the E2E gateway harness with the mock agent.
 */
import { test, expect } from "./gateway-harness.js";
import { nonGitCwd, apiFetch } from "./e2e-setup.js";

test.describe("Sandbox Delegate", () => {
	async function setSandboxMode(mode: "docker" | "none") {
		const res = await apiFetch("/api/project-config", {
			method: "PUT",
			body: JSON.stringify({ sandbox: mode }),
		});
		expect(res.status).toBe(200);
	}

	async function createParentSession(): Promise<string> {
		const res = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(res.status).toBe(201);
		const data = await res.json();
		return data.id;
	}

	async function getSessionMeta(sessionId: string): Promise<Record<string, unknown> | undefined> {
		const res = await apiFetch("/api/sessions");
		expect(res.status).toBe(200);
		const data = await res.json();
		const sessions = data.sessions || data;
		return (sessions as Array<Record<string, unknown>>).find(
			(s: Record<string, unknown>) => s.id === sessionId
		);
	}

	async function deleteSession(id: string) {
		await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
	}

	test.afterEach(async () => {
		await setSandboxMode("none").catch(() => {});
	});

	test("delegate from sandboxed parent should propagate sandbox flag and remap cwd", async () => {
		// Configure sandbox mode
		await setSandboxMode("docker");

		// Create a normal parent session
		const parentId = await createParentSession();
		const hostCwd = nonGitCwd();

		try {
			// Mark the parent as sandboxed by updating its store entry via PATCH.
			// Since PATCH doesn't support sandboxed, we use a workaround:
			// The session-manager's store.update() is called internally.
			// Instead, we test that delegate creation with cwd=/workspace fails
			// when the parent is NOT sandboxed (current behavior), and verify
			// the delegate doesn't have sandboxed=true.

			// Create a delegate with the container-internal path /workspace.
			// On the host, /workspace doesn't exist so the agent spawn may fail.
			// On current (buggy) code, the server passes /workspace through unchanged.
			const delegateRes = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({
					delegateOf: parentId,
					instructions: "Test delegate sandbox propagation",
					cwd: "/workspace",
				}),
			});

			if (delegateRes.status === 201) {
				// Delegate creation succeeded despite /workspace being invalid on host.
				// This means cwd was not validated or the mock agent tolerates any cwd.
				const delegateData = await delegateRes.json();
				const delegateId = delegateData.id;

				try {
					await new Promise(r => setTimeout(r, 500));
					const meta = await getSessionMeta(delegateId);
					expect(meta).toBeDefined();

					// BUG 1: cwd should have been remapped from /workspace to host path
					// On buggy code, cwd is "/workspace" (un-remapped)
					expect(meta!.cwd).not.toBe("/workspace");
					expect(meta!.cwd).toBe(hostCwd);

					// BUG 2: delegate should inherit sandbox from parent
					expect(meta!.sandboxed).toBe(true);
				} finally {
					await deleteSession(delegateId);
				}
			} else {
				// Delegate creation failed — /workspace doesn't exist on host.
				// This itself proves bug #1: the server should remap /workspace
				// to the parent's host-side cwd, not pass it through.
				const errBody = await delegateRes.json().catch(() => ({}));
				// Fail with a descriptive message proving the bug
				expect(delegateRes.status).toBe(201);
			}
		} finally {
			await deleteSession(parentId);
		}
	});

	test("delegate from non-sandboxed parent should work normally", async () => {
		// Without sandbox configured, delegates should work as before
		const parentId = await createParentSession();
		const hostCwd = nonGitCwd();

		try {
			const delegateRes = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({
					delegateOf: parentId,
					instructions: "Test non-sandboxed delegate",
					cwd: hostCwd,
				}),
			});

			expect(delegateRes.status).toBe(201);
			const delegateData = await delegateRes.json();
			const delegateId = delegateData.id;

			try {
				await new Promise(r => setTimeout(r, 500));
				const meta = await getSessionMeta(delegateId);
				expect(meta).toBeDefined();
				expect(meta!.cwd).toBe(hostCwd);
				// Non-sandboxed parent → delegate should not be sandboxed
				expect(meta!.sandboxed).toBeFalsy();
			} finally {
				await deleteSession(delegateId);
			}
		} finally {
			await deleteSession(parentId);
		}
	});
});
