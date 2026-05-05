/**
 * Reproducer — POST /api/sessions returns 400 when called with no projectId
 * and a cwd that doesn't match any registered project.
 *
 * Issue analysis: `src/server/agent/resolve-project.ts::resolveProjectForRequest()`
 * is the single 400 source. Body `{}` and body `{ toolAssistant: true }` both
 * reach it (after the falls-through `cwd = config.defaultCwd` step) and 400
 * with:
 *   "projectId required: no projectId was provided and cwd \"...\" does not
 *    match any registered project"
 *
 * Note: the in-process harness ALWAYS has a "default" project registered
 * pointing at the harness CWD, so an empty body actually succeeds against
 * the harness (the default project resolves). To reproduce the underlying
 * server contract that the splash-screen bug surfaces with zero projects,
 * test #1 passes a deliberate non-matching cwd. The UI fix is gating, not
 * a server change for that caller; the server contract stays the same.
 *
 * Test cases:
 *
 *   1. Empty body with bogus cwd — 400 (locks in resolver contract).
 *
 *   2. Tool assistant with system scope — POST `{ toolAssistant: true,
 *      projectId: "system" }`. Today this 400s because no `system` project
 *      exists. After the fix lands, the server registers a synthetic
 *      hidden `system` project at startup and this returns 201 with
 *      `assistantType: "tool"` and the session's persisted `projectId`
 *      equal to `"system"`. THIS TEST FLIPS FAIL → PASS.
 *
 *   3. Regression guard — Tool assistant with an explicit projectId of a
 *      registered project. Must succeed today and after the fix.
 *
 * Use raw (uninjected) fetch via `rawApiFetch` so the harness's default-
 * project auto-injection doesn't mask the bug.
 */
import { test, expect } from "./in-process-harness.js";
import { rawApiFetch, defaultProjectId, readE2EToken } from "./e2e-setup.js";

test.beforeAll(() => {
	// Sanity — the in-process harness must be up.
	readE2EToken();
});

test.describe("POST /api/sessions — projectless reproducer", () => {
	test("empty body with non-matching cwd — 400 (resolver contract)", async () => {
		// No projectId, cwd doesn't match any registered project.
		// Server must reject with the canonical "projectId required" error.
		// (Splash-screen bug today: with zero projects registered, body `{}`
		// hits this same path because no project matches.)
		const resp = await rawApiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: "/nonexistent/bogus-path-no-project-here" }),
		});
		const text = await resp.text();
		expect(
			resp.status,
			`expected 400 with bogus cwd; got ${resp.status} body=${text}`,
		).toBe(400);
		expect(text).toMatch(/projectId required/);
		expect(text).toMatch(/does not match any registered project/);
	});

	test("tool assistant with system scope succeeds (system project resolved)", async () => {
		// AFTER FIX: server registers a synthetic hidden `system` project at
		// startup. Tool-assistant sessions sent with `projectId: "system"`
		// resolve to it and create successfully.
		// BEFORE FIX (today): no `system` project exists, so this returns 400
		// with the canonical "projectId required ... does not match any
		// registered project" error.
		const resp = await rawApiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ toolAssistant: true, projectId: "system" }),
		});
		const text = await resp.text();
		// Surface the full server response in the failure message so the
		// reproducing-test gate's `error_pattern` regex
		// (`projectId required.*does not match`) can match against the test
		// output captured by the runner.
		expect(
			resp.status,
			`tool-assistant with projectId=system must return 201; got ${resp.status} body=${text}`,
		).toBe(201);
		const session = JSON.parse(text);
		expect(session.assistantType).toBe("tool");
		expect(session.toolAssistant).toBe(true);

		// Verify persisted projectId via GET /api/sessions/:id (POST 201 body
		// doesn't include projectId).
		const detail = await rawApiFetch(`/api/sessions/${session.id}`);
		expect(detail.status).toBe(200);
		const detailBody = await detail.json();
		expect(detailBody.projectId).toBe("system");

		// Cleanup — best-effort.
		await rawApiFetch(`/api/sessions/${session.id}`, { method: "DELETE" }).catch(() => {});
	});

	test("tool assistant with registered projectId succeeds (regression guard)", async () => {
		// Use the harness's default project — guaranteed to exist.
		const pid = await defaultProjectId();
		expect(pid, "harness default project must be registered").toBeTruthy();

		const resp = await rawApiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ toolAssistant: true, projectId: pid }),
		});
		const text = await resp.text();
		expect(
			resp.status,
			`tool-assistant with valid projectId must return 201; got ${resp.status} body=${text}`,
		).toBe(201);
		const session = JSON.parse(text);
		expect(session.assistantType).toBe("tool");
		expect(session.toolAssistant).toBe(true);

		// Verify persisted projectId via GET.
		const detail = await rawApiFetch(`/api/sessions/${session.id}`);
		expect(detail.status).toBe(200);
		const detailBody = await detail.json();
		expect(detailBody.projectId).toBe(pid);

		// Cleanup.
		await rawApiFetch(`/api/sessions/${session.id}`, { method: "DELETE" }).catch(() => {});
	});
});
