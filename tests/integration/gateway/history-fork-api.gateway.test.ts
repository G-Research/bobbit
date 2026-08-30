import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { test, expect } from "../../../tests2/integration/_e2e/in-process-harness.js";
import { sessionTranscriptHostPath } from "../../../src/server/agent/agent-session-path.js";
import {
	apiFetch,
	nonGitCwd,
} from "../../../tests2/integration/_e2e/e2e-setup.js";
import {
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	mergeAuthorSidecarIntoMessages,
	readAuthorSidecar,
} from "../../../src/server/agent/author-sidecar.js";
import {
	appendIdentifiedSkillSidecarEntry,
	appendSkillSidecarEntry,
	appendSkillSidecarTranscriptBinding,
	mergeSidecarEntriesIntoMessages,
	readSkillSidecarEntries,
} from "../../../src/server/skills/skill-sidecar.js";
import {
	appendCompactionSidecarEntry,
	readCompactionSidecarEntries,
} from "../../../src/server/agent/compaction-sidecar.js";
import {
	createSessionTracker,
	localApiFetch,
} from "../../../tests2/integration/helpers/session-fixtures.js";
import { loadServerTestRuntime } from "../../../tests2/harness/server-runtime.js";
import { SandboxSessionFilesystem } from "../../../tests2/harness/sandbox-session-filesystem.js";

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
	const response = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd, projectId, worktree: false }),
	});
	expect(response.status, await response.clone().text()).toBe(201);
	return sessions.add((await response.json()).id as string);
}

async function createTrackedSessionWithoutWorktree(cwd: string, projectId: string): Promise<string> {
	return createTrackedSession(cwd, projectId);
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

test.describe("history fork API", () => {
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

	test("resolves only authoritative persisted or trusted-root transcript paths", async ({ gateway }) => {
		const cwd = path.join(nonGitCwd(), `transcript-resolution-${randomUUID()}`);
		fs.mkdirSync(cwd, { recursive: true });
		fixtureRoots.push(cwd);
		const sourceId = await createTrackedSession(cwd);
		const seeded = seedTranscript(gateway, sourceId, ordinaryHistory());
		const manager = gateway.sessionManager;
		const persisted = manager.getPersistedSession(sourceId);

		const canonicalContainer = "/home/node/.bobbit/agent/sessions/--workspace--/authoritative.jsonl";
		expect(manager.recoverSessionFile({
			...persisted,
			sandboxed: true,
			agentSessionFile: canonicalContainer,
		})).toBe(canonicalContainer);
		expect(filesystemIdentity(manager.recoverSessionFile(persisted))).toBe(filesystemIdentity(seeded.file));

		const recovered = seedTrustedRecoveryTranscript(gateway, sourceId, seeded.content);
		const attackerRoot = path.join(gateway.bobbitDir, `untrusted-transcripts-${randomUUID()}`);
		const lexicalParent = path.join(attackerRoot, "lexical-parent");
		fs.mkdirSync(lexicalParent, { recursive: true });
		fixtureRoots.push(attackerRoot);
		const traversalTarget = path.join(attackerRoot, "traversal-canary.jsonl");
		fs.writeFileSync(traversalTarget, seeded.content, "utf8");
		const traversalPath = `${lexicalParent}${path.sep}..${path.sep}${path.basename(traversalTarget)}`;
		const malformedOutside = path.join(attackerRoot, "malformed.jsonl");
		fs.writeFileSync(malformedOutside, '{"not":"a transcript"}\n', "utf8");
		const wrongExtension = path.join(attackerRoot, "recognizable.txt");
		fs.writeFileSync(wrongExtension, seeded.content, "utf8");
		const directoryPath = path.join(attackerRoot, "directory.jsonl");
		fs.mkdirSync(directoryPath);

		const rejectedStoredPaths = [traversalPath, malformedOutside, wrongExtension, directoryPath];
		const symlinkPath = path.join(attackerRoot, "symlink.jsonl");
		try {
			fs.symlinkSync(traversalTarget, symlinkPath, "file");
			rejectedStoredPaths.push(symlinkPath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (!["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) throw error;
		}

		for (const storedPath of rejectedStoredPaths) {
			const resolved = manager.recoverSessionFile({ ...persisted, agentSessionFile: storedPath });
			expect(filesystemIdentity(resolved), storedPath).toBe(filesystemIdentity(recovered));
			expect(path.resolve(resolved), storedPath).not.toBe(path.resolve(storedPath));
		}

		fs.rmSync(recovered, { force: true });
		for (const storedPath of rejectedStoredPaths) {
			expect(manager.recoverSessionFile({ ...persisted, agentSessionFile: storedPath }), storedPath).toBeNull();
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
		expect(await responseJson(invalidMode)).toEqual({ error: "Invalid newWorktree flag" });

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

	test("history fork rejects raw malicious paths and reads only a recovered trusted transcript", async ({ gateway }) => {
		const cwd = path.join(nonGitCwd(), `malicious-fork-source-${randomUUID()}`);
		fs.mkdirSync(cwd, { recursive: true });
		fixtureRoots.push(cwd);
		const sourceId = await createTrackedSession(cwd);
		const seeded = seedTranscript(gateway, sourceId, ordinaryHistory());
		const trusted = seedTrustedRecoveryTranscript(gateway, sourceId, seeded.content);
		const trustedBytes = fs.readFileSync(trusted);

		const attackerRoot = path.join(gateway.bobbitDir, `history-fork-attacker-${randomUUID()}`);
		const lexicalParent = path.join(attackerRoot, "lexical-parent");
		fs.mkdirSync(lexicalParent, { recursive: true });
		fixtureRoots.push(attackerRoot);
		const attackerFile = path.join(attackerRoot, "attacker.jsonl");
		const attackerEntries = [
			messageEntry("attacker-user", null, "user", "ATTACKER_CANARY"),
			messageEntry("attacker-assistant", "attacker-user", "assistant", "attacker answer"),
			messageEntry("selected-user", "attacker-assistant", "user", "attacker selected prompt"),
		];
		const attackerContent = [seeded.header, ...attackerEntries]
			.map(entry => JSON.stringify(entry)).join("\n") + "\n";
		fs.writeFileSync(attackerFile, attackerContent, "utf8");
		const attackerBytes = fs.readFileSync(attackerFile);
		const maliciousStoredPath = `${lexicalParent}${path.sep}..${path.sep}${path.basename(attackerFile)}`;
		setPersistedTranscriptPath(gateway, sourceId, maliciousStoredPath);

		const response = await historyFork(gateway, sourceId, "selected-user", false);
		expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);
		const forkPersisted = gateway.sessionManager.getPersistedSession(fork.id);
		const forkTranscript = fs.readFileSync(forkPersisted.agentSessionFile, "utf8");
		expect(forkTranscript).toContain("retained prompt");
		expect(forkTranscript).not.toContain("selected prompt");
		expect(forkTranscript).not.toContain("ATTACKER_CANARY");
		expect(fs.readFileSync(attackerFile).equals(attackerBytes), "outside canary remains byte-identical").toBe(true);
		expect(fs.readFileSync(trusted).equals(trustedBytes), "recovered source remains byte-identical").toBe(true);
		expect(gateway.sessionManager.getPersistedSession(sourceId).agentSessionFile).toBe(maliciousStoredPath);
		expect(gateway.sessionManager.getSession(sourceId)).toBeTruthy();

		const unavailableCwd = path.join(nonGitCwd(), `malicious-fork-unavailable-${randomUUID()}`);
		fs.mkdirSync(unavailableCwd, { recursive: true });
		fixtureRoots.push(unavailableCwd);
		const unavailableId = await createTrackedSession(unavailableCwd);
		setPersistedTranscriptPath(gateway, unavailableId, maliciousStoredPath);
		removeTrustedRecoveryTranscripts(unavailableId);
		const beforeIds = new Set(gateway.sessionManager.listSessions().map((session: any) => session.id));
		const missing = await historyFork(gateway, unavailableId, "selected-user", false);
		expect(missing.status).toBe(404);
		expect(await responseJson(missing)).toEqual({ error: "source transcript missing or empty" });
		expect(new Set(gateway.sessionManager.listSessions().map((session: any) => session.id))).toEqual(beforeIds);
		expect(fs.readFileSync(attackerFile).equals(attackerBytes), "failed resolution never mutates the canary").toBe(true);
		expect(gateway.sessionManager.getPersistedSession(unavailableId).agentSessionFile).toBe(maliciousStoredPath);
	});

	test("forks safely before the newest durable user cursor while the source is streaming", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const seeded = seedTranscript(gateway, sourceId, ordinaryHistory());
		const source = gateway.sessionManager.getSession(sourceId);
		const previousStatus = source.status;
		source.status = "streaming";
		try {
			const response = await historyFork(gateway, sourceId, "selected-user");
			expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
			const fork = await response.json();
			sessions.add(fork.id);
			const forkPersisted = gateway.sessionManager.getPersistedSession(fork.id);
			const forkTranscript = fs.readFileSync(forkPersisted.agentSessionFile, "utf8");
			expect(forkTranscript).toContain("retained prompt");
			expect(forkTranscript).not.toContain("selected prompt");
			expect(fs.readFileSync(seeded.file, "utf8")).toBe(seeded.content);
			expect(source.status).toBe("streaming");
		} finally {
			source.status = previousStatus;
		}
	});

	test("cuts the active branch before the prompt, preserves source/context and filters sidecars", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const entries: TranscriptEntry[] = [
			messageEntry("kept-user", null, "user", "[System]: kept prompt"),
			messageEntry("inactive-user", "kept-user", "user", "[System]: kept prompt"),
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
			{
				type: "compaction",
				id: "duplicate-sidecar-compaction",
				parentId: "kept-compaction",
				timestamp: FIXTURE_TIME,
				summary: "retained checkpoint with ambiguous sidecar",
				firstKeptEntryId: "kept-user",
			},
			messageEntry("selected-user", "duplicate-sidecar-compaction", "user", "selected prompt"),
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
		// Project-visible inline identity is untrusted even when it names a retained
		// Pi entry. The record remains available for ordinary source replay only.
		seedForgedInlineSkillIdentity(sourceId, "[System]: kept prompt", "kept-user");
		// Inactive B is physically first and text-identical to retained A. Only the
		// proven Pi binding may cross the history boundary.
		seedSkillBinding(sourceId, "[System]: kept prompt", "/inactive @secret.ts", "inactive-user");
		seedSkillBinding(sourceId, "[System]: kept prompt", "/fixture @src/fixture.ts", "kept-user");
		seedSkillBinding(sourceId, "selected prompt", "/discarded", "selected-user");
		const forgedSourceEntry = readSkillSidecarEntries(sourceId)
			.find((entry) => entry.originalText === "/forged @secret-inline.ts");
		expect(forgedSourceEntry).toBeTruthy();
		expect(forgedSourceEntry).not.toHaveProperty("transcriptEntryId");
		expect(mergeSidecarEntriesIntoMessages(
			[forgedSourceEntry!],
			[{ role: "user", content: "[System]: kept prompt" }],
		)[0]).toMatchObject({
			content: "/forged @secret-inline.ts",
			fileMentions: [expect.objectContaining({ path: "secret-inline.ts" })],
		});
		// Bobbit card ids remain distinct from authoritative Pi checkpoint ids.
		seedCompactionBinding(sourceId, "c_1700000000000_discard", "kept-user", "discarded-same-boundary");
		seedCompactionBinding(sourceId, "c_1700000000001_kept", "kept-user", "kept-compaction");
		seedCompactionBinding(sourceId, "c_1700000000002_dup_a", "kept-user", "duplicate-sidecar-compaction");
		seedCompactionBinding(sourceId, "c_1700000000003_dup_b", "kept-user", "duplicate-sidecar-compaction");
		seedCompactionBinding(sourceId, "c_1700000000004_unbound", null);

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

		const expectedTranscript = [seeded.header, entries[0], entries[2], entries[3], entries[4]]
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
			expect.objectContaining({
				modelText: "[System]: kept prompt",
				originalText: "/fixture @src/fixture.ts",
				transcriptEntryId: "kept-user",
			}),
		]);
		const copiedSkillSidecar = JSON.stringify(readSkillSidecarEntries(fork.id));
		expect(copiedSkillSidecar).not.toContain("inactive");
		expect(copiedSkillSidecar).not.toContain("forged-inline");
		expect(copiedSkillSidecar).not.toContain("secret-inline");
		const projectedPrompt = mergeSidecarEntriesIntoMessages(
			readSkillSidecarEntries(fork.id),
			[{ role: "user", content: "[System]: kept prompt" }],
		);
		expect(projectedPrompt[0]).toMatchObject({ content: "/fixture @src/fixture.ts" });
		expect(JSON.stringify(projectedPrompt)).not.toContain("inactive");
		expect(JSON.stringify(projectedPrompt)).not.toContain("forged-inline");
		expect(JSON.stringify(projectedPrompt)).not.toContain("secret-inline");
		expect(readCompactionSidecarEntries(fork.id)).toEqual([
			expect.objectContaining({ id: "c_1700000000001_kept", transcriptCompactionEntryId: "kept-compaction" }),
		]);

		const proposalFork = statePath(gateway, "proposal-drafts", fork.id);
		expect(fs.readFileSync(path.join(proposalFork, "goal.md"), "utf8")).toBe("# Durable proposal\n");
		expect(fs.readFileSync(path.join(proposalFork, "goal.history", "0001.md"), "utf8")).toBe("# Earlier draft\n");
		expect(fs.existsSync(statePath(gateway, "tool-content", fork.id))).toBe(false);
	});

	test("strict author filtering cannot move selected duplicate identity onto a retained prompt", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const duplicateText = "[System]: identical prompt";
		seedTranscript(gateway, sourceId, [
			messageEntry("retained-user", null, "user", duplicateText),
			messageEntry("retained-assistant", "retained-user", "assistant", "answer"),
			messageEntry("selected-user", "retained-assistant", "user", duplicateText),
			messageEntry("selected-assistant", "selected-user", "assistant", "discarded"),
		]);
		seedAuthorBinding(sourceId, "retained-exact-author", "retained-user", duplicateText);
		expect(appendPromptAuthorDispatch(sourceId, {
			promptId: "selected-weak-author",
			dispatchedAt: Date.parse(FIXTURE_TIME) + 10,
			modelText: duplicateText,
			modelPrefix: "[System]: ",
			source: "task-notification",
			author: SYSTEM_AUTHOR,
		})).toBe(true);
		expect(appendPromptAuthorSettlement(sourceId, {
			promptId: "selected-weak-author",
			settledAt: Date.parse(FIXTURE_TIME) + 11,
			outcome: "echoed",
		})).toBe(true);

		const response = await historyFork(gateway, sourceId, "selected-user", false);
		expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);
		const copied = readAuthorSidecar(fork.id);
		expect(copied.map(binding => binding.promptId)).toEqual(["retained-exact-author"]);
		expect(JSON.stringify(copied)).not.toContain("selected-weak-author");
		const [projected] = mergeAuthorSidecarIntoMessages(copied, [{
			id: "retained-user",
			role: "user",
			content: duplicateText,
		}]);
		expect(projected).toMatchObject({
			content: "identical prompt",
			author: SYSTEM_AUTHOR,
		});
	});

	test("fails and purges the destination when any filtered sidecar copy fails", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const entries: TranscriptEntry[] = [
			messageEntry("kept-user", null, "user", "[System]: kept prompt"),
			{
				type: "compaction",
				id: "kept-compaction",
				parentId: "kept-user",
				timestamp: FIXTURE_TIME,
				summary: "retained summary",
				firstKeptEntryId: "kept-user",
			},
			messageEntry("selected-user", "kept-compaction", "user", "selected prompt"),
		];
		const seeded = seedTranscript(gateway, sourceId, entries);
		const sourceBytes = fs.readFileSync(seeded.file);
		seedAuthorBinding(sourceId, "author-kept", "kept-user", "[System]: kept prompt");
		seedSkillBinding(sourceId, "[System]: kept prompt", "/fixture");
		seedCompactionBinding(sourceId, "kept-compaction", "kept-user");
		const proposalSource = statePath(gateway, "proposal-drafts", sourceId);
		fs.mkdirSync(proposalSource, { recursive: true });
		fs.writeFileSync(path.join(proposalSource, "goal.md"), "source proposal", "utf8");

		for (const failedKind of ["skill", "compaction", "author"] as const) {
			let destinationId = "";
			serverModule.__setHistoryForkSidecarCopyFake((
				kind: "skill" | "compaction" | "author",
				fromSessionId: string,
				toSessionId: string,
			) => {
				expect(fromSessionId).toBe(sourceId);
				destinationId = toSessionId;
				return kind === failedKind ? false : undefined;
			});

			let response: Response;
			try {
				response = await historyFork(gateway, sourceId, "selected-user", false);
			} finally {
				serverModule.__clearHistoryForkSidecarCopyFake();
			}
			expect(response.status).toBe(500);
			expect((await responseJson(response)).error).toContain(`failed to copy filtered ${failedKind} sidecar`);
			expect(destinationId).toBeTruthy();
			expect(gateway.sessionManager.getSession(destinationId)).toBeUndefined();
			expect(gateway.sessionManager.getPersistedSession(destinationId)).toBeUndefined();
			expect(transcriptFilesForSession(agentSessionsDir, destinationId)).toEqual([]);
			expect(fs.existsSync(authorPath(gateway, destinationId))).toBe(false);
			expect(fs.existsSync(statePath(gateway, "skill-sidecar", destinationId, ".jsonl"))).toBe(false);
			expect(fs.existsSync(statePath(gateway, "compaction-sidecar", destinationId, ".jsonl"))).toBe(false);
			expect(fs.existsSync(statePath(gateway, "proposal-drafts", destinationId))).toBe(false);
			expect(fs.existsSync(statePath(gateway, "tool-content", destinationId))).toBe(false);
			expect(fs.readFileSync(seeded.file).equals(sourceBytes), "source JSONL bytes remain unchanged").toBe(true);
			expect(gateway.sessionManager.getSession(sourceId), "source remains live").toBeTruthy();
		}
	});

	test("reuse mode uses the exact live cwd and carries no worktree teardown ownership", async ({ gateway }) => {
		const sourceWorktree = path.join(nonGitCwd(), `history-source-${randomUUID()}`);
		const liveCwd = path.join(sourceWorktree, "packages", "web");
		fs.mkdirSync(liveCwd, { recursive: true });
		fixtureRoots.push(sourceWorktree);
		const sentinel = path.join(sourceWorktree, "uncommitted.txt");
		fs.writeFileSync(sentinel, "preserve working state", "utf8");

		const sourceId = await createTrackedSession(liveCwd);
		const sourceTranscript = seedTranscript(gateway, sourceId, ordinaryHistory());
		const sourceBytes = fs.readFileSync(sourceTranscript.file);
		const sourcePersisted = gateway.sessionManager.getPersistedSession(sourceId);
		gateway.sessionManager.getSessionStore(sourcePersisted.projectId).update(sourceId, {
			cwd: liveCwd,
			worktreePath: sourceWorktree,
			repoPath: nonGitCwd(),
			branch: "feature/shared-source",
		});
		gateway.sessionManager.getSession(sourceId).cwd = liveCwd;
		const sourceCoordinates = {
			cwd: liveCwd,
			worktreePath: sourceWorktree,
			repoPath: nonGitCwd(),
			branch: "feature/shared-source",
		};

		const manager = gateway.sessionManager;
		const originalCreateSession = manager.createSession;
		let capturedOptions: any;
		manager.createSession = async (...args: any[]) => {
			capturedOptions = args[4];
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
		const forkPersisted = gateway.sessionManager.getPersistedSession(fork.id);
		expect(capturedOptions.worktreeOpts).toBeUndefined();
		expect(capturedOptions.awaitWorktreeSetup).toBeUndefined();
		expect(capturedOptions.borrowsWorktree).toBe(true);
		expect(fork.cwd).toBe(liveCwd);
		expect(forkPersisted.cwd).toBe(liveCwd);
		expect(forkPersisted.borrowsWorktree).toBe(true);
		expect(forkPersisted.worktreePath).toBeUndefined();
		expect(forkPersisted.repoPath).toBeUndefined();
		expect(forkPersisted.branch).toBeUndefined();

		await gateway.sessionManager.terminateSession(fork.id);
		expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve working state");
		expect(fs.existsSync(sourceWorktree)).toBe(true);
		expect(fs.readFileSync(sourceTranscript.file).equals(sourceBytes), "source JSONL bytes remain unchanged").toBe(true);
		expect(gateway.sessionManager.getSession(sourceId), "terminating fork does not stop source").toBeTruthy();
		expect(gateway.sessionManager.getPersistedSession(sourceId)).toMatchObject(sourceCoordinates);
	});

	test("forking from a sandbox borrower flattens durable ownership to the original worktree owner", async ({ gateway }) => {
		const ownerId = await createTrackedSession();
		const borrowerId = await createTrackedSession();
		const ownerCoordinates = configureSandboxOwner(gateway, ownerId, `flatten-${randomUUID()}`);
		configureSandboxBorrower(gateway, borrowerId, ownerId, ownerCoordinates.cwd);
		seedTranscript(gateway, borrowerId, ordinaryHistory());
		expect(gateway.sessionManager.resolveSandboxWorktreeOwnerSessionId(borrowerId)).toBe(ownerId);

		const manager = gateway.sessionManager;
		const originalCreateSession = manager.createSession;
		const sandboxFixture = installSandboxSessionFilesystem(gateway, "flatten-borrower");
		let capturedOptions: any;
		manager.createSession = async (...args: any[]) => {
			capturedOptions = args[4];
			args[0] = nonGitCwd();
			args[4] = {
				...args[4],
				sandboxed: false,
			};
			return originalCreateSession.apply(manager, args);
		};
		let response: Response;
		try {
			response = await historyFork(gateway, borrowerId, "selected-user", false);
		} finally {
			manager.createSession = originalCreateSession;
			sandboxFixture.restore();
		}

		expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);
		const forkPersisted = gateway.sessionManager.getPersistedSession(fork.id);
		expect(capturedOptions.borrowedWorktreeOwnerSessionId).toBe(ownerId);
		expect(capturedOptions.borrowedWorktreeOwnerSessionId).not.toBe(borrowerId);
		expect(forkPersisted).toMatchObject({
			borrowsWorktree: true,
			borrowedWorktreeOwnerSessionId: ownerId,
		});
	});

	test("publishes, rebases, and rehydrates a sandbox history transcript using canonical container coordinates", async ({ gateway }) => {
		const project = await registerUntrackedFixtureProject(gateway, "container-coordinate-project");
		const sourceId = await createTrackedSession(project.rootPath, project.id);
		const sourceCoordinates = configureSandboxOwner(gateway, sourceId, `container-coordinate-${randomUUID()}`);
		const seeded = seedTranscript(gateway, sourceId, ordinaryHistory());
		const manager = gateway.sessionManager;
		const sandboxFixture = installSandboxSessionFilesystem(gateway, "container-coordinate");
		const sourceContainerPath = `/home/node/.bobbit/agent/sessions/--canonical-source--/${sourceId}.jsonl`;
		const sourceHostPath = sessionTranscriptHostPath(sourceId, sourceContainerPath)!;
		fs.mkdirSync(path.dirname(sourceHostPath), { recursive: true });
		fs.writeFileSync(sourceHostPath, seeded.content, "utf8");
		setPersistedTranscriptPath(gateway, sourceId, sourceContainerPath);
		const sourceBytes = fs.readFileSync(sourceHostPath);
		const originalApplySandboxWiring = manager.applySandboxWiring;
		const originalSendCommand = rpcBridgeModule.RpcBridge.prototype.sendCommand;
		manager.applySandboxWiring = async (options: any) => {
			options.cwd = nonGitCwd();
			options.sandboxed = true;
			delete options.containerId;
			return true;
		};
		rpcBridgeModule.RpcBridge.prototype.sendCommand = function(command: any, ...rest: any[]) {
			if (command?.type === "switch_session" && typeof command.sessionPath === "string") {
				const owner = path.basename(command.sessionPath, ".jsonl").split("_").at(-1)!;
				command = { ...command, sessionPath: sessionTranscriptHostPath(owner, command.sessionPath) };
			}
			return originalSendCommand.call(this, command, ...rest);
		};

		let response: Response;
		try {
			response = await historyFork(gateway, sourceId, "selected-user", false);
		} finally {
			manager.applySandboxWiring = originalApplySandboxWiring;
			rpcBridgeModule.RpcBridge.prototype.sendCommand = originalSendCommand;
			sandboxFixture.restore();
		}

		expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);
		const persisted = manager.getPersistedSession(fork.id);
		expect(persisted).toMatchObject({
			sandboxed: true,
			borrowsWorktree: true,
			borrowedWorktreeOwnerSessionId: sourceId,
		});
		expect(persisted.agentSessionFile).toMatch(/^\/home\/node\/\.bobbit\/agent\/sessions\//);
		const destinationBytes = fs.readFileSync(
			sessionTranscriptHostPath(fork.id, persisted.agentSessionFile)!,
			"utf8",
		);
		expect(destinationBytes).toContain("retained prompt");
		expect(destinationBytes).not.toContain("selected prompt");
		expect(destinationBytes).not.toContain("discarded answer");
		expect(fs.readFileSync(sourceHostPath).equals(sourceBytes)).toBe(true);
		expect(manager.getPersistedSession(sourceId)).toMatchObject({
			cwd: sourceCoordinates.cwd,
			worktreePath: sourceCoordinates.root,
			branch: sourceCoordinates.branch,
			agentSessionFile: sourceContainerPath,
		});
	});

	test("fork registration wins the owner FIFO before DELETE, which waits and rejects without mutation", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const sourceCoordinates = configureSandboxOwner(gateway, sourceId, `fork-wins-${randomUUID()}`);
		const seeded = seedTranscript(gateway, sourceId, ordinaryHistory());
		const manager = gateway.sessionManager;
		const source = manager.getSession(sourceId);
		const originalCreateSession = manager.createSession;
		const originalLifecycle = manager.withSandboxWorktreeOwnerLifecycle;
		const originalSandboxManager = manager.sandboxManager;
		const createEntered = deferred<void>();
		const releaseCreate = deferred<void>();
		const deleteQueued = deferred<void>();
		const removed: string[] = [];
		let lifecycleCalls = 0;
		let sourceStopCalls = 0;
		const originalSourceStop = source.rpcClient.stop;
		let forkId = "";

		const sandboxFixture = installSandboxSessionFilesystem(gateway, "fork-wins", removed);
		manager.withSandboxWorktreeOwnerLifecycle = function(ownerId: string, operation: () => Promise<unknown>) {
			lifecycleCalls++;
			if (lifecycleCalls === 2) deleteQueued.resolve();
			return originalLifecycle.call(this, ownerId, operation);
		};
		manager.createSession = async (...args: any[]) => {
			createEntered.resolve();
			await releaseCreate.promise;
			args[0] = nonGitCwd();
			args[4] = {
				...args[4],
				sandboxed: false,
			};
			return originalCreateSession.apply(manager, args);
		};
		source.rpcClient.stop = async (...args: any[]) => {
			sourceStopCalls++;
			return originalSourceStop.apply(source.rpcClient, args);
		};

		try {
			const forkPromise = historyFork(gateway, sourceId, "selected-user", false);
			await createEntered.promise;
			const deletePromise = localApiFetch(gateway, `/api/sessions/${sourceId}`, { method: "DELETE" });
			await deleteQueued.promise;
			expect(lifecycleCalls).toBe(2);
			expect(manager.getSession(sourceId)).toBe(source);

			releaseCreate.resolve();
			const forkResponse = await forkPromise;
			expect(forkResponse.status, JSON.stringify(await responseJson(forkResponse))).toBe(201);
			const fork = await forkResponse.json();
			forkId = sessions.add(fork.id);

			const deleteResponse = await deletePromise;
			expect(deleteResponse.status).toBe(409);
			expect(await responseJson(deleteResponse)).toMatchObject({ code: "SHARED_SANDBOX_WORKTREE_IN_USE" });
		} finally {
			releaseCreate.resolve();
			manager.createSession = originalCreateSession;
			manager.withSandboxWorktreeOwnerLifecycle = originalLifecycle;
			manager.sandboxManager = originalSandboxManager;
			sandboxFixture.restore();
			source.rpcClient.stop = originalSourceStop;
		}

		expect(sourceStopCalls).toBe(0);
		expect(removed).toEqual([]);
		expect(manager.getSession(sourceId)).toBe(source);
		const preservedSource = manager.getPersistedSession(sourceId);
		expect(preservedSource?.agentSessionFile).toMatch(/^\/home\/node\/\.bobbit\/agent\/sessions\//);
		const preservedSourceHost = sessionTranscriptHostPath(sourceId, preservedSource!.agentSessionFile);
		expect(preservedSourceHost).toBeTruthy();
		expect(fs.readFileSync(preservedSourceHost!, "utf8")).toBe(seeded.content);
		expect(preservedSource?.archived).not.toBe(true);
		expect(manager.getSession(forkId)).toBeTruthy();
		expect(manager.getPersistedSession(forkId)).toMatchObject({
			borrowsWorktree: true,
			borrowedWorktreeOwnerSessionId: sourceId,
		});
		expect(sourceCoordinates.branch).toMatch(/^session\/fork-wins-/);
	});

	test("owner DELETE wins the FIFO before fork registration, which cleans artifacts and never recreates", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const sourceCoordinates = configureSandboxOwner(gateway, sourceId, `delete-wins-${randomUUID()}`);
		seedTranscript(gateway, sourceId, ordinaryHistory());
		const manager = gateway.sessionManager;
		const source = manager.getSession(sourceId);
		const originalCreateSession = manager.createSession;
		const originalLifecycle = manager.withSandboxWorktreeOwnerLifecycle;
		const originalSandboxManager = manager.sandboxManager;
		const originalGetState = source.rpcClient.getState;
		const deleteEntered = deferred<void>();
		const releaseDelete = deferred<void>();
		const forkQueued = deferred<void>();
		const removed: string[] = [];
		let lifecycleCalls = 0;
		let createCalls = 0;
		let destinationId = "";

		const sandboxFixture = installSandboxSessionFilesystem(gateway, "delete-wins", removed);
		manager.withSandboxWorktreeOwnerLifecycle = function(ownerId: string, operation: () => Promise<unknown>) {
			lifecycleCalls++;
			if (lifecycleCalls === 2) forkQueued.resolve();
			return originalLifecycle.call(this, ownerId, operation);
		};
		source.rpcClient.getState = async () => {
			deleteEntered.resolve();
			await releaseDelete.promise;
			return { success: true, data: {} };
		};
		manager.createSession = async () => {
			createCalls++;
			throw new Error("fork must not recreate after owner termination");
		};
		serverModule.__setHistoryForkSidecarCopyFake((
			_kind: "skill" | "compaction" | "author",
			_fromSessionId: string,
			toSessionId: string,
		) => {
			destinationId = toSessionId;
			return undefined;
		});

		let deleteResponse: Response;
		let forkResponse: Response;
		try {
			const deletePromise = localApiFetch(gateway, `/api/sessions/${sourceId}`, { method: "DELETE" });
			await deleteEntered.promise;
			const forkPromise = historyFork(gateway, sourceId, "selected-user", false);
			await forkQueued.promise;
			expect(destinationId).toBeTruthy();
			expect(lifecycleCalls).toBe(2);

			releaseDelete.resolve();
			deleteResponse = await deletePromise;
			forkResponse = await forkPromise;
		} finally {
			releaseDelete.resolve();
			serverModule.__clearHistoryForkSidecarCopyFake();
			manager.createSession = originalCreateSession;
			manager.withSandboxWorktreeOwnerLifecycle = originalLifecycle;
			manager.sandboxManager = originalSandboxManager;
			sandboxFixture.restore();
			source.rpcClient.getState = originalGetState;
		}

		expect(deleteResponse!.status).toBe(200);
		expect(forkResponse!.status).toBe(422);
		expect(await responseJson(forkResponse!)).toEqual({
			error: "The source session is no longer available for history forking",
			code: "HISTORY_FORK_SOURCE_UNAVAILABLE",
		});
		expect(createCalls).toBe(0);
		expect(removed).toEqual([sourceCoordinates.branch]);
		expect(manager.getSession(sourceId)).toBeUndefined();
		expect(manager.getPersistedSession(sourceId)?.archived).toBe(true);
		expect(manager.getSession(destinationId)).toBeUndefined();
		expect(manager.getPersistedSession(destinationId)).toBeUndefined();
		expect(transcriptFilesForSession(agentSessionsDir, destinationId)).toEqual([]);
		expect(fs.existsSync(authorPath(gateway, destinationId))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "skill-sidecar", destinationId, ".jsonl"))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "compaction-sidecar", destinationId, ".jsonl"))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "proposal-drafts", destinationId))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "tool-content", destinationId))).toBe(false);
	});

	test("project DELETE terminates a shared-worktree borrower before its owner and removes the owner worktree once", async ({ gateway }) => {
		const project = await registerUntrackedFixtureProject(gateway, "project-delete-borrower-order");
		const ownerId = await createTrackedSessionWithoutWorktree(project.rootPath, project.id);
		const borrowerId = await createTrackedSessionWithoutWorktree(project.rootPath, project.id);
		const ownerCoordinates = configureSandboxOwner(gateway, ownerId, `project-delete-${randomUUID()}`);
		configureSandboxBorrower(gateway, borrowerId, ownerId, ownerCoordinates.cwd);

		const manager = gateway.sessionManager;
		const projectContexts = gateway.projectContextManager;
		const registry = projectContexts.getRegistry();
		const initialContext = projectContexts.getOrCreate(project.id);
		expect(initialContext).toBeTruthy();
		expect(registry.get(project.id)).toMatchObject({ id: project.id });

		const originalTerminateSession = manager.terminateSession;
		const originalSandboxManager = manager.sandboxManager;
		const terminationOrder: string[] = [];
		const removed: string[] = [];
		let response: Response | undefined;
		const sandboxFixture = installSandboxSessionFilesystem(gateway, "project-delete", removed);
		manager.terminateSession = async (sessionId: string) => {
			terminationOrder.push(sessionId);
			return originalTerminateSession.call(manager, sessionId);
		};

		try {
			response = await localApiFetch(gateway, `/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
		} finally {
			manager.terminateSession = originalTerminateSession;
			manager.sandboxManager = originalSandboxManager;
			sandboxFixture.restore();
			if (response?.status !== 200) {
				await manager.terminateSession(borrowerId).catch(() => undefined);
				await manager.terminateSession(ownerId).catch(() => undefined);
				await localApiFetch(gateway, `/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" }).catch(() => undefined);
			}
		}

		expect(response!.status, JSON.stringify(await responseJson(response!))).toBe(200);
		expect(await response!.json()).toEqual({ ok: true });
		expect(terminationOrder).toEqual([borrowerId, ownerId]);
		expect(removed).toEqual([ownerCoordinates.branch]);
		expect(manager.getSession(borrowerId)).toBeUndefined();
		expect(manager.getSession(ownerId)).toBeUndefined();
		expect(manager.getAllSessionsRaw().filter((session: any) => session.projectId === project.id)).toEqual([]);
		expect(Array.from(projectContexts.all()).some((context: any) => context.project.id === project.id)).toBe(false);
		expect(registry.get(project.id)).toBeUndefined();
	});

	test("history borrower registration wins the owner FIFO and makes concurrent project DELETE return a typed 409", async ({ gateway, scope }) => {
		const project = await registerUntrackedFixtureProject(gateway, "project-delete-borrower-wins");
		scope.trackProject(project.id);
		const sourceId = await createTrackedSessionWithoutWorktree(project.rootPath, project.id);
		const sourceCoordinates = configureSandboxOwner(gateway, sourceId, `project-delete-fork-wins-${randomUUID()}`);
		const seeded = seedTranscript(gateway, sourceId, ordinaryHistory());
		const manager = gateway.sessionManager;
		const source = manager.getSession(sourceId);
		const projectContexts = gateway.projectContextManager;
		const registry = projectContexts.getRegistry();
		const initialContext = projectContexts.getOrCreate(project.id);
		expect(initialContext).toBeTruthy();

		const originalCreateSession = manager.createSession;
		const originalLifecycle = manager.withSandboxWorktreeOwnerLifecycle;
		const originalSandboxManager = manager.sandboxManager;
		const originalSourceStop = source.rpcClient.stop;
		const createEntered = deferred<void>();
		const releaseCreate = deferred<void>();
		const projectDeleteQueued = deferred<void>();
		const removed: string[] = [];
		let lifecycleCalls = 0;
		let sourceStopCalls = 0;
		let forkId = "";
		let deletePromise: Promise<Response> | undefined;
		let deleteResponse: Response | undefined;

		const sandboxFixture = installSandboxSessionFilesystem(gateway, "project-delete-fork-wins", removed);
		manager.withSandboxWorktreeOwnerLifecycle = function(ownerId: string, operation: () => Promise<unknown>) {
			lifecycleCalls++;
			if (lifecycleCalls === 2) projectDeleteQueued.resolve();
			return originalLifecycle.call(this, ownerId, operation);
		};
		manager.createSession = async (...args: any[]) => {
			createEntered.resolve();
			await releaseCreate.promise;
			args[0] = project.rootPath;
			args[4] = {
				...args[4],
				sandboxed: false,
			};
			const created = await originalCreateSession.apply(manager, args);
			configureSandboxBorrower(gateway, created.id, sourceId, sourceCoordinates.cwd);
			return created;
		};
		source.rpcClient.stop = async (...args: any[]) => {
			sourceStopCalls++;
			return originalSourceStop.apply(source.rpcClient, args);
		};

		try {
			const forkPromise = historyFork(gateway, sourceId, "selected-user", false);
			await createEntered.promise;
			deletePromise = localApiFetch(gateway, `/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
			await projectDeleteQueued.promise;
			expect(lifecycleCalls).toBe(2);
			expect(manager.getSession(sourceId)).toBe(source);

			releaseCreate.resolve();
			const forkResponse = await forkPromise;
			expect(forkResponse.status, JSON.stringify(await responseJson(forkResponse))).toBe(201);
			const fork = await forkResponse.json();
			forkId = sessions.add(fork.id);
			deleteResponse = await deletePromise;
		} finally {
			releaseCreate.resolve();
			if (deletePromise && !deleteResponse) deleteResponse = await deletePromise.catch(() => undefined);
			manager.createSession = originalCreateSession;
			manager.withSandboxWorktreeOwnerLifecycle = originalLifecycle;
			manager.sandboxManager = originalSandboxManager;
			sandboxFixture.restore();
			source.rpcClient.stop = originalSourceStop;
		}

		expect(deleteResponse!.status).toBe(409);
		expect(await responseJson(deleteResponse!)).toMatchObject({ code: "SHARED_SANDBOX_WORKTREE_IN_USE" });
		expect(sourceStopCalls).toBe(0);
		expect(removed).toEqual([]);
		expect(manager.getSession(sourceId)).toBe(source);
		const preservedSource = manager.getPersistedSession(sourceId);
		expect(preservedSource?.agentSessionFile).toMatch(/^\/home\/node\/\.bobbit\/agent\/sessions\//);
		const preservedSourceHost = sessionTranscriptHostPath(sourceId, preservedSource!.agentSessionFile);
		expect(preservedSourceHost).toBeTruthy();
		expect(fs.readFileSync(preservedSourceHost!, "utf8")).toBe(seeded.content);
		expect(preservedSource?.archived).not.toBe(true);
		expect(manager.getSession(forkId)).toBeTruthy();
		expect(manager.getPersistedSession(forkId)).toMatchObject({
			projectId: project.id,
			sandboxed: true,
			borrowsWorktree: true,
			borrowedWorktreeOwnerSessionId: sourceId,
		});
		expect(manager.resolveSandboxWorktreeOwnerSessionId(forkId)).toBe(sourceId);
		expect(projectContexts.getOrCreate(project.id)).toBe(initialContext);
		expect(registry.get(project.id)).toMatchObject({ id: project.id });
		expect(sourceCoordinates.branch).toMatch(/^session\/project-delete-fork-wins-/);
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
		const sandboxFixture = installSandboxSessionFilesystem(gateway, "failed-deduplication");
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
			sandboxFixture.restore();
		}

		expect(capturedDestinationId).toBeTruthy();
		expect(capturedDestinationFile).toMatch(/^\/home\/node\/\.bobbit\/agent\/sessions\//);
		const capturedDestinationHost = sessionTranscriptHostPath(capturedDestinationId, capturedDestinationFile);
		expect(capturedDestinationHost).toBeTruthy();
		expect(fs.existsSync(capturedDestinationHost!)).toBe(false);
		expect(fs.existsSync(authorPath(gateway, capturedDestinationId))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "skill-sidecar", capturedDestinationId, ".jsonl"))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "compaction-sidecar", capturedDestinationId, ".jsonl"))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "proposal-drafts", capturedDestinationId))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "tool-content", capturedDestinationId))).toBe(false);

		const migratedSource = gateway.sessionManager.getPersistedSession(sourceId);
		const migratedSourceHost = sessionTranscriptHostPath(sourceId, migratedSource.agentSessionFile);
		expect(migratedSourceHost).toBeTruthy();
		gateway.sessionManager.getSessionStore(sourcePersisted.projectId).update(sourceId, {
			sandboxed: false,
			agentSessionFile: migratedSourceHost!,
		});
		Object.assign(gateway.sessionManager.getSession(sourceId), {
			sandboxed: false,
			agentSessionFile: migratedSourceHost!,
		});
		const retry = await historyFork(gateway, sourceId, "selected-user", false);
		expect(retry.status, JSON.stringify(await responseJson(retry))).toBe(201);
		const retried = await retry.json();
		sessions.add(retried.id);
	});
});
