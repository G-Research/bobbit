/**
 * Integration coverage for sandbox-branch metadata at the session API/store
 * boundary. The branch reconciliation decision itself is covered by the core
 * suite; these tests prove persisted branch metadata remains stable without
 * provisioning a real Git worktree or probing Docker.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { readE2EToken, nonGitCwd, injectDefaultProjectId } from "./_e2e/e2e-setup.js";
import { pollUntil } from "../../tests/e2e/test-utils/cleanup.js";

let _tok: string;
function TOKEN() { if (!_tok) _tok = readE2EToken(); return _tok; }

async function apiFetch(baseURL: string, path: string, opts: RequestInit = {}) {
	const method = (opts.method || "GET").toUpperCase();
	let body = opts.body;
	if (method === "POST" && /^\/api\/(sessions|goals|staff)(\?|$|\/)/.test(path)) {
		body = await injectDefaultProjectId(body) as BodyInit;
	}
	return fetch(`${baseURL}${path}`, {
		...opts,
		body,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN()}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

async function waitForSessionReady(baseURL: string, id: string): Promise<any> {
	return pollUntil(async () => {
		const res = await apiFetch(baseURL, `/api/sessions/${id}`);
		const session = await res.json();
		return session.status !== "preparing" ? session : null;
	}, { timeoutMs: 10_000, intervalMs: 25, label: `session ${id} leaves preparing` });
}

function seedBranchMetadata(gateway: any, id: string, branch: string): void {
	const persisted = gateway.sessionManager.getPersistedSession(id);
	expect(persisted).toBeTruthy();
	gateway.sessionManager.getSessionStore(persisted.projectId).update(id, { branch });
	const live = gateway.sessionManager.getSession(id);
	if (live) live.branch = branch;
}

test.describe("Sandbox branch reconciliation", () => {
	test("non-sandboxed no-worktree session preserves seeded branch metadata", async ({ gateway }) => {
		const createRes = await apiFetch(gateway.baseURL, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd(), worktree: false }),
		});
		expect(createRes.status).toBe(201);
		const { id } = await createRes.json() as any;

		try {
			const session = await waitForSessionReady(gateway.baseURL, id);
			const branch = `session/${id.slice(0, 8)}`;
			seedBranchMetadata(gateway, id, branch);

			const persisted = gateway.sessionManager.getPersistedSession(id);
			expect(persisted?.branch).toBe(branch);
			expect(session.sandboxed).toBeFalsy();
		} finally {
			await apiFetch(gateway.baseURL, `/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("session creation accepts sandboxBranch without provisioning Git or Docker", async ({ gateway }) => {
		const createRes = await apiFetch(gateway.baseURL, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: nonGitCwd(),
				worktree: false,
				sandboxBranch: "goal-test-coder-abc123",
			}),
		});
		expect(createRes.status).toBe(201);
		const { id } = await createRes.json() as any;

		try {
			const session = await waitForSessionReady(gateway.baseURL, id);
			expect(session.sandboxed).toBeFalsy();
			expect(gateway.sessionManager.getPersistedSession(id)).toBeTruthy();
		} finally {
			await apiFetch(gateway.baseURL, `/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("sandboxBranch metadata does not reconcile a non-sandboxed session", async ({ gateway }) => {
		const createRes = await apiFetch(gateway.baseURL, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: nonGitCwd(),
				worktree: false,
				sandboxed: false,
				sandboxBranch: "goal-should-not-reconcile",
			}),
		});
		expect(createRes.status).toBe(201);
		const { id } = await createRes.json() as any;

		try {
			const session = await waitForSessionReady(gateway.baseURL, id);
			const originalBranch = `session/${id.slice(0, 8)}`;
			seedBranchMetadata(gateway, id, originalBranch);

			const persisted = gateway.sessionManager.getPersistedSession(id);
			expect(persisted?.branch).toBe(originalBranch);
			expect(persisted?.branch).not.toBe("goal-should-not-reconcile");
			expect(session.sandboxed).toBeFalsy();
		} finally {
			await apiFetch(gateway.baseURL, `/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
