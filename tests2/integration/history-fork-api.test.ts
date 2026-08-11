import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	createSession as createSessionFromHarness,
	nonGitCwd,
	registerProject,
} from "./_e2e/e2e-setup.js";
import {
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	readAuthorSidecar,
} from "../../src/server/agent/author-sidecar.js";
import {
	appendSkillSidecarEntry,
	readSkillSidecarEntries,
} from "../../src/server/skills/skill-sidecar.js";
import {
	appendCompactionSidecarEntry,
	readCompactionSidecarEntries,
} from "../../src/server/agent/compaction-sidecar.js";
import { copyGitTemplate } from "../harness/git-template.js";
import {
	createSessionTracker,
	localApiFetch,
} from "./helpers/session-fixtures.js";

const sessions = createSessionTracker();
const fixtureRoots: string[] = [];

const SYSTEM_AUTHOR = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;
const FIXTURE_TIME = "2026-08-11T12:00:00.000Z";

type TranscriptEntry = Record<string, unknown> & {
	type: string;
	id?: string;
	parentId?: string | null;
};

type SeededTranscript = {
	file: string;
	content: string;
	header: TranscriptEntry;
	entries: TranscriptEntry[];
};

function messageEntry(
	id: string,
	parentId: string | null,
	role: string,
	text: string,
	timestamp = FIXTURE_TIME,
): TranscriptEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role, content: [{ type: "text", text }] },
	};
}

function seedTranscript(
	gateway: any,
	sessionId: string,
	entries: TranscriptEntry[],
	options: { lineEnding?: "\n" | "\r\n"; trailingNewline?: boolean } = {},
): SeededTranscript {
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	const live = gateway.sessionManager.getSession(sessionId);
	if (!persisted?.projectId || !live) throw new Error(`session ${sessionId} must be live and persisted`);

	const header: TranscriptEntry = {
		type: "session",
		version: 3,
		id: `pi-${sessionId}`,
		timestamp: FIXTURE_TIME,
		cwd: live.cwd,
		provider: "fixture-provider",
	};
	const eol = options.lineEnding ?? "\n";
	const content = [header, ...entries].map(entry => JSON.stringify(entry)).join(eol)
		+ (options.trailingNewline === false ? "" : eol);
	const file = path.join(gateway.bobbitDir, "state", "session-prompts", `${sessionId}-history-fork.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
	live.agentSessionFile = file;
	gateway.sessionManager.getSessionStore(persisted.projectId).update(sessionId, { agentSessionFile: file });
	return { file, content, header, entries };
}

function ordinaryHistory(): TranscriptEntry[] {
	return [
		messageEntry("root-user", null, "user", "retained prompt"),
		messageEntry("root-assistant", "root-user", "assistant", "retained answer"),
		messageEntry("selected-user", "root-assistant", "user", "selected prompt"),
		messageEntry("later-assistant", "selected-user", "assistant", "discarded answer"),
	];
}

async function historyFork(
	gateway: any,
	sourceId: string,
	entryId: unknown,
	newWorktree: unknown = false,
): Promise<Response> {
	return localApiFetch(gateway, `/api/sessions/${sourceId}/fork`, {
		method: "POST",
		body: JSON.stringify({ entryId, newWorktree }),
	});
}

async function responseJson(response: Response): Promise<any> {
	return response.clone().json().catch(async () => ({ error: await response.clone().text() }));
}

async function waitForRealCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`condition did not settle within ${timeoutMs}ms`);
		await new Promise(resolve => setTimeout(resolve, 25));
	}
}

function statePath(gateway: any, kind: string, sessionId: string, extension = ""): string {
	return path.join(gateway.bobbitDir, "state", kind, `${sessionId}${extension}`);
}

function authorPath(gateway: any, sessionId: string): string {
	return path.join(gateway.bobbitDir, "secrets", "author-sidecar", `${sessionId}.jsonl`);
}

function seedAuthorBinding(sessionId: string, promptId: string, messageId: string, modelText: string): void {
	const dispatchedAt = Date.parse(FIXTURE_TIME);
	expect(appendPromptAuthorDispatch(sessionId, {
		promptId,
		dispatchedAt,
		modelText,
		modelPrefix: "[System]: ",
		source: "task-notification",
		author: SYSTEM_AUTHOR,
	})).toBe(true);
	expect(appendPromptAuthorSettlement(sessionId, {
		promptId,
		settledAt: dispatchedAt + 1,
		outcome: "echoed",
		messageId,
		messageTimestamp: dispatchedAt,
	})).toBe(true);
}

function seedSkillBinding(sessionId: string, modelText: string, originalText: string, offsetMs = 0): void {
	expect(appendSkillSidecarEntry(sessionId, {
		ts: Date.parse(FIXTURE_TIME) + offsetMs,
		modelText,
		originalText,
		skillExpansions: [{ name: "fixture", invocation: "/fixture" } as any],
		fileMentions: [{ path: "src/fixture.ts", start: 0, end: 15 } as any],
	})).toBe(true);
}

function seedCompactionBinding(sessionId: string, id: string, firstKeptEntryId: string | null): void {
	expect(appendCompactionSidecarEntry(sessionId, {
		schemaVersion: 1,
		id,
		trigger: "manual",
		tokensBefore: 800,
		tokensAfter: 300,
		durationMs: 25,
		startedAt: FIXTURE_TIME,
		endedAt: "2026-08-11T12:00:00.025Z",
		success: true,
		firstKeptEntryId,
	})).toBe(true);
}

async function createTrackedSession(cwd = nonGitCwd(), projectId?: string): Promise<string> {
	return sessions.add(await createSessionFromHarness({ cwd, projectId }));
}

async function createTrackedSessionWithoutWorktree(cwd: string, projectId: string): Promise<string> {
	const response = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd, projectId, worktree: false }),
	});
	expect(response.status, await response.clone().text()).toBe(201);
	return sessions.add((await response.json()).id as string);
}

test.describe("history fork API", () => {
	test.afterEach(async ({ gateway }) => {
		await sessions.cleanup(gateway);
		for (const root of fixtureRoots.splice(0)) {
			try {
				fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
			} catch { /* the isolated run-root owner performs the final safety sweep */ }
		}
	});

	test("returns stable validation errors without allocating a destination", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const base = ordinaryHistory();
		seedTranscript(gateway, sourceId, base);
		const beforeIds = new Set(gateway.sessionManager.listSessions().map((session: any) => session.id));

		for (const invalid of [null, 42, "", " selected-user", "selected-user ", "x".repeat(257)]) {
			const response = await historyFork(gateway, sourceId, invalid);
			expect(response.status, `invalid cursor ${JSON.stringify(invalid)}`).toBe(400);
			expect(await responseJson(response)).toMatchObject({
				error: "Invalid history fork entry id",
				code: "HISTORY_FORK_CURSOR_INVALID",
			});
		}

		const invalidMode = await historyFork(gateway, sourceId, "selected-user", "false");
		expect(invalidMode.status).toBe(400);
		expect(await responseJson(invalidMode)).toMatchObject({ code: "HISTORY_FORK_CURSOR_INVALID" });

		const missing = await historyFork(gateway, sourceId, "missing-user");
		expect(missing.status).toBe(409);
		expect(await responseJson(missing)).toEqual({
			error: "This prompt is no longer available",
			code: "HISTORY_FORK_CURSOR_NOT_FOUND",
		});

		seedTranscript(gateway, sourceId, [
			messageEntry("root-user", null, "user", "root"),
			messageEntry("inactive-user", "root-user", "user", "inactive"),
			messageEntry("active-assistant", "root-user", "assistant", "active reply"),
			messageEntry("active-user", "active-assistant", "user", "active prompt"),
		]);
		const inactive = await historyFork(gateway, sourceId, "inactive-user");
		expect(inactive.status).toBe(409);
		expect(await responseJson(inactive)).toEqual({
			error: "This prompt is no longer on the active conversation branch",
			code: "HISTORY_FORK_CURSOR_INACTIVE",
		});

		const nonUser = await historyFork(gateway, sourceId, "active-assistant");
		expect(nonUser.status).toBe(422);
		expect(await responseJson(nonUser)).toEqual({
			error: "History forks must start before a user prompt",
			code: "HISTORY_FORK_CURSOR_NOT_USER",
		});

		seedTranscript(gateway, sourceId, [
			messageEntry("broken-root", "missing-parent", "user", "broken"),
		]);
		const malformed = await historyFork(gateway, sourceId, "broken-root");
		expect(malformed.status).toBe(409);
		expect(await responseJson(malformed)).toEqual({
			error: "The session transcript changed or is not valid for history forking",
			code: "HISTORY_FORK_TRANSCRIPT_INVALID",
		});

		expect(new Set(gateway.sessionManager.listSessions().map((session: any) => session.id))).toEqual(beforeIds);
	});

	test("rejects the newest durable user cursor while the source is streaming", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		seedTranscript(gateway, sourceId, ordinaryHistory());
		const source = gateway.sessionManager.getSession(sourceId);
		const previousStatus = source.status;
		source.status = "streaming";
		try {
			const response = await historyFork(gateway, sourceId, "selected-user");
			expect(response.status).toBe(409);
			expect(await responseJson(response)).toEqual({
				error: "The current prompt cannot be forked until the turn finishes",
				code: "HISTORY_FORK_CURSOR_IN_FLIGHT",
			});
		} finally {
			source.status = previousStatus;
		}
	});

	test("cuts the active branch before the prompt, preserves source/context and filters sidecars", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const entries: TranscriptEntry[] = [
			messageEntry("kept-user", null, "user", "[System]: kept prompt"),
			messageEntry("inactive-user", "kept-user", "user", "discarded inactive prompt"),
			messageEntry("kept-assistant", "kept-user", "assistant", "kept answer"),
			{
				type: "compaction",
				id: "kept-compaction",
				parentId: "kept-assistant",
				timestamp: FIXTURE_TIME,
				summary: "retained summary",
				firstKeptEntryId: "kept-user",
				tokensBefore: 800,
				additiveFixtureField: { preserve: true },
			},
			messageEntry("selected-user", "kept-compaction", "user", "selected prompt"),
			messageEntry("later-assistant", "selected-user", "assistant", "discarded answer"),
			messageEntry("later-user", "later-assistant", "user", "discarded later prompt"),
		];
		const seeded = seedTranscript(gateway, sourceId, entries, { lineEnding: "\r\n" });
		const sourceBytes = fs.readFileSync(seeded.file);
		const sourcePersisted = gateway.sessionManager.getPersistedSession(sourceId);
		const sourceStore = gateway.sessionManager.getSessionStore(sourcePersisted.projectId);
		sourceStore.put({
			...sourcePersisted,
			taskId: "fixture-task",
			reattemptGoalId: "fixture-reattempt",
			allowedTools: ["read", "grep"],
		});

		seedAuthorBinding(sourceId, "author-kept", "kept-user", "[System]: kept prompt");
		seedAuthorBinding(sourceId, "author-cut", "selected-user", "selected prompt");
		seedSkillBinding(sourceId, "[System]: kept prompt", "/fixture @src/fixture.ts");
		seedSkillBinding(sourceId, "selected prompt", "/discarded");
		seedCompactionBinding(sourceId, "kept-compaction", "kept-user");
		seedCompactionBinding(sourceId, "unprovable-compaction", null);

		const proposalSource = statePath(gateway, "proposal-drafts", sourceId);
		fs.mkdirSync(path.join(proposalSource, "goal.history"), { recursive: true });
		fs.writeFileSync(path.join(proposalSource, "goal.md"), "# Durable proposal\n", "utf8");
		fs.writeFileSync(path.join(proposalSource, "goal.history", "0001.md"), "# Earlier draft\n", "utf8");
		const toolCacheSource = statePath(gateway, "tool-content", sourceId);
		fs.mkdirSync(toolCacheSource, { recursive: true });
		fs.writeFileSync(path.join(toolCacheSource, "0-0.txt"), "positional cache must not copy", "utf8");

		const manager = gateway.sessionManager;
		const originalCreateSession = manager.createSession;
		let stagedTranscript = "";
		manager.createSession = async (...args: any[]) => {
			const stagedFile = args[4]?.preExistingAgentSessionFile;
			stagedTranscript = fs.readFileSync(stagedFile, "utf8");
			return originalCreateSession.apply(manager, args);
		};
		let response: Response;
		try {
			response = await historyFork(gateway, sourceId, "selected-user", false);
		} finally {
			manager.createSession = originalCreateSession;
		}
		expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);

		expect(fs.readFileSync(seeded.file).equals(sourceBytes), "source JSONL bytes remain unchanged").toBe(true);
		expect(gateway.sessionManager.getSession(sourceId), "source remains live").toBeTruthy();
		expect(gateway.sessionManager.listSessions().some((session: any) => session.id === sourceId)).toBe(true);

		const forkPersisted = gateway.sessionManager.getPersistedSession(fork.id);
		expect(forkPersisted).toMatchObject({
			projectId: sourcePersisted.projectId,
			taskId: "fixture-task",
			reattemptGoalId: "fixture-reattempt",
			role: sourcePersisted.role,
			accessory: sourcePersisted.accessory,
			allowedTools: ["read", "grep"],
			modelProvider: sourcePersisted.modelProvider,
			modelId: sourcePersisted.modelId,
			effectiveThinkingLevel: sourcePersisted.effectiveThinkingLevel,
		});
		expect(Boolean(forkPersisted.sandboxed)).toBe(Boolean(sourcePersisted.sandboxed));

		const expectedTranscript = [seeded.header, entries[0], entries[2], entries[3]]
			.map(entry => JSON.stringify(entry)).join("\r\n") + "\r\n";
		expect(stagedTranscript).toBe(expectedTranscript);
		const forkTranscript = fs.readFileSync(forkPersisted.agentSessionFile, "utf8");
		expect(forkTranscript).not.toContain("selected prompt");
		expect(forkTranscript).not.toContain("discarded later prompt");
		expect(forkTranscript).not.toContain("discarded inactive prompt");

		const authorBindings = readAuthorSidecar(fork.id);
		expect(authorBindings.map(binding => binding.promptId)).toEqual(["author-kept"]);
		expect(authorBindings[0].author).toEqual(SYSTEM_AUTHOR);
		expect(readSkillSidecarEntries(fork.id)).toEqual([
			expect.objectContaining({ modelText: "[System]: kept prompt", originalText: "/fixture @src/fixture.ts" }),
		]);
		expect(readCompactionSidecarEntries(fork.id).map(entry => entry.id)).toEqual(["kept-compaction"]);

		const proposalFork = statePath(gateway, "proposal-drafts", fork.id);
		expect(fs.readFileSync(path.join(proposalFork, "goal.md"), "utf8")).toBe("# Durable proposal\n");
		expect(fs.readFileSync(path.join(proposalFork, "goal.history", "0001.md"), "utf8")).toBe("# Earlier draft\n");
		expect(fs.existsSync(statePath(gateway, "tool-content", fork.id))).toBe(false);
	});

	test("reuse mode uses the exact live cwd and carries no worktree teardown ownership", async ({ gateway }) => {
		const sourceWorktree = path.join(nonGitCwd(), `history-source-${randomUUID()}`);
		const liveCwd = path.join(sourceWorktree, "packages", "web");
		fs.mkdirSync(liveCwd, { recursive: true });
		fixtureRoots.push(sourceWorktree);
		const sentinel = path.join(sourceWorktree, "uncommitted.txt");
		fs.writeFileSync(sentinel, "preserve working state", "utf8");

		const sourceId = await createTrackedSession(liveCwd);
		seedTranscript(gateway, sourceId, ordinaryHistory());
		const sourcePersisted = gateway.sessionManager.getPersistedSession(sourceId);
		gateway.sessionManager.getSessionStore(sourcePersisted.projectId).update(sourceId, {
			cwd: liveCwd,
			worktreePath: sourceWorktree,
			repoPath: nonGitCwd(),
			branch: "feature/shared-source",
		});
		gateway.sessionManager.getSession(sourceId).cwd = liveCwd;

		const response = await historyFork(gateway, sourceId, "selected-user", false);
		expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);
		const forkPersisted = gateway.sessionManager.getPersistedSession(fork.id);
		expect(fork.cwd).toBe(liveCwd);
		expect(forkPersisted.cwd).toBe(liveCwd);
		expect(forkPersisted.worktreePath).toBeUndefined();
		expect(forkPersisted.repoPath).toBeUndefined();
		expect(forkPersisted.branch).toBeUndefined();

		await gateway.sessionManager.terminateSession(fork.id);
		expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve working state");
		expect(fs.existsSync(sourceWorktree)).toBe(true);
		expect(gateway.sessionManager.getSession(sourceId), "terminating fork does not stop source").toBeTruthy();
	});

	test("new-worktree mode uses the established fresh branch lifecycle", async ({ gateway }) => {
		const projectRoot = path.join(gateway.bobbitDir, `history-fork-project-${randomUUID()}`);
		copyGitTemplate(projectRoot);
		const project = await registerProject({
			name: `history-fork-${randomUUID()}`,
			rootPath: projectRoot,
			seedWorkflows: false,
		});
		const sourceId = await createTrackedSessionWithoutWorktree(projectRoot, project.id);
		seedTranscript(gateway, sourceId, ordinaryHistory());

		const response = await historyFork(gateway, sourceId, "selected-user", true);
		expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);
		await waitForRealCondition(() => gateway.sessionManager.getSession(fork.id)?.status === "idle");
		const forkPersisted = gateway.sessionManager.getPersistedSession(fork.id);

		expect(path.resolve(forkPersisted.cwd)).not.toBe(path.resolve(projectRoot));
		expect(path.resolve(forkPersisted.worktreePath)).toBe(path.resolve(forkPersisted.cwd));
		expect(forkPersisted.repoPath && path.resolve(forkPersisted.repoPath)).toBe(path.resolve(projectRoot));
		expect(forkPersisted.branch).toMatch(/^session\//);
		expect(fs.existsSync(path.join(forkPersisted.cwd, ".git"))).toBe(true);
		expect(fs.readFileSync(forkPersisted.agentSessionFile, "utf8")).not.toContain("selected prompt");
	});

	test("deduplicates concurrent requests, releases reservations and purges failed artifacts", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const entries: TranscriptEntry[] = [
			messageEntry("kept-user", null, "user", "[System]: kept prompt"),
			{
				type: "compaction",
				id: "kept-compaction",
				parentId: "kept-user",
				timestamp: FIXTURE_TIME,
				summary: "summary",
				firstKeptEntryId: "kept-user",
			},
			messageEntry("selected-user", "kept-compaction", "user", "selected prompt"),
		];
		seedTranscript(gateway, sourceId, entries);
		seedAuthorBinding(sourceId, "author-kept", "kept-user", "[System]: kept prompt");
		seedSkillBinding(sourceId, "[System]: kept prompt", "/fixture");
		seedCompactionBinding(sourceId, "kept-compaction", "kept-user");
		const proposalSource = statePath(gateway, "proposal-drafts", sourceId);
		fs.mkdirSync(proposalSource, { recursive: true });
		fs.writeFileSync(path.join(proposalSource, "goal.md"), "failed destination draft", "utf8");

		const sourcePersisted = gateway.sessionManager.getPersistedSession(sourceId);
		gateway.sessionManager.getSessionStore(sourcePersisted.projectId).put({
			...sourcePersisted,
			sandboxed: true,
			taskId: "captured-task",
			reattemptGoalId: "captured-reattempt",
			allowedTools: ["read", "grep"],
		});

		const manager = gateway.sessionManager;
		const originalCreateSession = manager.createSession;
		let capturedDestinationId = "";
		let capturedDestinationFile = "";
		let capturedOptions: any;
		let createCalls = 0;
		let launchReleased = false;
		let signalEntered!: () => void;
		const entered = new Promise<void>(resolve => { signalEntered = resolve; });
		let rejectLaunch!: (error: Error) => void;
		const blockedLaunch = new Promise<never>((_resolve, reject) => { rejectLaunch = reject; });
		manager.createSession = async (...args: any[]) => {
			createCalls++;
			if (createCalls > 1) throw new Error("duplicate request reached createSession");
			capturedOptions = args[4];
			capturedDestinationId = capturedOptions?.sessionId;
			capturedDestinationFile = capturedOptions?.preExistingAgentSessionFile;
			signalEntered();
			return blockedLaunch;
		};

		let firstResponse: Response;
		try {
			const first = historyFork(gateway, sourceId, "selected-user", false);
			await entered;
			expect(capturedOptions).toMatchObject({
				sandboxed: true,
				taskId: "captured-task",
				reattemptGoalId: "captured-reattempt",
				accessory: sourcePersisted.accessory,
				allowedTools: ["read", "grep"],
			});
			expect(capturedOptions.worktreeOpts).toBeUndefined();
			expect(capturedOptions.sandboxBranch).toBeUndefined();

			const duplicate = await historyFork(gateway, sourceId, "selected-user", false);
			expect(duplicate.status).toBe(409);
			expect(await responseJson(duplicate)).toEqual({
				error: "A fork from this prompt is already being created",
				code: "HISTORY_FORK_IN_PROGRESS",
			});

			launchReleased = true;
			rejectLaunch(new Error("fixture launch failure after history artifacts were copied"));
			firstResponse = await first;
			expect(firstResponse.status).toBe(500);
			expect((await responseJson(firstResponse)).error).toContain("fixture launch failure");
		} finally {
			if (!launchReleased) {
				launchReleased = true;
				rejectLaunch(new Error("fixture released blocked launch during assertion cleanup"));
			}
			manager.createSession = originalCreateSession;
		}

		expect(capturedDestinationId).toBeTruthy();
		expect(fs.existsSync(capturedDestinationFile)).toBe(false);
		expect(fs.existsSync(authorPath(gateway, capturedDestinationId))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "skill-sidecar", capturedDestinationId, ".jsonl"))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "compaction-sidecar", capturedDestinationId, ".jsonl"))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "proposal-drafts", capturedDestinationId))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "tool-content", capturedDestinationId))).toBe(false);

		gateway.sessionManager.getSessionStore(sourcePersisted.projectId).update(sourceId, { sandboxed: false });
		const retry = await historyFork(gateway, sourceId, "selected-user", false);
		expect(retry.status, JSON.stringify(await responseJson(retry))).toBe(201);
		const retried = await retry.json();
		sessions.add(retried.id);
	});
});
