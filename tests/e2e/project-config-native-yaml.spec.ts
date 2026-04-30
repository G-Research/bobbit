/**
 * API E2E — Native-YAML migration for project.yaml fields.
 *
 * Covers the five migrated fields:
 *   - config_directories
 *   - qa_env
 *   - sandbox_tokens
 *   - qa_max_duration_minutes
 *   - qa_max_scenarios
 *
 * Verifies:
 *   1. PUT with structured payloads persists, GET returns structured.
 *   2. On-disk project.yaml contains zero JSON-encoded strings / numeric strings.
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
			apiFetch(`/api/projects/${proj.id}?force=1`, { method: "DELETE" }).catch(() => {});
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
				qa_env: { FOO: "bar", BAZ: "qux" },
				sandbox_tokens: [
					{ key: "GITHUB_TOKEN", enabled: true },
					{ key: "NPM_TOKEN", enabled: false },
				],
				qa_max_duration_minutes: 15,
				qa_max_scenarios: 7,
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
			expect(cfg.qa_env).toEqual(payload.qa_env);
			expect(Array.isArray(cfg.sandbox_tokens)).toBe(true);
			expect(cfg.sandbox_tokens).toEqual([
				{ key: "GITHUB_TOKEN", enabled: true, value: "" },
				{ key: "NPM_TOKEN", enabled: false, value: "" },
			]);
			expect(cfg.qa_max_duration_minutes).toBe(15);
			expect(cfg.qa_max_scenarios).toBe(7);

			// On-disk YAML is native (no escaped JSON, no quoted numbers)
			const text = readProjectYaml(rootPath);
			expect(text).not.toMatch(/\[\{\\"/);     // escaped JSON array
			expect(text).not.toMatch(/'\{\\"/);      // escaped JSON object
			expect(text).not.toMatch(/qa_max_duration_minutes:\s*"\d+"/);
			expect(text).not.toMatch(/qa_max_scenarios:\s*"\d+"/);
			expect(text).toMatch(/qa_max_duration_minutes:\s*15/);
			expect(text).toMatch(/qa_max_scenarios:\s*7/);
			// Sandbox token `value` field never on disk.
			expect(text).not.toMatch(/value:/);
		} finally {
			cleanup();
		}
	});

	test("PUT rejects legacy JSON-string payloads for migrated fields", async () => {
		const { id, cleanup } = await registerTmpProject(`nyaml-reject-${Date.now()}`);
		try {
			for (const field of ["config_directories", "qa_env", "sandbox_tokens"]) {
				const res = await apiFetch(`/api/projects/${id}/config`, {
					method: "PUT",
					body: JSON.stringify({ [field]: JSON.stringify([{ path: "/x", types: ["skills"] }]) }),
				});
				expect(res.status, `${field} should reject string payload`).toBe(400);
				const body = await res.json();
				expect(body.error).toMatch(/structured/i);
			}
			// Numeric fields: a string-encoded number must also be rejected.
			for (const field of ["qa_max_duration_minutes", "qa_max_scenarios"]) {
				const res = await apiFetch(`/api/projects/${id}/config`, {
					method: "PUT",
					body: JSON.stringify({ [field]: "15" }),
				});
				expect(res.status, `${field} should reject string payload`).toBe(400);
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
				`qa_env: '${JSON.stringify({ FOO: "bar" })}'`,
				`sandbox_tokens: '${JSON.stringify([{ key: "GITHUB_TOKEN", enabled: true }])}'`,
				`qa_max_duration_minutes: "20"`,
				`qa_max_scenarios: "4"`,
				`qa_start_command: "node server.js"`,
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
				expect(cfg.qa_env).toEqual({ FOO: "bar" });
				expect(cfg.qa_max_duration_minutes).toBe(20);
				expect(cfg.qa_max_scenarios).toBe(4);

				// Trigger a save: edit a flat key.
				const putRes = await apiFetch(`/api/projects/${proj.id}/config`, {
					method: "PUT",
					body: JSON.stringify({ qa_health_check: "http://localhost/health" }),
				});
				expect(putRes.status).toBe(200);

				// On-disk YAML is now native — no escaped JSON, no quoted numbers.
				const text = readFileSync(join(cfgDir, "project.yaml"), "utf-8");
				expect(text).not.toMatch(/\[\{\\"/);
				expect(text).not.toMatch(/qa_max_duration_minutes:\s*"\d+"/);
				expect(text).toMatch(/qa_max_duration_minutes:\s*20/);
				expect(text).toMatch(/qa_max_scenarios:\s*4/);
			} finally {
				await apiFetch(`/api/projects/${proj.id}?force=1`, { method: "DELETE" }).catch(() => {});
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
				body: JSON.stringify({ qa_max_duration_minutes: 42 }),
			});
			let cfg = await (await apiFetch(`/api/projects/${id}/config`)).json();
			expect(cfg.qa_max_duration_minutes).toBe(42);

			await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify({ qa_max_duration_minutes: null }),
			});
			cfg = await (await apiFetch(`/api/projects/${id}/config`)).json();
			// After clear, returns the default.
			expect(cfg.qa_max_duration_minutes).toBe(10);
		} finally {
			cleanup();
		}
	});
});
