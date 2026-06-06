/**
 * Route-level coverage for two server.ts hardening fixes:
 *
 *   1. POST /api/goals/:id/team/complete refuses to complete a goal while it
 *      still has unresolved live descendant goals — 409 UNRESOLVED_CHILDREN
 *      {childIds}. Independent of gate-requirement state. Archived/complete
 *      descendants don't block.
 *
 *   2. Oversized request bodies are rejected with 413 BODY_TOO_LARGE before
 *      any handler buffers/parses the body (Content-Length precheck +
 *      streaming cap in readBody()).
 *
 * Mirrors the in-process harness import pattern from
 * tests/e2e/api-goals-spawn-child-route.spec.ts.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	deleteGoal,
	gitCwd,
	rawApiFetch,
	readE2EToken,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

let token: string;
let humanCookie = "";

test.beforeAll(async () => {
	token = readE2EToken();
	// The Children-mutation endpoints (spawn-child) require a verified-human
	// cookie. The gateway mints bobbit_session on the first authed request.
	const probe = await rawApiFetch("/api/goals", { headers: { Authorization: `Bearer ${token}` } });
	const setCookies = (probe.headers as any).getSetCookie?.() as string[] | undefined
		?? (probe.headers.get("set-cookie") ? [probe.headers.get("set-cookie") as string] : []);
	humanCookie = setCookies.map((c) => c.split(";")[0]).find((c) => c.startsWith("bobbit_session=")) ?? "";
	expect(humanCookie, "harness must mint a bobbit_session cookie for the human/UI authz path").not.toBe("");
});

function authHeaders(extra?: Record<string, string>): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		...(humanCookie ? { Cookie: humanCookie } : {}),
		...(extra ?? {}),
	};
}

async function createParentGoal(): Promise<{ id: string; repoPath?: string }> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `unresolved-children parent ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			cwd: gitCwd(),
			autoStartTeam: false,
			workflowId: "feature",
		}),
	});
	expect(resp.status).toBe(201);
	const created = await resp.json();
	const settled = await pollUntil(
		async () => {
			const r = await apiFetch(`/api/goals/${created.id}`);
			if (r.status !== 200) return null;
			const g = await r.json();
			return g.setupStatus === "ready" && g.repoPath ? g : null;
		},
		{ timeoutMs: 30_000, intervalMs: 100, label: `parent ${created.id} setup ready` },
	);
	return settled;
}

async function spawnChild(parentId: string, planId: string): Promise<string> {
	const resp = await rawApiFetch(`/api/goals/${parentId}/spawn-child`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			planId,
			title: `child ${planId}`,
			spec: "child goal spec used to assert the parent cannot complete while this child is unresolved (live).",
		}),
	});
	expect(resp.status).toBe(201);
	const body = await resp.json();
	expect(body.id).toBeTruthy();
	return body.id;
}

async function completeTeam(goalId: string): Promise<{ status: number; body: any }> {
	const resp = await rawApiFetch(`/api/goals/${goalId}/team/complete`, {
		method: "POST",
		headers: authHeaders(),
	});
	const text = await resp.text();
	let body: any;
	try { body = text ? JSON.parse(text) : null; } catch { body = text; }
	return { status: resp.status, body };
}

test.describe("POST /team/complete — unresolved-children guard", () => {
	test("refuses to complete a goal with a live child → 409 UNRESOLVED_CHILDREN @smoke", async () => {
		const parent = await createParentGoal();
		try {
			const childId = await spawnChild(parent.id, "plan-unresolved-1");
			try {
				const { status, body } = await completeTeam(parent.id);
				expect(status).toBe(409);
				expect(body.code).toBe("UNRESOLVED_CHILDREN");
				expect(Array.isArray(body.childIds)).toBe(true);
				expect(body.childIds).toContain(childId);
			} finally {
				await deleteGoal(childId);
			}
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("a completed child no longer blocks completion (not 409 UNRESOLVED_CHILDREN)", async () => {
		const parent = await createParentGoal();
		try {
			const childId = await spawnChild(parent.id, "plan-completed-1");
			try {
				// Mark the child complete via PUT — a resolved descendant must
				// not block the parent's completion.
				const put = await apiFetch(`/api/goals/${childId}`, {
					method: "PUT",
					body: JSON.stringify({ state: "complete" }),
				});
				expect(put.status).toBe(200);

				const { status, body } = await completeTeam(parent.id);
				// The unresolved-children guard must NOT fire. (The parent has no
				// live team in this harness, so completeTeam() itself fails with a
				// 400 "No active team" — that's fine; we only assert the guard
				// passed, i.e. it is not a 409 UNRESOLVED_CHILDREN.)
				expect(status).not.toBe(409);
				expect(body?.code).not.toBe("UNRESOLVED_CHILDREN");
			} finally {
				await deleteGoal(childId);
			}
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("an archived child no longer blocks completion (not 409 UNRESOLVED_CHILDREN)", async () => {
		const parent = await createParentGoal();
		try {
			const childId = await spawnChild(parent.id, "plan-archived-1");
			// Archive the child via the parent-scoped archive-child endpoint.
			const arch = await rawApiFetch(`/api/goals/${parent.id}/archive-child/${childId}?cascade=true`, {
				method: "DELETE",
				headers: authHeaders(),
			});
			expect([200, 204]).toContain(arch.status);

			const { status, body } = await completeTeam(parent.id);
			expect(status).not.toBe(409);
			expect(body?.code).not.toBe("UNRESOLVED_CHILDREN");
		} finally {
			await deleteGoal(parent.id);
		}
	});
});

test.describe("request body-size cap — 413 BODY_TOO_LARGE", () => {
	test("an oversized POST body is rejected with 413 before parsing @smoke", async () => {
		// > 1 MiB declared body. The Content-Length precheck in the request
		// handler refuses it with a definitive 413 before auth/dispatch and
		// before any handler buffers or JSON-parses the payload.
		const oversized = JSON.stringify({ title: "x".repeat(1024 * 1024 + 64), cwd: gitCwd() });
		const resp = await rawApiFetch("/api/goals", {
			method: "POST",
			headers: authHeaders(),
			body: oversized,
		});
		expect(resp.status).toBe(413);
		const body = await resp.json();
		expect(body.code).toBe("BODY_TOO_LARGE");
		expect(body.limit).toBe(1024 * 1024);
	});

	test("a normal-sized POST body is accepted (cap does not reject legitimate payloads)", async () => {
		const resp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: `body-cap sanity ${Date.now()}`,
				cwd: gitCwd(),
				autoStartTeam: false,
				workflowId: "feature",
			}),
		});
		expect(resp.status).toBe(201);
		const created = await resp.json();
		await deleteGoal(created.id);
	});
});
