/**
 * SearchService/ProjectContext wiring tests for FilesIndexSource
 * (NAV-doc-knowledge-retrieval / F10). Covers:
 *   - `projectRoot` opts in the `files` source into the default rebuild set.
 *   - Omitting `projectRoot` is back-compat: no `files` source, no crash.
 *   - `ProjectContext` passes its `project.rootPath` through automatically.
 */

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SearchService } from "../../src/server/search/search-service.ts";
import { ProgressBus } from "../../src/server/search/progress-bus.ts";
import { ProjectContext } from "../../src/server/agent/project-context.ts";
import type { GoalStore } from "../../src/server/agent/goal-store.ts";
import type { SessionStore } from "../../src/server/agent/session-store.ts";
import type { StaffStore } from "../../src/server/agent/staff-store.ts";

function emptyGoalStore(): GoalStore {
	return { getAll: () => [] } as unknown as GoalStore;
}
function emptySessionStore(): SessionStore {
	return { getAll: () => [] } as unknown as SessionStore;
}
function emptyStaffStore(): StaffStore {
	return { getAll: () => [] } as unknown as StaffStore;
}

test("rebuildFromStores indexes docs/** when projectRoot is configured", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-files-state-"));
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "svc-files-root-"));
	fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
	fs.writeFileSync(
		path.join(projectRoot, "docs", "guide.md"),
		"# Guide\n\nQuackerSvcFilesToken is documented here.\n",
	);

	const svc = new SearchService({ stateDir, projectId: "p-files", progressBus: new ProgressBus(), projectRoot });
	try {
		svc.open();
		await svc.whenReady();
		await svc.rebuildFromStores(emptyGoalStore(), emptySessionStore(), undefined, emptyStaffStore());

		const results = await svc.search("QuackerSvcFilesToken", { type: "files", limit: 5 });
		expect(results.results.length).toBe(1);
		expect(results.results[0].filePath).toBe("docs/guide.md");
		expect(results.results[0].type).toBe("file");

		const stats = await svc.getStats();
		expect(stats.rowCountsBySource.files).toBe(1);
	} finally {
		await svc.close();
		fs.rmSync(stateDir, { recursive: true, force: true });
		fs.rmSync(projectRoot, { recursive: true, force: true });
	}
});

test("files source is skipped when projectRoot is omitted (back-compat)", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-nofiles-state-"));
	const svc = new SearchService({ stateDir, projectId: "p-nofiles", progressBus: new ProgressBus() });
	try {
		svc.open();
		await svc.whenReady();
		await svc.rebuildFromStores(emptyGoalStore(), emptySessionStore(), undefined, emptyStaffStore());
		const stats = await svc.getStats();
		expect(stats.rowCountsBySource.files).toBe(0);

		const results = await svc.search("anything", { type: "files", limit: 5 });
		expect(results.results.length).toBe(0);
	} finally {
		await svc.close();
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("ProjectContext wires project.rootPath into its SearchService automatically", async () => {
	const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-files-root-"));
	fs.mkdirSync(path.join(rootPath, "docs"), { recursive: true });
	fs.writeFileSync(
		path.join(rootPath, "docs", "arch.md"),
		"# Architecture\n\nQuackerCtxFilesToken lives here.\n",
	);

	const ctx = new ProjectContext({
		id: "project-files-wiring",
		name: "Files Wiring Project",
		rootPath,
		createdAt: Date.now(),
		colorLight: "#2563eb",
		colorDark: "#60a5fa",
	});

	try {
		ctx.open();
		await ctx.searchIndex.whenReady();
		await ctx.searchIndex.rebuildFromStores(ctx.goalStore, ctx.sessionStore, undefined, ctx.staffStore);

		await expect.poll(async () => {
			const results = await ctx.searchIndex.search("QuackerCtxFilesToken", { type: "files", limit: 5 });
			return results.results.length;
		}, { timeout: 5_000 }).toBe(1);
	} finally {
		await ctx.searchIndex.close();
		fs.rmSync(rootPath, { recursive: true, force: true });
	}
});
