/**
 * API E2E — PUT /api/projects/:id/config accepts every field in scope for
 * mid-session project proposals, persists them, and GET returns them.
 *
 * Also verifies `name` rename via PUT /api/projects/:id, independent of
 * the generic config endpoint.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** The full editable field set from the design doc (config-scoped only — name is
 *  handled via the registry endpoint, not project.yaml). */
const CONFIG_FIELDS = {
	build_command: "npm run build",
	test_command: "npm test",
	typecheck_command: "npm run check",
	test_unit_command: "npm run test:unit",
	test_e2e_command: "npm run test:e2e",
	worktree_setup_command: "npm ci",
	sandbox: "docker",
	session_model: "anthropic/claude-3-5-sonnet-latest",
	review_model: "anthropic/claude-3-5-haiku-latest",
	naming_model: "anthropic/claude-3-5-haiku-latest",
};

async function registerTmpProject(name: string): Promise<{ id: string; cleanup: () => void }> {
	const dir = mkdtempSync(join(tmpdir(), "bobbit-projcfg-"));
	const res = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath: dir }),
	});
	expect(res.status).toBe(201);
	const proj = await res.json();
	return {
		id: proj.id,
		cleanup: () => {
			apiFetch(`/api/projects/${proj.id}`, { method: "DELETE" }).catch(() => {});
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}

test.describe("Project config API — mid-session proposal field coverage", () => {
	test("PUT /api/projects/:id/config accepts all editable fields and GET returns them", async () => {
		const { id, cleanup } = await registerTmpProject("midsession-cfg");
		try {
			const putRes = await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify(CONFIG_FIELDS),
			});
			expect(putRes.status).toBe(200);

			const getRes = await apiFetch(`/api/projects/${id}/config`);
			expect(getRes.status).toBe(200);
			const cfg = await getRes.json();

			for (const [k, v] of Object.entries(CONFIG_FIELDS)) {
				expect(cfg[k], `field ${k} should be persisted`).toBe(v);
			}
		} finally {
			cleanup();
		}
	});

	test("PUT /api/projects/:id accepts name rename and GET returns it", async () => {
		const { id, cleanup } = await registerTmpProject("before-rename");
		try {
			const putRes = await apiFetch(`/api/projects/${id}`, {
				method: "PUT",
				body: JSON.stringify({ name: "after-rename" }),
			});
			expect(putRes.status).toBe(200);
			const updated = await putRes.json();
			expect(updated.name).toBe("after-rename");

			const getRes = await apiFetch(`/api/projects/${id}`);
			const proj = await getRes.json();
			expect(proj.name).toBe("after-rename");
		} finally {
			cleanup();
		}
	});

	test("partial PUT updates only the supplied fields", async () => {
		const { id, cleanup } = await registerTmpProject("partial-put");
		try {
			// Seed
			await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify({ build_command: "seed-build", test_command: "seed-test" }),
			});
			// Update only test_command
			const res = await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify({ test_command: "new-test" }),
			});
			expect(res.status).toBe(200);
			const cfg = await (await apiFetch(`/api/projects/${id}/config`)).json();
			expect(cfg.build_command).toBe("seed-build"); // untouched
			expect(cfg.test_command).toBe("new-test");    // updated
		} finally {
			cleanup();
		}
	});

	test("PUT /api/projects/:id/config translates legacy *_command fields into components[0].commands (back-compat)", async () => {
		// Per the multi-repo follow-up Issue 2/5: legacy proposal payloads (top-level
		// build_command/test_command/...) must be folded into components[0].commands
		// server-side. New proposal payloads (with `components` field) are accepted as-is.
		const { id, cleanup } = await registerTmpProject("legacy-translate");
		try {
			const putRes = await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify({
					build_command: "npm run build",
					test_command: "npm test",
					typecheck_command: "npm run check",
					test_unit_command: "npm run test:unit",
					test_e2e_command: "npm run test:e2e",
					worktree_setup_command: "npm ci",
				}),
			});
			expect(putRes.status).toBe(200);

			// Resolved view exposes the structured side-table; verify components[0]
			// was synthesized with project-name and the legacy commands folded in.
			const getRes = await apiFetch(`/api/projects/${id}/config`);
			const raw = await getRes.json();
			// Legacy flat keys are still echoed back for back-compat clients.
			expect(raw.build_command).toBe("npm run build");

			// The structural components side-table is exposed via /api/projects/:id/structured.
			const structRes = await apiFetch(`/api/projects/${id}/structured`);
			const struct = await structRes.json();
			expect(Array.isArray(struct.components), "structured endpoint should expose components[]").toBe(true);
			expect(struct.components.length, "single default component").toBe(1);
			const c0 = struct.components[0];
			expect(c0.name).toBe("legacy-translate");
			expect(c0.repo).toBe(".");
			expect(c0.commands.build).toBe("npm run build");
			expect(c0.commands.test).toBe("npm test");
			expect(c0.commands.check).toBe("npm run check");
			expect(c0.commands.unit).toBe("npm run test:unit");
			expect(c0.commands.e2e).toBe("npm run test:e2e");
			expect(c0.worktreeSetupCommand || c0.worktree_setup_command).toBe("npm ci");
		} finally {
			cleanup();
		}
	});

	test("PUT /api/projects/:id/config preserves unknown custom keys", async () => {
		const { id, cleanup } = await registerTmpProject("custom-keys");
		try {
			await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify({ my_custom_key: "value-1" }),
			});
			const cfg = await (await apiFetch(`/api/projects/${id}/config`)).json();
			expect(cfg.my_custom_key).toBe("value-1");
		} finally {
			cleanup();
		}
	});
});
