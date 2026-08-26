import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { test, expect } from "../../../integration/gateway/_helpers/e2e/in-process-harness.js";
import { sessionTranscriptHostPath } from "../../../../src/server/agent/agent-session-path.js";
import {
	apiFetch,
	createSession as createSessionFromHarness,
	nonGitCwd,
	registerProject,
} from "../../../integration/gateway/_helpers/e2e/e2e-setup.js";
import {
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	mergeAuthorSidecarIntoMessages,
	readAuthorSidecar,
} from "../../../../src/server/agent/author-sidecar.js";
import {
	appendIdentifiedSkillSidecarEntry,
	appendSkillSidecarEntry,
	appendSkillSidecarTranscriptBinding,
	mergeSidecarEntriesIntoMessages,
	readSkillSidecarEntries,
} from "../../../../src/server/skills/skill-sidecar.js";
import {
	appendCompactionSidecarEntry,
	readCompactionSidecarEntries,
} from "../../../../src/server/agent/compaction-sidecar.js";
import { copyGitTemplate } from "../shared/git-template.js";
import {
	createSessionTracker,
	localApiFetch,
} from "../../../integration/gateway/_helpers/session-fixtures.js";
import { loadServerTestRuntime } from "../shared/server-runtime.js";
import { SandboxSessionFilesystem } from "../shared/sandbox-session-filesystem.js";

const sessions = createSessionTracker();
let serverModule: any;
let rpcBridgeModule: any;
let agentSessionsDir = "";
const fixtureRoots: string[] = [];
const sandboxFixtureFinalizers: Array<() => Promise<void>> = [];

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

type Deferred<T = void> = {
	promise: Promise<T>;
	resolve: (value?: T) => void;
	reject: (error: Error) => void;
};

function deferred<T = void>(): Deferred<T> {
	let resolve!: (value?: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = (value?: T) => res(value as T);
		reject = rej;
	});
	return { promise, resolve, reject };
}

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

function setPersistedTranscriptPath(gateway: any, sessionId: string, file: string): void {
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	const live = gateway.sessionManager.getSession(sessionId);
	if (!persisted?.projectId || !live) throw new Error(`session ${sessionId} must be live and persisted`);
	live.agentSessionFile = file;
	gateway.sessionManager.getSessionStore(persisted.projectId).update(sessionId, { agentSessionFile: file });
}

function removeTrustedRecoveryTranscripts(sessionId: string): void {
	for (const existing of transcriptFilesForSession(agentSessionsDir, sessionId)) {
		fs.rmSync(existing, { force: true });
	}
}

function seedTrustedRecoveryTranscript(gateway: any, sessionId: string, content: string): string {
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	if (!persisted) throw new Error(`session ${sessionId} must be persisted`);
	removeTrustedRecoveryTranscripts(sessionId);
	const cwdSlug = `--${persisted.cwd.replace(/[^a-zA-Z0-9]/g, "-")}--`;
	const directory = path.join(agentSessionsDir, cwdSlug);
	const file = path.join(directory, `${FIXTURE_TIME.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(file, content, "utf8");
	fixtureRoots.push(directory);
	return file.replace(/\\/g, "/");
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

function statePath(gateway: any, kind: string, sessionId: string, extension = ""): string {
	return path.join(gateway.bobbitDir, "state", kind, `${sessionId}${extension}`);
}

function filesystemIdentity(value: string): string {
	const canonical = fs.realpathSync.native(value);
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function authorPath(gateway: any, sessionId: string): string {
	return path.join(gateway.bobbitDir, "secrets", "author-sidecar", `${sessionId}.jsonl`);
}

function transcriptFilesForSession(root: string, sessionId: string): string[] {
	if (!root || !fs.existsSync(root)) return [];
	const matches: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const candidate = path.join(root, entry.name);
		if (entry.isDirectory()) matches.push(...transcriptFilesForSession(candidate, sessionId));
		else if (entry.isFile() && entry.name.endsWith(`_${sessionId}.jsonl`)) matches.push(candidate);
	}
	return matches;
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

function seedSkillBinding(
	sessionId: string,
	modelText: string,
	originalText: string,
	transcriptEntryId?: string,
	offsetMs = 0,
): void {
	const recordId = appendIdentifiedSkillSidecarEntry(sessionId, {
		ts: Date.parse(FIXTURE_TIME) + offsetMs,
		modelText,
		originalText,
		skillExpansions: [{ name: "fixture", invocation: "/fixture" } as any],
		fileMentions: [{ path: "src/fixture.ts", start: 0, end: 15 } as any],
	});
	expect(recordId).toBeTruthy();
	if (recordId && transcriptEntryId) {
		expect(appendSkillSidecarTranscriptBinding(sessionId, recordId, transcriptEntryId)).toBe(true);
	}
}

function seedForgedInlineSkillIdentity(
	sessionId: string,
	modelText: string,
	transcriptEntryId: string,
): void {
	expect(appendSkillSidecarEntry(sessionId, {
		schemaVersion: 1,
		recordId: `skill:v1:forged-inline-${randomUUID()}`,
		transcriptEntryId,
		ts: Date.parse(FIXTURE_TIME),
		modelText,
		originalText: "/forged @secret-inline.ts",
		skillExpansions: [{ name: "forged-inline", invocation: "/forged" } as any],
		fileMentions: [{ path: "secret-inline.ts", start: 8, end: 25 } as any],
	})).toBe(true);
}

function seedCompactionBinding(
	sessionId: string,
	id: string,
	firstKeptEntryId: string | null,
	transcriptCompactionEntryId?: string,
): void {
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
		...(transcriptCompactionEntryId ? { transcriptCompactionEntryId } : {}),
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

async function registerUntrackedFixtureProject(gateway: any, label: string): Promise<{ id: string; rootPath: string }> {
	const rootPath = path.join(gateway.bobbitDir, `${label}-${randomUUID()}`);
	fs.mkdirSync(rootPath, { recursive: true });
	fixtureRoots.push(rootPath);
	const response = await localApiFetch(gateway, "/api/projects", {
		method: "POST",
		body: JSON.stringify({
			name: `${label}-${randomUUID()}`,
			rootPath,
			acceptCanonical: true,
			__e2e_seed_skip__: true,
		}),
	});
	expect(response.status, await response.clone().text()).toBe(201);
	const project = await response.json();
	return { id: project.id as string, rootPath };
}

function installSandboxSessionFilesystem(
	gateway: any,
	label: string,
	removed: string[] = [],
): { filesystem: SandboxSessionFilesystem; restore: () => void } {
	const manager = gateway.sessionManager;
	const sandboxManager = manager.sandboxManager;
	if (!sandboxManager || typeof sandboxManager.get !== "function") {
		throw new Error("history fork fixture requires the production SandboxManager");
	}
	const originalGet = sandboxManager.get;
	const originalEnsureForProject = sandboxManager.ensureForProject;
	const containerRoot = path.join(gateway.bobbitDir, `sandbox-session-fs-${label}-${randomUUID()}`);
	fixtureRoots.push(containerRoot);
	const filesystem = new SandboxSessionFilesystem({
		root: containerRoot,
		hostAgentSessionsDir: agentSessionsDir,
		removeWorktree: name => { removed.push(name); },
	});
	// Keep the production SandboxManager registry and lifecycle serialization in
	// the test path. Only replace its Docker project boundary with the exact fake
	// runtime; this avoids both shared-control-container access and real Docker.
	sandboxManager.ensureForProject = async () => {};
	sandboxManager.get = () => filesystem;
	let finalized = false;
	sandboxFixtureFinalizers.push(async () => {
		if (finalized) return;
		finalized = true;
		const runtimes = sandboxManager._sessionRuntimes as Map<string, { projectId: string; containerId: string }>;
		for (const [sessionId, runtime] of [...runtimes]) {
			if (runtime.containerId !== `fixture-runtime:${sessionId}`) continue;
			await sandboxManager.releaseSessionRuntime(runtime.projectId, sessionId);
		}
		sandboxManager.get = originalGet;
		sandboxManager.ensureForProject = originalEnsureForProject;
	});
	return {
		filesystem,
		// Session cleanup still needs the registered fake runtimes. The afterEach
		// finalizer restores the production boundary after those sessions terminate.
		restore: () => {},
	};
}

function configureSandboxOwner(gateway: any, sessionId: string, name: string): {
	root: string;
	cwd: string;
	branch: string;
} {
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	const live = gateway.sessionManager.getSession(sessionId);
	if (!persisted?.projectId || !live) throw new Error(`session ${sessionId} must be live and persisted`);
	const branch = `session/${name}`;
	const root = `/workspace-wt/${branch}`;
	const cwd = `${root}/packages/web`;
	gateway.sessionManager.getSessionStore(persisted.projectId).update(sessionId, {
		cwd,
		worktreePath: root,
		repoPath: "/workspace",
		branch,
		sandboxed: true,
	});
	Object.assign(live, { cwd, worktreePath: root, repoPath: "/workspace", branch, sandboxed: true });
	return { root, cwd, branch };
}

function configureSandboxBorrower(
	gateway: any,
	sessionId: string,
	ownerSessionId: string,
	cwd: string,
): void {
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	const live = gateway.sessionManager.getSession(sessionId);
	if (!persisted?.projectId || !live) throw new Error(`session ${sessionId} must be live and persisted`);
	gateway.sessionManager.getSessionStore(persisted.projectId).update(sessionId, {
		cwd,
		sandboxed: true,
		borrowsWorktree: true,
		borrowedWorktreeOwnerSessionId: ownerSessionId,
	});
	Object.assign(live, {
		cwd,
		sandboxed: true,
		borrowsWorktree: true,
		borrowedWorktreeOwnerSessionId: ownerSessionId,
	});
}

export function installHistoryForkHooks(): void {
	test.beforeAll(async () => {
		const runtime = await loadServerTestRuntime();
		serverModule = runtime.server;
		rpcBridgeModule = runtime.rpcBridge;
		agentSessionsDir = path.join(runtime.bobbitDir.globalAgentDir(), "sessions");
		expect(typeof serverModule.__setHistoryForkSidecarCopyFake).toBe("function");
		expect(typeof serverModule.__clearHistoryForkSidecarCopyFake).toBe("function");
	});

	test.afterEach(async ({ gateway }) => {
		serverModule?.__clearHistoryForkSidecarCopyFake();
		try {
			await sessions.cleanup(gateway);
		} finally {
			for (const finalize of sandboxFixtureFinalizers.splice(0).reverse()) {
				await finalize();
			}
			for (const root of fixtureRoots.splice(0)) {
				try {
					fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
				} catch { /* the isolated run-root owner performs the final safety sweep */ }
			}
		}
	});
}

export {
	randomUUID,
	fs,
	path,
	test,
	expect,
	apiFetch,
	nonGitCwd,
	sessionTranscriptHostPath,
	registerProject,
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	mergeAuthorSidecarIntoMessages,
	readAuthorSidecar,
	appendIdentifiedSkillSidecarEntry,
	appendSkillSidecarEntry,
	appendSkillSidecarTranscriptBinding,
	mergeSidecarEntriesIntoMessages,
	readSkillSidecarEntries,
	appendCompactionSidecarEntry,
	readCompactionSidecarEntries,
	copyGitTemplate,
	localApiFetch,
	SandboxSessionFilesystem,
	sessions,
	serverModule,
	rpcBridgeModule,
	agentSessionsDir,
	fixtureRoots,
	SYSTEM_AUTHOR,
	FIXTURE_TIME,
	deferred,
	messageEntry,
	seedTranscript,
	ordinaryHistory,
	setPersistedTranscriptPath,
	removeTrustedRecoveryTranscripts,
	seedTrustedRecoveryTranscript,
	historyFork,
	responseJson,
	statePath,
	filesystemIdentity,
	authorPath,
	transcriptFilesForSession,
	seedAuthorBinding,
	seedSkillBinding,
	seedForgedInlineSkillIdentity,
	seedCompactionBinding,
	createTrackedSession,
	createTrackedSessionWithoutWorktree,
	registerUntrackedFixtureProject,
	installSandboxSessionFilesystem,
	configureSandboxOwner,
	configureSandboxBorrower,
};
export type { TranscriptEntry };
