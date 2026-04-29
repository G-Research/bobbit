/**
 * E2E tests covering the project-config API surface.
 *
 * Originally tracked two setup-wizard bugs:
 *   Bug 1: No project config API — GET /api/project-config returns 404.
 *   Bug 2: Workflow verification uses hardcoded commands instead of
 *          {{project.X}} template variables.
 *
 * Bug 2 was made obsolete by the multi-repo & components refactor: the
 * `{{project.X}}` token namespace was removed in favor of structural
 * `{ component, command }` step references and the validator now rejects
 * `{{project.X}}` tokens at workflow-load time. The Bug 2 describe block
 * was deleted (workflows can no longer carry those tokens, by design).
 * Bug 1 coverage stays — the project-config REST surface is still in use.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";

// ---------------------------------------------------------------------------
// Bug 1: Project config API does not exist
// ---------------------------------------------------------------------------

test.describe("Bug 1: Project config API", () => {
	test("GET /api/project-config returns 200", async () => {
		const resp = await apiFetch("/api/project-config");
		expect(resp.status, "Expected GET /api/project-config to return 200 but got 404 — endpoint does not exist yet").toBe(200);
	});

	test("GET /api/project-config/defaults returns built-in defaults", async () => {
		const resp = await apiFetch("/api/project-config/defaults");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.typecheck_command).toBe("npm run check");
		expect(data.build_command).toBe("npm run build");
		expect(data.test_unit_command).toBe("npm run test:unit");
	});

	test("PUT /api/project-config accepts arbitrary keys", async () => {
		// Set a custom key
		const putResp = await apiFetch("/api/project-config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ my_custom_var: "hello world" }),
		});
		expect(putResp.status).toBe(200);

		// Verify it appears in GET
		const getResp = await apiFetch("/api/project-config");
		const data = await getResp.json();
		expect(data.my_custom_var).toBe("hello world");
		// Defaults still present
		expect(data.typecheck_command).toBe("npm run check");

		// Clean up: remove the custom key
		await apiFetch("/api/project-config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ my_custom_var: null }),
		});
		const cleanResp = await apiFetch("/api/project-config");
		const cleanData = await cleanResp.json();
		expect(cleanData.my_custom_var).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Bug 2 (obsolete): Workflow verification used hardcoded commands.
//
// The fix evolved past template variables: `{{project.X}}` tokens are now
// rejected at workflow-load time by the validator (see
// docs/design/multi-repo-components.md §3.3). Workflows reference component
// commands structurally via `{ component, command }`. Tests asserting the
// presence of `{{project.X}}` would now violate the validator and are
// intentionally removed.
// ---------------------------------------------------------------------------
