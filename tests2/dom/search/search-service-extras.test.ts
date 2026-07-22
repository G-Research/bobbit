import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
/**
 * Unit tests for SearchService — per-project path isolation and the
 * collapsed state machine after the FlexSearch migration.
 */
import { expect, test } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { SearchService } from "../../../src/server/search/search-service.ts";
import { ProgressBus } from "../../../src/server/search/progress-bus.ts";
import { ProjectContext } from "../../../src/server/agent/project-context.ts";

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

test("session title updates refresh dependent message titles", async () => {
	const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-search-session-title-"));
	const messageFile = path.join(rootPath, "session.jsonl");
	fs.writeFileSync(
		messageFile,
		JSON.stringify({ message: { role: "user", content: "RenameSessionTitleToken" } }) + "\n",
		"utf-8",
	);

	const ctx = new ProjectContext({
		id: "project-session-title",
		name: "Session Title Project",
		rootPath,
		createdAt: Date.now(),
		colorLight: "#2563eb",
		colorDark: "#60a5fa",
	});

	try {
		ctx.open();
		await ctx.searchIndex.whenReady();
		ctx.sessionStore.put({
			id: "session-title-refresh",
			title: "",
			cwd: rootPath,
			agentSessionFile: messageFile,
			createdAt: 2,
			lastActivity: 3,
			projectId: "project-session-title",
		});

		await expect.poll(async () => {
			const results = await ctx.searchIndex.search("RenameSessionTitleToken", { type: "messages", limit: 5 });
			return results.results.length;
		}, { timeout: 5_000 }).toBe(1);

		ctx.sessionStore.update("session-title-refresh", { title: "Generated Session Title" });

		await expect.poll(async () => {
			const results = await ctx.searchIndex.search("RenameSessionTitleToken", { type: "messages", limit: 5 });
			return results.results[0]?.sessionTitle ?? "";
		}, { timeout: 5_000 }).toBe("Generated Session Title");
	} finally {
		await ctx.searchIndex.close();
		fs.rmSync(rootPath, { recursive: true, force: true });
	}
});

test("session goal ownership updates refresh dependent message title prefixes", async () => {
	const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-search-session-goal-"));
	const messageFile = path.join(rootPath, "session.jsonl");
	fs.writeFileSync(
		messageFile,
		JSON.stringify({ message: { role: "user", content: "SessionGoalPrefixToken" } }) + "\n",
		"utf-8",
	);

	const ctx = new ProjectContext({
		id: "project-session-goal",
		name: "Session Goal Project",
		rootPath,
		createdAt: Date.now(),
		colorLight: "#2563eb",
		colorDark: "#60a5fa",
	});

	try {
		ctx.open();
		await ctx.searchIndex.whenReady();
		ctx.goalStore.put({
			id: "goal-prefix",
			title: "Goal Prefix",
			cwd: rootPath,
			state: "in-progress",
			spec: "",
			createdAt: 1,
			updatedAt: 1,
			projectId: "project-session-goal",
		});
		ctx.sessionStore.put({
			id: "session-goal-refresh",
			title: "Grouped Session",
			cwd: rootPath,
			agentSessionFile: messageFile,
			createdAt: 2,
			lastActivity: 3,
			projectId: "project-session-goal",
		});

		await expect.poll(async () => {
			const results = await ctx.searchIndex.search("SessionGoalPrefixToken", { type: "messages", limit: 5 });
			return results.results[0]?.sessionTitle ?? "";
		}, { timeout: 5_000 }).toBe("Grouped Session");

		ctx.sessionStore.update("session-goal-refresh", { goalId: "goal-prefix" });

		await expect.poll(async () => {
			const results = await ctx.searchIndex.search("SessionGoalPrefixToken", { type: "messages", limit: 5 });
			return results.results[0]?.sessionTitle ?? "";
		}, { timeout: 5_000 }).toBe("Goal Prefix: Grouped Session");
	} finally {
		await ctx.searchIndex.close();
		fs.rmSync(rootPath, { recursive: true, force: true });
	}
});

test("serialized message reindexes keep latest session and goal title metadata", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-reindex-order-"));
	const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "svc-reindex-order-session-"));
	const messageFile = path.join(rootPath, "session.jsonl");
	fs.writeFileSync(
		messageFile,
		JSON.stringify({ message: { role: "user", content: "ReindexOrderingToken" } }) + "\n",
		"utf-8",
	);

	const svc = new SearchService({
		stateDir,
		projectId: "project-reindex-order",
		progressBus: new ProgressBus(),
	});
	let releaseOldUpsert!: () => void;
	const oldMayFinish = new Promise<void>((resolve) => { releaseOldUpsert = resolve; });
	let markOldStarted!: () => void;
	const oldStarted = new Promise<void>((resolve) => { markOldStarted = resolve; });
	let markOldFinished!: () => void;
	const oldFinished = new Promise<void>((resolve) => { markOldFinished = resolve; });
	let markNewFinished!: () => void;
	const newFinished = new Promise<void>((resolve) => { markNewFinished = resolve; });
	let oldFinishedFlag = false;
	let newStartedBeforeOldFinished = false;

	try {
		svc.open();
		await svc.whenReady();

		const internals = svc as unknown as {
			_indexer: { upsertEntries: (entries: Array<{ metadata?: Record<string, unknown> }>) => Promise<void> };
			_waitForMutationTasks: () => Promise<void>;
		};
		const originalUpsert = internals._indexer.upsertEntries.bind(internals._indexer);
		internals._indexer.upsertEntries = async (entries) => {
			const sessionTitle = entries
				.map((entry) => String(entry.metadata?.sessionTitle ?? ""))
				.find((title) => title.length > 0) ?? "";
			if (sessionTitle === "Old Goal: Old Session") {
				markOldStarted();
				await oldMayFinish;
				await originalUpsert(entries);
				oldFinishedFlag = true;
				markOldFinished();
				return;
			}
			if (sessionTitle === "New Goal: New Session") {
				if (!oldFinishedFlag) newStartedBeforeOldFinished = true;
				await originalUpsert(entries);
				markNewFinished();
				return;
			}
			await originalUpsert(entries);
		};

		svc.reindexMessagesForSession({
			id: "session-reindex-order",
			title: "Old Session",
			cwd: rootPath,
			agentSessionFile: messageFile,
			createdAt: 1,
			lastActivity: 2,
			goalId: "goal-reindex-order",
			projectId: "project-reindex-order",
		}, "Old Goal", "project-reindex-order");
		await oldStarted;

		svc.reindexMessagesForSession({
			id: "session-reindex-order",
			title: "New Session",
			cwd: rootPath,
			agentSessionFile: messageFile,
			createdAt: 1,
			lastActivity: 3,
			goalId: "goal-reindex-order",
			projectId: "project-reindex-order",
		}, "New Goal", "project-reindex-order");

		await new Promise((resolve) => setTimeout(resolve, 50));
		releaseOldUpsert();
		await Promise.all([oldFinished, newFinished]);
		await internals._waitForMutationTasks();

		expect(newStartedBeforeOldFinished, "newer message reindex must wait for the older compound write").toBe(false);
		const results = await svc.search("ReindexOrderingToken", { type: "messages", limit: 5 });
		expect(results.results[0]?.sessionTitle).toBe("New Goal: New Session");
	} finally {
		releaseOldUpsert?.();
		if (svc.getState() !== "closed") await svc.close();
		fs.rmSync(stateDir, { recursive: true, force: true });
		fs.rmSync(rootPath, { recursive: true, force: true });
	}
});

test("live message indexing adds validated author metadata without changing text or weight", async () => {
	const svc = new SearchService({
		stateDir: path.resolve("/memory/search-service-author"),
		projectId: "project-author",
	});
	const captured: Array<{ text: string; weight: number; metadata: Record<string, unknown> }> = [];
	const indexer = {
		upsertEntries: async (entries: typeof captured) => { captured.push(...entries); },
	};
	const internals = svc as unknown as {
		_indexer: typeof indexer;
		_waitForMutationTasks: () => Promise<void>;
	};
	internals._indexer = indexer;

	svc.indexMessage({
		sessionId: "session-author",
		sessionTitle: "Authored chat",
		message: {
			role: "assistant",
			content: "LiveAuthorSearchToken",
			author: { kind: "agent", id: "session:session-author", label: "Authored chat" },
		},
		timestamp: 123,
	});
	await internals._waitForMutationTasks();

	expect(captured).toHaveLength(1);
	expect(captured[0].text).toBe("LiveAuthorSearchToken");
	expect(captured[0].weight).toBe(1.0);
	expect(captured[0].metadata.authorKind).toBe("agent");
	expect(captured[0].metadata.authorId).toBe("session:session-author");
	expect(captured[0].metadata.authorLabel).toBe("Authored chat");
	expect(captured[0].text).not.toContain("Authored chat");
});

test("close waits for an in-flight message reindex before closing the store", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-reindex-close-"));
	const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "svc-reindex-session-"));
	const messageFile = path.join(rootPath, "session.jsonl");
	fs.writeFileSync(
		messageFile,
		JSON.stringify({ message: { role: "user", content: "ReindexCloseRaceToken" } }) + "\n",
		"utf-8",
	);

	const svc = new SearchService({
		stateDir,
		projectId: "project-reindex-close",
		progressBus: new ProgressBus(),
	});
	const errors: string[] = [];
	const originalError = console.error;
	let releaseUpsert!: () => void;
	const releaseUpsertPromise = new Promise<void>((resolve) => { releaseUpsert = resolve; });
	let markUpsertStarted!: () => void;
	const upsertStarted = new Promise<void>((resolve) => { markUpsertStarted = resolve; });
	let storeCloseStarted = false;
	let storeClosedBeforeUpsertFinished = false;
	let closeSettled = false;

	console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
	try {
		svc.open();
		await svc.whenReady();

		const internals = svc as unknown as {
			_indexer: { upsertEntries: (entries: unknown[]) => Promise<void> };
			_store: { close: () => Promise<void> };
		};
		const originalUpsert = internals._indexer.upsertEntries.bind(internals._indexer);
		const originalClose = internals._store.close.bind(internals._store);
		internals._indexer.upsertEntries = async (entries: unknown[]) => {
			markUpsertStarted();
			await releaseUpsertPromise;
			storeClosedBeforeUpsertFinished = storeCloseStarted;
			return originalUpsert(entries);
		};
		internals._store.close = async () => {
			storeCloseStarted = true;
			return originalClose();
		};

		svc.reindexMessagesForSession({
			id: "session-reindex-close",
			title: "Race Session",
			cwd: rootPath,
			agentSessionFile: messageFile,
			createdAt: 1,
			lastActivity: 2,
			projectId: "project-reindex-close",
		}, undefined, "project-reindex-close");
		await upsertStarted;

		const closePromise = svc.close().then(() => { closeSettled = true; });
		await new Promise((resolve) => setTimeout(resolve, 30));
		const settledBeforeRelease = closeSettled;
		releaseUpsert();
		await closePromise;

		expect(settledBeforeRelease).toBe(false);
		expect(storeClosedBeforeUpsertFinished).toBe(false);
		expect(errors.filter((err) => err.includes("already closed"))).toEqual([]);
	} finally {
		console.error = originalError;
		releaseUpsert?.();
		if (svc.getState() !== "closed") await svc.close();
		fs.rmSync(stateDir, { recursive: true, force: true });
		fs.rmSync(rootPath, { recursive: true, force: true });
	}
});
