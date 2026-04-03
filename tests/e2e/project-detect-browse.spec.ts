/**
 * E2E tests for POST /api/projects/detect and GET /api/browse-directory endpoints.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, bobbitDir } from "./e2e-setup.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// POST /api/projects/detect
// ---------------------------------------------------------------------------

test.describe("POST /api/projects/detect", () => {
	let testRoot: string;

	test.beforeAll(() => {
		testRoot = join(bobbitDir(), "detect-test");
		mkdirSync(testRoot, { recursive: true });
	});

	test.afterAll(() => {
		rmSync(testRoot, { recursive: true, force: true });
	});

	test("directory with .bobbit/ returns hasBobbit true", async () => {
		const dir = join(testRoot, "with-bobbit");
		mkdirSync(join(dir, ".bobbit"), { recursive: true });

		const res = await apiFetch("/api/projects/detect", {
			method: "POST",
			body: JSON.stringify({ path: dir }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.exists).toBe(true);
		expect(data.hasBobbit).toBe(true);
		expect(data.isEmpty).toBe(false);
	});

	test("directory without .bobbit/ returns hasBobbit false", async () => {
		const dir = join(testRoot, "without-bobbit");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "README.md"), "# test");

		const res = await apiFetch("/api/projects/detect", {
			method: "POST",
			body: JSON.stringify({ path: dir }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.exists).toBe(true);
		expect(data.hasBobbit).toBe(false);
		expect(data.isEmpty).toBe(false);
	});

	test("empty directory returns isEmpty true", async () => {
		const dir = join(testRoot, "empty-dir");
		mkdirSync(dir, { recursive: true });

		const res = await apiFetch("/api/projects/detect", {
			method: "POST",
			body: JSON.stringify({ path: dir }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.exists).toBe(true);
		expect(data.isEmpty).toBe(true);
	});

	test("non-existent directory returns exists false and isEmpty true", async () => {
		const dir = join(testRoot, "does-not-exist");

		const res = await apiFetch("/api/projects/detect", {
			method: "POST",
			body: JSON.stringify({ path: dir }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.exists).toBe(false);
		expect(data.isEmpty).toBe(true);
	});

	test("directory with package.json returns name from it", async () => {
		const dir = join(testRoot, "with-pkg");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-cool-project" }));

		const res = await apiFetch("/api/projects/detect", {
			method: "POST",
			body: JSON.stringify({ path: dir }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.hasPackageJson).toBe(true);
		expect(data.name).toBe("my-cool-project");
	});

	test("directory without package.json returns directory basename as name", async () => {
		const dir = join(testRoot, "my-folder-name");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "README.md"), "# test");

		const res = await apiFetch("/api/projects/detect", {
			method: "POST",
			body: JSON.stringify({ path: dir }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.hasPackageJson).toBe(false);
		expect(data.name).toBe("my-folder-name");
	});

	test("missing path returns 400", async () => {
		const res = await apiFetch("/api/projects/detect", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});
});

// ---------------------------------------------------------------------------
// GET /api/browse-directory
// ---------------------------------------------------------------------------

test.describe("GET /api/browse-directory", () => {
	let testRoot: string;

	test.beforeAll(() => {
		testRoot = join(bobbitDir(), "browse-test");
		mkdirSync(testRoot, { recursive: true });
		// Create some subdirectories
		mkdirSync(join(testRoot, "alpha"), { recursive: true });
		mkdirSync(join(testRoot, "beta"), { recursive: true });
		mkdirSync(join(testRoot, "gamma"), { recursive: true });
		// Create a file (should not appear in results)
		writeFileSync(join(testRoot, "file.txt"), "not a directory");
		// Create a hidden directory (should not appear in results)
		mkdirSync(join(testRoot, ".hidden"), { recursive: true });
		// Create node_modules (should not appear in results)
		mkdirSync(join(testRoot, "node_modules"), { recursive: true });
	});

	test.afterAll(() => {
		rmSync(testRoot, { recursive: true, force: true });
	});

	test("default path returns server CWD listing", async () => {
		const res = await apiFetch("/api/browse-directory");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.current).toBeTruthy();
		expect(Array.isArray(data.entries)).toBe(true);
		// parent should be a string (unless at root)
		expect(typeof data.parent === "string" || data.parent === null).toBe(true);
	});

	test("with path param returns that directory subdirectories", async () => {
		const res = await apiFetch(`/api/browse-directory?path=${encodeURIComponent(testRoot)}`);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.current).toBe(testRoot);
		const names = data.entries.map((e: any) => e.name);
		expect(names).toContain("alpha");
		expect(names).toContain("beta");
		expect(names).toContain("gamma");
	});

	test("non-existent path returns 404", async () => {
		const res = await apiFetch(`/api/browse-directory?path=${encodeURIComponent(join(testRoot, "nonexistent"))}`);
		expect(res.status).toBe(404);
	});

	test("entries are directories only — no files, hidden dirs, or node_modules", async () => {
		const res = await apiFetch(`/api/browse-directory?path=${encodeURIComponent(testRoot)}`);
		expect(res.status).toBe(200);
		const data = await res.json();
		const names = data.entries.map((e: any) => e.name);
		// Should not include the file
		expect(names).not.toContain("file.txt");
		// Should not include hidden directory
		expect(names).not.toContain(".hidden");
		// Should not include node_modules
		expect(names).not.toContain("node_modules");
		// Should only have the three directories
		expect(names).toEqual(["alpha", "beta", "gamma"]);
	});

	test("entries are sorted alphabetically", async () => {
		const res = await apiFetch(`/api/browse-directory?path=${encodeURIComponent(testRoot)}`);
		expect(res.status).toBe(200);
		const data = await res.json();
		const names = data.entries.map((e: any) => e.name);
		const sorted = [...names].sort();
		expect(names).toEqual(sorted);
	});
});
