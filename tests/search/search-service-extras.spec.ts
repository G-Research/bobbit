/**
 * Unit tests for SearchService — per-project path isolation and the
 * collapsed state machine after the FlexSearch migration.
 */
import { test, expect } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { SearchService } from "../../src/server/search/search-service.ts";
import { ProgressBus } from "../../src/server/search/progress-bus.ts";
import { ProjectContext } from "../../src/server/agent/project-context.ts";

test("dataDir is scoped to stateDir (search.flex subdirectory)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-path-"));
	const svc = new SearchService({ stateDir: dir, projectId: "p1" });
	expect(svc.dataDir).toBe(path.join(dir, "search.flex"));
});

test("two SearchService instances use different dataDirs", () => {
	const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "svc-a-"));
	const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "svc-b-"));
	const s1 = new SearchService({ stateDir: dir1, projectId: "p1" });
	const s2 = new SearchService({ stateDir: dir2, projectId: "p2" });
	expect(s1.dataDir).not.toBe(s2.dataDir);
});

test("state transitions initializing → ready → closed", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-state-"));
	const svc = new SearchService({
		stateDir,
		projectId: "p1",
		progressBus: new ProgressBus(),
	});
	expect(svc.getState()).toBe("initializing");
	svc.open();
	await svc.whenReady();
	expect(svc.getState()).toBe("ready");
	await svc.close();
	expect(svc.getState()).toBe("closed");
});

test("legacy search.lance directory is removed on open", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-lance-"));
	const lanceDir = path.join(stateDir, "search.lance");
	fs.mkdirSync(lanceDir, { recursive: true });
	fs.writeFileSync(path.join(lanceDir, "junk.txt"), "old data");

	const svc = new SearchService({
		stateDir,
		projectId: "p1",
		progressBus: new ProgressBus(),
	});
	svc.open();
	await svc.whenReady();
	try {
		expect(fs.existsSync(lanceDir)).toBe(false);
		// FlexSearch dataDir exists instead.
		expect(fs.existsSync(path.join(stateDir, "search.flex"))).toBe(true);
	} finally {
		await svc.close();
	}
});

test("getEngineInfo reports flexsearch", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-engine-"));
	const svc = new SearchService({ stateDir: dir, projectId: "p1" });
	const info = svc.getEngineInfo();
	expect(info.engine).toBe("flexsearch");
	expect(typeof info.engineVersion).toBe("string");
	expect(info.engineVersion.length).toBeGreaterThan(0);
});

test("goal title updates refresh dependent session and message titles", async () => {
	const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-search-goal-title-"));
	const messageFile = path.join(rootPath, "session.jsonl");
	fs.writeFileSync(
		messageFile,
		JSON.stringify({ message: { role: "user", content: "RenameGoalTitleToken" } }) + "\n",
		"utf-8",
	);

	const ctx = new ProjectContext({
		id: "project-goal-title",
		name: "Goal Title Project",
		rootPath,
		createdAt: Date.now(),
		colorLight: "#2563eb",
		colorDark: "#60a5fa",
	});

	try {
		ctx.open();
		await ctx.searchIndex.whenReady();
		ctx.goalStore.put({
			id: "goal-title",
			title: "Old Goal",
			cwd: rootPath,
			state: "in-progress",
			spec: "",
			createdAt: 1,
			updatedAt: 1,
			projectId: "project-goal-title",
		});
		const session = {
			id: "session-title",
			title: "Grouped Session",
			cwd: rootPath,
			agentSessionFile: messageFile,
			createdAt: 2,
			lastActivity: 3,
			goalId: "goal-title",
			projectId: "project-goal-title",
		};
		ctx.sessionStore.put(session);
		ctx.searchIndex.reindexMessagesForSession(session, "Old Goal", "project-goal-title");

		await expect.poll(async () => {
			const results = await ctx.searchIndex.search("RenameGoalTitleToken", { type: "messages", limit: 5 });
			return results.results[0]?.sessionTitle ?? "";
		}, { timeout: 5_000 }).toBe("Old Goal: Grouped Session");

		ctx.goalStore.update("goal-title", { title: "New Goal" });

		await expect.poll(async () => {
			const results = await ctx.searchIndex.search("RenameGoalTitleToken", { type: "messages", limit: 5 });
			return results.results[0]?.sessionTitle ?? "";
		}, { timeout: 5_000 }).toBe("New Goal: Grouped Session");

		await expect.poll(async () => {
			const results = await ctx.searchIndex.search("Grouped Session", { type: "sessions", limit: 5 });
			return results.results[0]?.title ?? "";
		}, { timeout: 5_000 }).toBe("New Goal: Grouped Session");
	} finally {
		await ctx.searchIndex.close();
		fs.rmSync(rootPath, { recursive: true, force: true });
	}
});
