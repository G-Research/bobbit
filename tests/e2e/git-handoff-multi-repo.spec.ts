/**
 * Per-repo git handoff round-trip via REST.
 *
 * See docs/design/multi-repo-components.md §6.1 / §9.2.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base, nonGitCwd, injectDefaultProjectId } from "./e2e-setup.js";

let token: string;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
	const method = (opts?.method || "GET").toUpperCase();
	let body = opts?.body;
	if (method === "POST" && /^\/api\/(sessions|goals|staff)(\?|$|\/)/.test(path)) {
		body = await injectDefaultProjectId(body) as BodyInit;
	}
	return fetch(`${base()}${path}`, { ...opts, body, headers: { ...headers(), ...(opts?.headers || {}) } });
}

test.beforeAll(() => { token = readE2EToken(); });

// TODO Phase 4 follow-up: extend POST /api/goals/:goalId/tasks + PUT /api/tasks/:id
// to accept and persist `gitHandoff`. Today only flat fields are wired through
// the REST surface. The PersistedTask field + read-helper are already covered
// by `tests/task-handoff-multi-repo.test.ts`.
test.skip("multi-repo task gitHandoff round-trip", async () => {
	// Create a goal first (any goal — single-repo is fine; we just want a goalId).
	const goalRes = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({ title: "handoff-test", cwd: nonGitCwd(), team: false }),
	});
	expect(goalRes.status).toBe(201);
	const goal = await goalRes.json();

	// Create a task carrying per-repo gitHandoff.
	const taskRes = await fetch(`${base()}/api/tasks`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({
			goalId: goal.id,
			title: "multi-repo task",
			type: "implementation",
			gitHandoff: {
				api: { baseSha: "a1", headSha: "a2", branch: "feat/api" },
				web: { baseSha: "w1", headSha: "w2", branch: "feat/web" },
			},
		}),
	});
	expect(taskRes.status).toBe(201);
	const task = await taskRes.json();

	// Fetch back via list endpoint and verify the field round-trips.
	const listRes = await fetch(`${base()}/api/tasks?goalId=${goal.id}`, { headers: headers() });
	expect(listRes.status).toBe(200);
	const listBody = await listRes.json();
	const tasks = Array.isArray(listBody) ? listBody : (listBody.tasks ?? []);
	const found = tasks.find((t: { id: string }) => t.id === task.id);
	expect(found).toBeDefined();
	expect(found.gitHandoff?.api?.headSha).toBe("a2");
	expect(found.gitHandoff?.web?.branch).toBe("feat/web");
});
