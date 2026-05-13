/**
 * API E2E — Native-YAML migration for project.yaml fields.
 *
 * After the component-config migration, only two migrated fields remain:
 *   - config_directories
 *   - sandbox_tokens
 *
 * The seven legacy QA top-level keys (qa_start_command, qa_build_command,
 * qa_health_check, qa_browser_entry, qa_env, qa_max_duration_minutes,
 * qa_max_scenarios) have moved into `components[].config` and are now
 * REJECTED at the top level of PUT payloads with HTTP 400.
 *
 * Verifies:
 *   1. PUT with structured payloads persists, GET returns structured.
 *   2. On-disk project.yaml contains zero JSON-encoded strings.
 *   3. PUT rejects legacy JSON-string payloads with 400.
 *   4. Loading a legacy-format fixture parses correctly and a single save
 *      rewrites it in native form.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function registerTmpProject(name: string): Promise<{ id: string; rootPath: string; cleanup: () => void }> {
	const dir = mkdtempSync(join(tmpdir(), "bobbit-nativeyaml-"));
	const res = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath: dir }),
	});
	expect(res.status).toBe(201);
	const proj = await res.json();
	return {
		id: proj.id,
		rootPath: dir,
		cleanup: () => {
			apiFetch(`/api/projects/${proj.id}`, { method: "DELETE" }).catch(() => {});
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}

function readProjectYaml(rootPath: string): string {
	return readFileSync(join(rootPath, ".bobbit", "config", "project.yaml"), "utf-8");
}

test.describe("Native-YAML project.yaml fields", () => {
	test("PUT structured payloads persists; GET returns structured; on-disk is native", async () => {
		const { id, rootPath, cleanup } = await registerTmpProject(`nyaml-${Date.now()}`);
		try {
			const payload = {
				config_directories: [
					{ path: "/shared/skills", types: ["skills"] },
					{ path: "/team/tools", types: ["tools", "mcp"] },
				],
				sandbox_tokens: [
					{ key: "GITHUB_TOKEN", enabled: true },
					{ key: "NPM_TOKEN", enabled: false },
				],
			};
			const putRes = await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify(payload),
			});
			expect(putRes.status).toBe(200);

			// GET returns structured
			const getRes = await apiFetch(`/api/projects/${id}/config`);
			expect(getRes.status).toBe(200);
			const cfg = await getRes.json();
			expect(Array.isArray(cfg.config_directories)).toBe(true);
			expect(cfg.config_directories).toEqual(payload.config_directories);
			expect(Array.isArray(cfg.sandbox_tokens)).toBe(true);
			expect(cfg.sandbox_tokens).toEqual([
				{ key: "GITHUB_TOKEN", enabled: true, value: "" },
				{ key: "NPM_TOKEN", enabled: false, value: "" },
			]);
			// Legacy top-level qa_* keys are stripped from GET responses.
			expect(cfg.qa_env).toBeUndefined();
			expect(cfg.qa_max_duration_minutes).toBeUndefined();
			expect(cfg.qa_max_scenarios).toBeUndefined();

			// On-disk YAML is native (no escaped JSON, no quoted numbers)
			const text = readProjectYaml(rootPath);
			expect(text).not.toMatch(/\[\{\\"/);     // escaped JSON array
			expect(text).not.toMatch(/'\{\\"/);      // escaped JSON object
			// Sandbox token `value` field never on disk.
			expect(text).not.toMatch(/value:/);
		} finally {
			cleanup();
		}
	});

	test("PUT rejects legacy JSON-string payloads for migrated fields", async () => {
		const { id, cleanup } = await registerTmpProject(`nyaml-reject-${Date.now()}`);
		try {
			for (const field of ["config_directories", "sandbox_tokens"]) {
				const res = await apiFetch(`/api/projects/${id}/config`, {
					method: "PUT",
					body: JSON.stringify({ [field]: JSON.stringify([{ path: "/x", types: ["skills"] }]) }),
				});
				expect(res.status, `${field} should reject string payload`).toBe(400);
				const body = await res.json();
				expect(body.error).toMatch(/structured/i);
			}
			// Legacy top-level qa_* keys are rejected entirely with the
			// migration guidance message.
			for (const field of [
				"qa_env", "qa_start_command", "qa_build_command", "qa_health_check",
				"qa_browser_entry", "qa_max_duration_minutes", "qa_max_scenarios",
			]) {
				const res = await apiFetch(`/api/projects/${id}/config`, {
					method: "PUT",
					body: JSON.stringify({ [field]: "15" }),
				});
				expect(res.status, `${field} should be rejected at top level`).toBe(400);
				const body = await res.json();
				expect(body.error).toMatch(/components\[\]\.config\[\]/);
			}
		} finally {
			cleanup();
		}
	});

	test("Legacy on-disk project.yaml loads correctly and is rewritten native on next save", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bobbit-nativeyaml-legacy-"));
		try {
			// Hand-write a legacy-format project.yaml BEFORE registering the project.
			const cfgDir = join(dir, ".bobbit", "config");
			mkdirSync(cfgDir, { recursive: true });
			const legacyYaml = [
				`config_directories: '${JSON.stringify([{ path: "/legacy", types: ["skills"] }])}'`,
				`sandbox_tokens: '${JSON.stringify([{ key: "GITHUB_TOKEN", enabled: true }])}'`,
			].join("\n") + "\n";
			writeFileSync(join(cfgDir, "project.yaml"), legacyYaml);

			// Register the project — load() picks up legacy form, isDirty=true.
			const res = await apiFetch("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: `nyaml-legacy-${Date.now()}`, rootPath: dir }),
			});
			expect(res.status).toBe(201);
			const proj = await res.json();
			try {
				// GET returns parsed structured form.
				const getRes = await apiFetch(`/api/projects/${proj.id}/config`);
				const cfg = await getRes.json();
				expect(cfg.config_directories).toEqual([{ path: "/legacy", types: ["skills"] }]);

				// Trigger a save: edit a flat key.
				const putRes = await apiFetch(`/api/projects/${proj.id}/config`, {
					method: "PUT",
					body: JSON.stringify({ build_command: "echo build" }),
				});
				expect(putRes.status).toBe(200);

				// On-disk YAML is now native — no escaped JSON.
				const text = readFileSync(join(cfgDir, "project.yaml"), "utf-8");
				expect(text).not.toMatch(/\[\{\\"/);
			} finally {
				await apiFetch(`/api/projects/${proj.id}`, { method: "DELETE" }).catch(() => {});
			}
		} finally {
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test("Setting null clears migrated fields", async () => {
		const { id, cleanup } = await registerTmpProject(`nyaml-clear-${Date.now()}`);
		try {
			// Set, then clear, then confirm cleared.
			await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify({
					config_directories: [{ path: "/x", types: ["skills"] }],
				}),
			});
			let cfg = await (await apiFetch(`/api/projects/${id}/config`)).json();
			expect(cfg.config_directories).toEqual([{ path: "/x", types: ["skills"] }]);

			await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify({ config_directories: null }),
			});
			cfg = await (await apiFetch(`/api/projects/${id}/config`)).json();
			expect(cfg.config_directories).toEqual([]);
		} finally {
			cleanup();
		}
	});
});
