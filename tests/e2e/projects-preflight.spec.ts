/**
 * API E2E tests for the project preflight + archive endpoints.
 * See docs/design/robust-add-project.md.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function freshRoot(label: string): string {
	// Use the real OS tmpdir, not bobbitDir() — the in-process harness
	// auto-registers a "default" project at the e2e bobbit dir, and anything
	// nested inside it would trip path.nested-in-project.
	const dir = path.join(os.tmpdir(), `bobbit-preflight-e2e-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

test.describe("GET /api/projects/preflight", () => {
	test("missing path → 400", async () => {
		const res = await apiFetch("/api/projects/preflight");
		expect(res.status).toBe(400);
	});

	test("happy path: empty dir → hasFail=false with all expected check ids", async () => {
		const dir = freshRoot("happy");
		const res = await apiFetch(`/api/projects/preflight?path=${encodeURIComponent(dir)}`);
		expect(res.status).toBe(200);
		const report = await res.json();
		expect(report.rootPath).toBe(dir);
		const failing = report.checks.filter((c: any) => c.level === "fail");
		expect(failing, JSON.stringify(failing, null, 2)).toEqual([]);
		const ids = report.checks.map((c: any) => c.id);
		for (const expected of [
			"path.absolute",
			"path.exists",
			"path.symlink",
			"path.readable",
			"path.writable",
			"path.long",
			"path.unc-or-network",
			"path.nested-in-project",
			"path.contains-project",
			"path.is-worktree",
			"bobbit.existing",
			"bobbit.gateway-owned",
			"git.repo",
			"disk.space",
		]) {
			expect(ids).toContain(expected);
		}
	});

	test("relative path → path.absolute fails, hasFail=true", async () => {
		const res = await apiFetch(`/api/projects/preflight?path=${encodeURIComponent("relative/p")}`);
		expect(res.status).toBe(200);
		const report = await res.json();
		expect(report.hasFail).toBe(true);
		expect(report.checks.find((c: any) => c.id === "path.absolute").level).toBe("fail");
	});

	test("existing .bobbit/ content → warn with remediation", async () => {
		const dir = freshRoot("existing-bobbit");
		const stateDir = path.join(dir, ".bobbit", "state");
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "sessions.json"), JSON.stringify([{ id: "x" }]));
		const res = await apiFetch(`/api/projects/preflight?path=${encodeURIComponent(dir)}`);
		expect(res.status).toBe(200);
		const report = await res.json();
		const check = report.checks.find((c: any) => c.id === "bobbit.existing");
		expect(check.level).toBe("warn");
		expect(check.remediation?.kind).toBe("archive-bobbit");
	});
});

test.describe("POST /api/projects/archive-bobbit", () => {
	test("missing rootPath → 400", async () => {
		const res = await apiFetch("/api/projects/archive-bobbit", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("non-existent rootPath → 400", async () => {
		const dir = path.join(os.tmpdir(), "does-not-exist-" + Date.now());
		const res = await apiFetch("/api/projects/archive-bobbit", {
			method: "POST",
			body: JSON.stringify({ rootPath: dir }),
		});
		expect(res.status).toBe(400);
	});

	test("rootPath with no .bobbit/ → 409", async () => {
		const dir = freshRoot("no-bobbit");
		const res = await apiFetch("/api/projects/archive-bobbit", {
			method: "POST",
			body: JSON.stringify({ rootPath: dir }),
		});
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.code).toBe("no-bobbit-dir");
	});

	test("happy path: archives .bobbit/ to .bobbit-archive-001/", async () => {
		const dir = freshRoot("archive-happy");
		const stateDir = path.join(dir, ".bobbit", "state");
		const configDir = path.join(dir, ".bobbit", "config");
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "goals.json"), "[]");
		fs.writeFileSync(path.join(configDir, "system-prompt.md"), "# p");

		const res = await apiFetch("/api/projects/archive-bobbit", {
			method: "POST",
			body: JSON.stringify({ rootPath: dir }),
		});
		expect(res.status).toBe(200);
		const result = await res.json();
		expect(result.archiveDir).toMatch(/\.bobbit-archive-001$/);
		expect(result.movedPaths.length).toBeGreaterThan(0);
		expect(fs.existsSync(path.join(result.archiveDir, "MANIFEST.json"))).toBe(true);
	});

	test("combined flow: preflight → archive → preflight (now clean)", async () => {
		const dir = freshRoot("combined");
		fs.mkdirSync(path.join(dir, ".bobbit", "state"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".bobbit", "state", "goals.json"), "[]");

		// preflight 1 → bobbit.existing warns
		let res = await apiFetch(`/api/projects/preflight?path=${encodeURIComponent(dir)}`);
		let report = await res.json();
		expect(report.checks.find((c: any) => c.id === "bobbit.existing").level).toBe("warn");

		// archive
		res = await apiFetch("/api/projects/archive-bobbit", {
			method: "POST",
			body: JSON.stringify({ rootPath: dir }),
		});
		expect(res.status).toBe(200);

		// preflight 2 → bobbit.existing now passes
		res = await apiFetch(`/api/projects/preflight?path=${encodeURIComponent(dir)}`);
		report = await res.json();
		expect(report.checks.find((c: any) => c.id === "bobbit.existing").level).toBe("pass");
	});
});

test.describe("server-side preflight defense in depth (POST /api/projects)", () => {
	test("registering a path nested inside an existing project is rejected with code=preflight_failed", async () => {
		const parent = freshRoot("preflight-parent");
		const child = path.join(parent, "nested");
		fs.mkdirSync(child, { recursive: true });

		// First, register the parent.
		let res = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "Parent", rootPath: parent }),
		});
		expect(res.status).toBe(201);

		// Try to register the child — should fail with preflight_failed.
		res = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "Child", rootPath: child }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.code).toBe("preflight_failed");
		expect(body.report?.hasFail).toBe(true);
	});
});
