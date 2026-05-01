/**
 * API E2E — components[].config map (per-component opaque key→string).
 *
 * Verifies the REST surface for the post-migration component-config model:
 *
 *   1. PUT with structured `components: [{ name, repo, config: {...} }]` round-trips.
 *   2. PUT with any of the seven legacy top-level qa_* keys → HTTP 400 with the
 *      "moved to components[].config[]" guidance.
 *   3. GET /api/projects/:id/qa-testing-config returns `{ configured: boolean }`,
 *      true iff some component has a non-empty `config.qa_start_command`.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function registerTmpProject(name: string): Promise<{ id: string; cleanup: () => void }> {
	const dir = mkdtempSync(join(tmpdir(), "bobbit-comp-cfg-"));
	const res = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath: dir }),
	});
	expect(res.status).toBe(201);
	const proj = await res.json();
	return {
		id: proj.id,
		cleanup: () => {
			apiFetch(`/api/projects/${proj.id}?force=1`, { method: "DELETE" }).catch(() => {});
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}

const LEGACY_QA_KEYS = [
	"qa_start_command",
	"qa_build_command",
	"qa_health_check",
	"qa_browser_entry",
	"qa_env",
	"qa_max_duration_minutes",
	"qa_max_scenarios",
] as const;

test.describe("Component config map (REST API)", () => {
	test("PUT structured components[].config round-trips through GET", async () => {
		const { id, cleanup } = await registerTmpProject(`comp-cfg-${Date.now()}`);
		try {
			const components = [
				{
					name: "web",
					repo: ".",
					commands: { build: "npm run build", test: "npm test" },
					config: {
						qa_start_command: "PORT=$PORT NODE_ENV=test npm start",
						qa_health_check: "http://127.0.0.1:$PORT/health",
						qa_browser_entry: "http://127.0.0.1:$PORT/?token=$TOKEN",
						qa_max_duration_minutes: "12",
						qa_max_scenarios: "4",
					},
				},
			];
			const putRes = await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify({ components }),
			});
			expect(putRes.status).toBe(200);

			// Components endpoint round-trips the config map.
			const getRes = await apiFetch(`/api/projects/${id}/structured`);
			expect(getRes.status).toBe(200);
			const structured = await getRes.json();
			const web = (structured.components ?? []).find((c: any) => c.name === "web");
			expect(web).toBeTruthy();
			expect(web.config).toEqual(components[0].config);
		} finally {
			cleanup();
		}
	});

	test("PUT rejects all seven legacy top-level qa_* keys with migration message", async () => {
		const { id, cleanup } = await registerTmpProject(`comp-cfg-reject-${Date.now()}`);
		try {
			for (const key of LEGACY_QA_KEYS) {
				// Use a value type that would otherwise be valid (object for
				// qa_env, number for qa_max_*; string for everything else).
				const value: unknown = key === "qa_env"
					? { FOO: "bar" }
					: key.startsWith("qa_max_")
						? 10
						: "node server.js";
				const res = await apiFetch(`/api/projects/${id}/config`, {
					method: "PUT",
					body: JSON.stringify({ [key]: value }),
				});
				expect(res.status, `${key} should be rejected at top level`).toBe(400);
				const body = await res.json();
				expect(body.error, `${key} error should mention the migration target`).toMatch(/components\[\]\.config\[\]/);
				expect(body.error).toContain(key);
			}
		} finally {
			cleanup();
		}
	});

	test("GET /qa-testing-config returns { configured: boolean } based on any component's config.qa_start_command", async () => {
		const { id, cleanup } = await registerTmpProject(`comp-cfg-qa-${Date.now()}`);
		try {
			// Initially nothing configured.
			let res = await apiFetch(`/api/projects/${id}/qa-testing-config`);
			expect(res.status).toBe(200);
			let body = await res.json();
			expect(body).toEqual({ configured: false });

			// Add a component with no qa_start_command — still false.
			let putRes = await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify({
					components: [{ name: "web", repo: ".", commands: { build: "npm run build" } }],
				}),
			});
			expect(putRes.status).toBe(200);
			res = await apiFetch(`/api/projects/${id}/qa-testing-config`);
			body = await res.json();
			expect(body).toEqual({ configured: false });

			// Add qa_start_command on the component → configured: true.
			putRes = await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify({
					components: [{
						name: "web",
						repo: ".",
						commands: { build: "npm run build" },
						config: { qa_start_command: "PORT=$PORT npm start" },
					}],
				}),
			});
			expect(putRes.status).toBe(200);
			res = await apiFetch(`/api/projects/${id}/qa-testing-config`);
			body = await res.json();
			expect(body).toEqual({ configured: true });

			// Empty string for qa_start_command → still false.
			putRes = await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify({
					components: [{
						name: "web",
						repo: ".",
						commands: { build: "npm run build" },
						config: { qa_start_command: "" },
					}],
				}),
			});
			expect(putRes.status).toBe(200);
			res = await apiFetch(`/api/projects/${id}/qa-testing-config`);
			body = await res.json();
			expect(body).toEqual({ configured: false });
		} finally {
			cleanup();
		}
	});

	test("GET /api/projects/:id/config strips legacy top-level qa_* keys", async () => {
		const { id, cleanup } = await registerTmpProject(`comp-cfg-strip-${Date.now()}`);
		try {
			// Set components.config (legitimate path).
			const putRes = await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify({
					components: [{
						name: "web", repo: ".",
						config: {
							qa_start_command: "node s.js",
							qa_max_scenarios: "3",
						},
					}],
				}),
			});
			expect(putRes.status).toBe(200);

			const cfg = await (await apiFetch(`/api/projects/${id}/config`)).json();
			for (const key of LEGACY_QA_KEYS) {
				expect(cfg[key], `${key} must not appear at top level of GET config`).toBeUndefined();
			}
		} finally {
			cleanup();
		}
	});
});
