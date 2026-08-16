/**
 * API E2E tests for the project preflight + archive endpoints.
 * See docs/design/robust-add-project.md.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, rawApiFetch } from "./_e2e/e2e-setup.js";
import fs from "node:fs";
import path from "node:path";

let fixtureRoot = "";
let fixtureSequence = 0;

function freshRoot(label: string): string {
	// Keep fixtures beside (not inside) the harness default project. Reusing the
	// fork's short temp root avoids Windows temp/antivirus contention without
	// weakening the nested-project checks exercised below.
	const dir = path.join(fixtureRoot, `${++fixtureSequence}-${label}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

test.beforeAll(({ gateway }) => {
	fixtureRoot = path.join(gateway.bobbitDir, "preflight-fixtures");
	fs.mkdirSync(fixtureRoot, { recursive: true });
});

test.afterAll(() => {
	fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

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
		const dir = path.join(fixtureRoot, "does-not-exist");
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
		expect(body.report).toMatchObject({ rootPath: child, hasFail: true });
		expect(body.report?.checks).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "path.nested-in-project", level: "fail" }),
		]));
		expect(body.error).toContain("path.nested-in-project");
	});

	test("symlink registration preserves the canonical-path confirmation payload", async () => {
		const target = freshRoot("symlink-target");
		const link = path.join(fixtureRoot, `${++fixtureSequence}-symlink-link`);
		try {
			fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
		} catch {
			// Windows can deny junction creation in constrained CI environments.
			return;
		}

		const res = await rawApiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "Symlink", rootPath: link }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body).toEqual({
			error: "Project root is a symlink",
			code: "symlink_root",
			rootPath: link,
			canonical: fs.realpathSync(target),
		});
	});

	test("missing and duplicate roots return typed registration errors", async () => {
		const missing = path.join(fixtureRoot, `${++fixtureSequence}-missing`);
		let res = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "Missing", rootPath: missing }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "Project root path does not exist",
			code: "project_root_not_found",
		});

		const root = freshRoot("duplicate-root");
		res = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "Original", rootPath: root }),
		});
		expect(res.status).toBe(201);
		res = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "Duplicate", rootPath: root }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "A project is already registered at this root",
			code: "project_root_already_registered",
		});
	});

	test("duplicate-root update returns a typed error without mutating either project", async () => {
		const firstRoot = freshRoot("update-duplicate-first");
		const secondRoot = freshRoot("update-duplicate-second");
		const first = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "First", rootPath: firstRoot }),
		});
		expect(first.status).toBe(201);
		const firstProject = await first.json();
		const second = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "Second", rootPath: secondRoot }),
		});
		expect(second.status).toBe(201);
		const secondProject = await second.json();

		const update = await apiFetch(`/api/projects/${encodeURIComponent(secondProject.id)}`, {
			method: "PUT",
			body: JSON.stringify({ rootPath: firstRoot }),
		});
		expect(update.status).toBe(400);
		expect(await update.json()).toEqual({
			error: "A project is already registered at this root",
			code: "project_root_already_registered",
		});

		const [firstAfter, secondAfter] = await Promise.all([
			apiFetch(`/api/projects/${encodeURIComponent(firstProject.id)}`),
			apiFetch(`/api/projects/${encodeURIComponent(secondProject.id)}`),
		]);
		expect(await firstAfter.json()).toMatchObject({ id: firstProject.id, name: "First", rootPath: firstRoot });
		expect(await secondAfter.json()).toMatchObject({ id: secondProject.id, name: "Second", rootPath: secondRoot });
	});
});
