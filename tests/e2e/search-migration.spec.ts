/**
 * E2E: legacy `search.db` migration.
 *
 * When the SearchService opens a project that still has a legacy FTS5
 * `search.db` (+ WAL/SHM siblings) in its state dir, the files must be
 * deleted and a `search.lance/` dataset must exist alongside. Design §10.
 *
 * Approach: register a fresh project pointing at a tmp dir that contains
 * placeholder `search.db*` files. Creating the project triggers
 * `ProjectContext.open()` → `SearchService.open()` → cleanup. We then
 * poll the stats endpoint until the service reaches "ready" and assert
 * the filesystem side-effects.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test.setTimeout(60_000);

function tmpProjectDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "search-migration-"));
	// Pre-create .bobbit/state/search.db (+ WAL/SHM) as the legacy FTS5
	// layout. Contents are arbitrary binary bytes — the migration code
	// checks for file existence and unlinks unconditionally.
	const stateDir = path.join(dir, ".bobbit", "state");
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(path.join(stateDir, "search.db"), "SQLite format 3\0legacy-payload");
	fs.writeFileSync(path.join(stateDir, "search.db-wal"), "wal-payload");
	fs.writeFileSync(path.join(stateDir, "search.db-shm"), "shm-payload");
	return dir;
}

async function waitForReady(projectId: string, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	let lastState = "unknown";
	while (Date.now() - start < timeoutMs) {
		const resp = await apiFetch(`/api/search/stats?projectId=${encodeURIComponent(projectId)}`);
		if (resp.status === 200) {
			const body = await resp.json();
			lastState = body.state;
			if (body.state === "ready" || body.state === "disabled-no-native" || body.state === "disabled-no-model") {
				return;
			}
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`Search service did not reach ready in ${timeoutMs}ms (last state: ${lastState})`);
}

test("legacy search.db files are deleted on SearchService open; search.lance/ is created", async () => {
	const projectRoot = tmpProjectDir();
	const stateDir = path.join(projectRoot, ".bobbit", "state");

	// Sanity: the legacy files exist BEFORE the project is registered.
	expect(fs.existsSync(path.join(stateDir, "search.db"))).toBe(true);
	expect(fs.existsSync(path.join(stateDir, "search.db-wal"))).toBe(true);
	expect(fs.existsSync(path.join(stateDir, "search.db-shm"))).toBe(true);

	// Register the project. This triggers ProjectContext.open() which
	// opens LanceDB and cleans up the legacy sqlite files.
	const createResp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name: "migration-test", rootPath: projectRoot, upsert: true }),
	});
	expect([200, 201]).toContain(createResp.status);
	const project = await createResp.json();
	expect(project.id).toBeTruthy();

	// Wait for the service to reach a terminal state.
	await waitForReady(project.id);

	// Legacy files must be gone.
	expect(fs.existsSync(path.join(stateDir, "search.db"))).toBe(false);
	expect(fs.existsSync(path.join(stateDir, "search.db-wal"))).toBe(false);
	expect(fs.existsSync(path.join(stateDir, "search.db-shm"))).toBe(false);

	// LanceDB dataset directory must exist.
	expect(fs.existsSync(path.join(stateDir, "search.lance"))).toBe(true);

	// Seed a goal so we can confirm search works end-to-end post-migration.
	const goalResp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: "Migration target goal",
			spec: "This goal mentions a unique token migration-uniq-token-123 for search.",
			projectId: project.id,
		}),
	});
	expect([200, 201]).toContain(goalResp.status);

	// Give the async indexer a moment to upsert the goal row.
	await new Promise((r) => setTimeout(r, 500));

	// Search for the unique token. We accept 200 with any non-empty results
	// OR 200 with empty results + retry, since indexing is async. Retry a
	// few times before failing.
	let found = false;
	for (let i = 0; i < 10; i++) {
		const q = new URLSearchParams({
			q: "migration-uniq-token-123",
			projectId: project.id,
		});
		const searchResp = await apiFetch(`/api/search?${q.toString()}`);
		if (searchResp.status === 200) {
			const body = await searchResp.json();
			const results = Array.isArray(body) ? body : body.results;
			if (Array.isArray(results) && results.length > 0) {
				found = true;
				break;
			}
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	expect(found).toBe(true);

	// Cleanup the tmp project dir. Best-effort.
	try {
		fs.rmSync(projectRoot, { recursive: true, force: true });
	} catch {
		/* noop */
	}
});
