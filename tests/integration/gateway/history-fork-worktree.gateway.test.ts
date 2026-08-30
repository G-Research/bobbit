import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { test, expect } from "../../../tests2/integration/_e2e/in-process-harness.js";
import { apiFetch, registerProject } from "../../../tests2/integration/_e2e/e2e-setup.js";
import { copyGitTemplate } from "../../../tests2/harness/git-template.js";
import { createSessionTracker, localApiFetch } from "../../../tests2/integration/helpers/session-fixtures.js";

const sessions = createSessionTracker();
const FIXTURE_TIME = "2026-08-11T12:00:00.000Z";

type TranscriptEntry = Record<string, unknown> & {
	type: string;
	id?: string;
	parentId?: string | null;
};

function messageEntry(id: string, parentId: string | null, role: string, text: string): TranscriptEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: FIXTURE_TIME,
		message: { role, content: [{ type: "text", text }] },
	};
}

function ordinaryHistory(): TranscriptEntry[] {
	return [
		messageEntry("root-user", null, "user", "retained prompt"),
		messageEntry("root-assistant", "root-user", "assistant", "retained answer"),
		messageEntry("selected-user", "root-assistant", "user", "selected prompt"),
		messageEntry("later-assistant", "selected-user", "assistant", "discarded answer"),
	];
}

function seedTranscript(gateway: any, sessionId: string, entries: TranscriptEntry[]): void {
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	const live = gateway.sessionManager.getSession(sessionId);
	if (!persisted?.projectId || !live) throw new Error(`session ${sessionId} must be live and persisted`);
	const header = {
		type: "session",
		version: 3,
		id: `pi-${sessionId}`,
		timestamp: FIXTURE_TIME,
		cwd: live.cwd,
		provider: "fixture-provider",
	};
	const content = `${[header, ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`;
	const file = path.join(gateway.bobbitDir, "state", "session-prompts", `${sessionId}-history-fork.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
	live.agentSessionFile = file;
	gateway.sessionManager.getSessionStore(persisted.projectId).update(sessionId, { agentSessionFile: file });
}

async function createTrackedSessionWithoutWorktree(cwd: string, projectId: string): Promise<string> {
	const response = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd, projectId, worktree: false }),
	});
	expect(response.status, await response.clone().text()).toBe(201);
	return sessions.add((await response.json()).id as string);
}

async function historyFork(gateway: any, sourceId: string): Promise<Response> {
	return localApiFetch(gateway, `/api/sessions/${sourceId}/fork`, {
		method: "POST",
		body: JSON.stringify({ entryId: "selected-user", newWorktree: true }),
	});
}

async function responseJson(response: Response): Promise<any> {
	return response.clone().json().catch(async () => ({ error: await response.clone().text() }));
}

function filesystemIdentity(value: string): string {
	const canonical = fs.realpathSync.native(value);
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function authorPath(gateway: any, sessionId: string): string {
	return path.join(gateway.bobbitDir, "secrets", "author-sidecar", `${sessionId}.jsonl`);
}

function statePath(gateway: any, kind: string, sessionId: string, extension = ""): string {
	return path.join(gateway.bobbitDir, "state", kind, `${sessionId}${extension}`);
}

test.describe("history fork API fresh worktrees", () => {
	test.afterEach(async ({ gateway }) => {
		await sessions.cleanup(gateway);
	});

	test("new-worktree mode uses the established fresh branch lifecycle and preserves reattempt context", async ({ gateway }) => {
		const projectRoot = path.join(gateway.bobbitDir, `history-fork-project-${randomUUID()}`);
		copyGitTemplate(projectRoot);
		const project = await registerProject({
			name: `history-fork-${randomUUID()}`,
			rootPath: projectRoot,
			seedWorkflows: false,
		});
		const sourceId = await createTrackedSessionWithoutWorktree(projectRoot, project.id);
		seedTranscript(gateway, sourceId, ordinaryHistory());
		const sourcePersisted = gateway.sessionManager.getPersistedSession(sourceId);
		gateway.sessionManager.getSessionStore(sourcePersisted.projectId).update(sourceId, {
			reattemptGoalId: "fixture-reattempt-goal",
		});

		const manager = gateway.sessionManager;
		const originalCreateSession = manager.createSession;
		let capturedOptions: any;
		manager.createSession = async (...args: any[]) => {
			capturedOptions = args[4];
			return originalCreateSession.apply(manager, args);
		};
		let response: Response;
		try {
			response = await historyFork(gateway, sourceId);
		} finally {
			manager.createSession = originalCreateSession;
		}
		expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);
		const forkPersisted = gateway.sessionManager.getPersistedSession(fork.id);

		expect(filesystemIdentity(capturedOptions.worktreeOpts.repoPath)).toBe(filesystemIdentity(projectRoot));
		expect(capturedOptions.awaitWorktreeSetup).toBe(true);
		expect(capturedOptions.reattemptGoalId).toBe("fixture-reattempt-goal");
		expect(fork.status).toBe("idle");
		expect(filesystemIdentity(fork.cwd)).not.toBe(filesystemIdentity(projectRoot));
		expect(filesystemIdentity(fork.cwd)).toBe(filesystemIdentity(forkPersisted.cwd));
		expect(filesystemIdentity(forkPersisted.cwd)).not.toBe(filesystemIdentity(projectRoot));
		expect(filesystemIdentity(forkPersisted.worktreePath)).toBe(filesystemIdentity(forkPersisted.cwd));
		expect(filesystemIdentity(forkPersisted.repoPath)).toBe(filesystemIdentity(projectRoot));
		expect(forkPersisted.branch).toMatch(/^session\//);
		expect(forkPersisted.reattemptGoalId).toBe("fixture-reattempt-goal");
		expect(fs.existsSync(forkPersisted.cwd)).toBe(true);
		expect(fs.existsSync(path.join(forkPersisted.cwd, ".git"))).toBe(true);
		const forkTranscript = fs.readFileSync(forkPersisted.agentSessionFile, "utf8");
		const forkHeader = JSON.parse(forkTranscript.split(/\r?\n/, 1)[0]);
		expect(filesystemIdentity(forkHeader.cwd)).toBe(filesystemIdentity(forkPersisted.cwd));
		expect(forkTranscript).not.toContain("selected prompt");
	});

	test("awaited fresh worktree setup failures return an error and purge the destination", async ({ gateway }) => {
		const projectRoot = path.join(gateway.bobbitDir, `history-fork-failure-${randomUUID()}`);
		copyGitTemplate(projectRoot);
		const project = await registerProject({
			name: `history-fork-failure-${randomUUID()}`,
			rootPath: projectRoot,
			seedWorkflows: false,
		});
		const sourceId = await createTrackedSessionWithoutWorktree(projectRoot, project.id);
		seedTranscript(gateway, sourceId, ordinaryHistory());

		const manager = gateway.sessionManager;
		const originalCreateSession = manager.createSession;
		let capturedOptions: any;
		manager.createSession = async (...args: any[]) => {
			capturedOptions = { ...args[4], worktreeOpts: { ...args[4]?.worktreeOpts } };
			args[4] = {
				...args[4],
				worktreeOpts: { repoPath: path.join(projectRoot, "missing-repo") },
				bypassWorktreePool: true,
			};
			return originalCreateSession.apply(manager, args);
		};
		let response: Response;
		try {
			response = await historyFork(gateway, sourceId);
		} finally {
			manager.createSession = originalCreateSession;
		}

		expect(filesystemIdentity(capturedOptions.worktreeOpts.repoPath)).toBe(filesystemIdentity(projectRoot));
		expect(capturedOptions.awaitWorktreeSetup).toBe(true);
		expect(response.status).toBe(500);
		expect((await responseJson(response)).error).toContain("failed to fork session");
		expect(gateway.sessionManager.getSession(capturedOptions.sessionId)).toBeUndefined();
		expect(gateway.sessionManager.getPersistedSession(capturedOptions.sessionId)).toBeUndefined();
		expect(fs.existsSync(capturedOptions.preExistingAgentSessionFile)).toBe(false);
		expect(fs.existsSync(authorPath(gateway, capturedOptions.sessionId))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "skill-sidecar", capturedOptions.sessionId, ".jsonl"))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "compaction-sidecar", capturedOptions.sessionId, ".jsonl"))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "proposal-drafts", capturedOptions.sessionId))).toBe(false);
	});
});
