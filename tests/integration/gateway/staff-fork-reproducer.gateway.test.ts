import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { test, expect } from "./_helpers/e2e/in-process-harness.js";
import { nonGitCwd, registerProject } from "./_helpers/e2e/e2e-setup.js";
import { copyGitTemplate } from "../../support/harnesses/git-template.js";
import { loadServerTestRuntime } from "../../support/harnesses/server-runtime.js";
import { SandboxSessionFilesystem } from "../../support/harnesses/sandbox-session-filesystem.js";
import { SessionStore } from "../../../src/server/agent/session-store.js";
import { seedSessionTranscript } from "./_helpers/session-fixtures.js";

const FAILURE_MARKER = "STAFF_FORK_IDENTITY_ISOLATION";
const FIXTURE_TIME = "2026-08-11T12:00:00.000Z";

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

async function waitForBarrier(barrier: Deferred, marker: string): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			barrier.promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(marker)), 3_000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function jsonBody(method: string, body: Record<string, unknown>): RequestInit {
	return { method, body: JSON.stringify(body) };
}

async function createStaff(gateway: any, overrides: Record<string, unknown> = {}): Promise<any> {
	const project = gateway.projectContextManager.getRegistry().get(gateway.defaultProjectId);
	const response = await gateway.api("/api/staff", jsonBody("POST", {
		name: `Staff fork ${randomUUID()}`,
		description: "source description",
		systemPrompt: "Remain independent when forked.",
		projectId: project.id,
		cwd: project.rootPath,
		worktree: false,
		...overrides,
	}));
	expect(response.status, await response.clone().text()).toBe(201);
	return response.json();
}

async function forkSession(
	gateway: any,
	sessionId: string,
	body: Record<string, unknown>,
): Promise<{ response: Response; value: any }> {
	const response = await gateway.api(`/api/sessions/${sessionId}/fork`, jsonBody("POST", body));
	return {
		response,
		value: await response.clone().json().catch(async () => ({ error: await response.clone().text() })),
	};
}

async function listStaff(gateway: any, projectId?: string): Promise<any[]> {
	const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
	return (await gateway.apiJson(`/api/staff${suffix}`)).staff;
}

async function inbox(gateway: any, staffId: string): Promise<any[]> {
	return (await gateway.apiJson(`/api/staff/${staffId}/inbox`)).entries;
}

async function deleteStaff(gateway: any, staffId: string): Promise<Response> {
	return gateway.api(`/api/staff/${staffId}`, { method: "DELETE" });
}

function sourceSnapshot(staff: any): Record<string, unknown> {
	return {
		id: staff.id,
		name: staff.name,
		description: staff.description,
		systemPrompt: staff.systemPrompt,
		cwd: staff.cwd,
		state: staff.state,
		triggers: staff.triggers,
		memory: staff.memory,
		roleId: staff.roleId,
		accessory: staff.accessory,
		currentSessionId: staff.currentSessionId,
		projectId: staff.projectId,
		sandboxed: staff.sandboxed,
		contextPolicy: staff.contextPolicy,
	};
}

function durableSessionSnapshot(session: any): Record<string, unknown> {
	return {
		id: session.id,
		title: session.title,
		projectId: session.projectId,
		staffId: session.staffId,
		cwd: session.cwd,
		sandboxed: session.sandboxed,
		borrowsWorktree: session.borrowsWorktree,
		borrowedWorktreeOwnerSessionId: session.borrowedWorktreeOwnerSessionId,
		worktreePath: session.worktreePath,
		repoPath: session.repoPath,
		branch: session.branch,
		archived: session.archived,
		role: session.role,
		accessory: session.accessory,
		allowedTools: session.allowedTools,
		taskId: session.taskId,
		reattemptGoalId: session.reattemptGoalId,
	};
}

function triggerWithoutId(trigger: any): Record<string, unknown> {
	const { id: _id, ...rest } = trigger;
	return rest;
}

function statePath(gateway: any, kind: string, sessionId: string, extension = ""): string {
	return path.join(gateway.bobbitDir, "state", kind, `${sessionId}${extension}`);
}

function installSandboxSessionFilesystem(
	gateway: any,
	label: string,
	removed: string[] = [],
): { filesystem: SandboxSessionFilesystem; restore: () => void; root: string } {
	const sandboxManager = gateway.sessionManager.sandboxManager;
	if (!sandboxManager || typeof sandboxManager.get !== "function") {
		throw new Error("staff fork fixture requires the production SandboxManager");
	}
	const originalGet = sandboxManager.get;
	const root = path.join(gateway.bobbitDir, `staff-fork-sandbox-fs-${label}-${randomUUID()}`);
	const filesystem = new SandboxSessionFilesystem({
		root,
		hostAgentSessionsDir: agentSessionsDir,
		removeWorktree: name => { removed.push(name); },
	});
	sandboxManager.get = () => filesystem;
	return {
		filesystem,
		root,
		restore: () => { sandboxManager.get = originalGet; },
	};
}

function configureSandboxStaffOwner(
	gateway: any,
	staff: any,
	label: string,
): { root: string; cwd: string; branch: string } {
	const sessionId = staff.currentSessionId;
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	const live = gateway.sessionManager.getSession(sessionId);
	if (!persisted?.projectId || !live) throw new Error(`session ${sessionId} must be live and persisted`);
	const branch = `session/${label}-${randomUUID()}`;
	const root = `/workspace-wt/${branch}`;
	const cwd = `${root}/packages/web`;
	const patch = {
		cwd,
		worktreePath: root,
		repoPath: "/workspace",
		branch,
		sandboxed: true,
	};
	gateway.sessionManager.getSessionStore(persisted.projectId).update(sessionId, patch);
	Object.assign(live, patch);
	gateway.projectContextManager.getOrCreate(persisted.projectId).staffStore.update(staff.id, {
		sandboxed: true,
		worktreePath: root,
		repoPath: "/workspace",
		branch,
	});
	return { root, cwd, branch };
}

function setPersistedTranscriptPath(gateway: any, sessionId: string, file: string): void {
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	const live = gateway.sessionManager.getSession(sessionId);
	if (!persisted?.projectId || !live) throw new Error(`session ${sessionId} must be live and persisted`);
	live.agentSessionFile = file;
	gateway.sessionManager.getSessionStore(persisted.projectId).update(sessionId, { agentSessionFile: file });
}

function lifecycleMethod(manager: any): { name: string; fn: (...args: any[]) => Promise<any> } {
	const name = typeof manager.withWorktreeOwnerLifecycle === "function"
		? "withWorktreeOwnerLifecycle"
		: "withSandboxWorktreeOwnerLifecycle";
	const fn = manager[name];
	if (typeof fn !== "function") throw new Error("worktree owner lifecycle fixture is unavailable");
	return { name, fn };
}

async function cleanupHostOwnerFixture(gateway: any, staff: any, projectId: string): Promise<void> {
	if (!staff?.worktreePath || !fs.existsSync(staff.worktreePath)) return;
	const manager = gateway.sessionManager as any;
	try {
		await manager.staffRecordSource.cleanupStaffWorktree(staff, projectId, manager.listSessions());
	} catch { /* isolated fixture root removal below is the final fallback */ }
	if (fs.existsSync(staff.worktreePath)) fs.rmSync(staff.worktreePath, { recursive: true, force: true });
	const worktreeRoot = path.dirname(staff.worktreePath);
	try {
		if (fs.existsSync(worktreeRoot) && fs.readdirSync(worktreeRoot).length === 0) fs.rmdirSync(worktreeRoot);
	} catch { /* the isolated run-root owner performs the final safety sweep */ }
}

async function assertSandboxWholeStaffFork(
	gateway: any,
	realm: "canonical-container" | "legacy-host",
): Promise<void> {
	const source = await createStaff(gateway, { name: `Sandbox whole fork ${realm}` });
	const manager = gateway.sessionManager as any;
	const staffManager = manager.staffRecordSource as any;
	const sandboxFixture = installSandboxSessionFilesystem(gateway, realm);
	const originalApplySandboxWiring = manager.applySandboxWiring;
	const originalCreateSession = manager.createSession;
	const originalSendCommand = rpcBridgeModule.RpcBridge.prototype.sendCommand;
	let destination: any;
	let capturedOptions: any;
	try {
		configureSandboxStaffOwner(gateway, source, realm);
		const seededHostPath = seedSessionTranscript(gateway, source.currentSessionId, [
			{ role: "user", text: `SANDBOX_WHOLE_${realm}_USER` },
			{ role: "assistant", text: `SANDBOX_WHOLE_${realm}_ASSISTANT` },
		]);
		const seededContent = fs.readFileSync(seededHostPath, "utf8");
		const sourcePath = realm === "canonical-container"
			? `/home/node/.bobbit/agent/sessions/--staff-fork-${realm}--/${source.currentSessionId}.jsonl`
			: seededHostPath;
		if (realm === "canonical-container") {
			const containerHostPath = sandboxFixture.filesystem.hostPath(sourcePath);
			fs.mkdirSync(path.dirname(containerHostPath), { recursive: true });
			fs.writeFileSync(containerHostPath, seededContent, "utf8");
			setPersistedTranscriptPath(gateway, source.currentSessionId, sourcePath);
		}
		const sourceBytes = realm === "canonical-container"
			? fs.readFileSync(sandboxFixture.filesystem.hostPath(sourcePath))
			: fs.readFileSync(sourcePath);
		const sourceBefore = structuredClone(await gateway.apiJson(`/api/staff/${source.id}`));

		manager.applySandboxWiring = async (options: any) => {
			options.cwd = nonGitCwd();
			delete options.containerId;
			return true;
		};
		manager.createSession = async (...args: any[]) => {
			capturedOptions = structuredClone(args[4]);
			return originalCreateSession.apply(manager, args);
		};
		rpcBridgeModule.RpcBridge.prototype.sendCommand = function(command: any, ...rest: any[]) {
			if (command?.type === "switch_session" && typeof command.sessionPath === "string") {
				command = {
					...command,
					sessionPath: sandboxFixture.filesystem.hostPath(command.sessionPath),
				};
			}
			return originalSendCommand.call(this, command, ...rest);
		};

		const fork = await forkSession(gateway, source.currentSessionId, { newWorktree: false });
		expect(fork.response.status, JSON.stringify(fork.value)).toBe(201);
		destination = (await listStaff(gateway)).find((staff: any) => staff.currentSessionId === fork.value.id);
		expect(destination).toBeTruthy();
		const persisted = manager.getPersistedSession(fork.value.id);
		expect(destination.id).not.toBe(source.id);
		expect(persisted).toMatchObject({
			staffId: destination.id,
			sandboxed: true,
			borrowsWorktree: true,
			borrowedWorktreeOwnerSessionId: source.currentSessionId,
		});
		expect(capturedOptions).toMatchObject({
			staffId: destination.id,
			sandboxed: true,
			borrowedWorktreeOwnerSessionId: source.currentSessionId,
			env: { BOBBIT_STAFF_ID: destination.id },
		});
		expect(manager.getSession(fork.value.id)?.staffId).toBe(destination.id);
		expect(destination.sandboxed).toBe(true);
		if (realm === "canonical-container") {
			expect(capturedOptions.preExistingAgentSessionFile).toMatch(/^\/home\/node\/\.bobbit\/agent\/sessions\//);
			expect(persisted.agentSessionFile).toMatch(/^\/home\/node\/\.bobbit\/agent\/sessions\//);
		} else {
			expect(path.isAbsolute(capturedOptions.preExistingAgentSessionFile)).toBe(true);
			expect(capturedOptions.preExistingAgentSessionFile).not.toMatch(/^\/home\/node\/\.bobbit\/agent\/sessions\//);
		}
		const destinationTranscript = persisted.agentSessionFile.startsWith("/home/node/.bobbit/agent/sessions/")
			? fs.readFileSync(sandboxFixture.filesystem.hostPath(persisted.agentSessionFile), "utf8")
			: fs.readFileSync(persisted.agentSessionFile, "utf8");
		expect(destinationTranscript).toContain(`SANDBOX_WHOLE_${realm}_USER`);
		expect(destinationTranscript).toContain(`SANDBOX_WHOLE_${realm}_ASSISTANT`);
		expect(await gateway.apiJson(`/api/staff/${source.id}`)).toEqual(sourceBefore);
		const sourceAfter = realm === "canonical-container"
			? fs.readFileSync(sandboxFixture.filesystem.hostPath(sourcePath))
			: fs.readFileSync(sourcePath);
		expect(sourceAfter.equals(sourceBytes)).toBe(true);
	} finally {
		manager.applySandboxWiring = originalApplySandboxWiring;
		manager.createSession = originalCreateSession;
		rpcBridgeModule.RpcBridge.prototype.sendCommand = originalSendCommand;
		if (destination?.id) await deleteStaff(gateway, destination.id).catch(() => undefined);
		if (staffManager.getStaff(source.id)) await deleteStaff(gateway, source.id).catch(() => undefined);
		sandboxFixture.restore();
		fs.rmSync(sandboxFixture.root, { recursive: true, force: true });
	}
}

function seedHistoryTranscript(gateway: any, sessionId: string): string {
	const persisted = gateway.sessionManager.getPersistedSession(sessionId);
	const live = gateway.sessionManager.getSession(sessionId);
	if (!persisted?.projectId || !live) throw new Error(`session ${sessionId} must be live and persisted`);
	const entries = [
		{
			type: "session",
			version: 3,
			id: `pi-${sessionId}`,
			timestamp: FIXTURE_TIME,
			cwd: live.cwd,
			provider: "fixture-provider",
		},
		{
			type: "message",
			id: "retained-user",
			parentId: null,
			timestamp: FIXTURE_TIME,
			message: { role: "user", content: [{ type: "text", text: "RETAINED_STAFF_HISTORY" }] },
		},
		{
			type: "message",
			id: "retained-assistant",
			parentId: "retained-user",
			timestamp: FIXTURE_TIME,
			message: { role: "assistant", content: [{ type: "text", text: "RETAINED_STAFF_ANSWER" }] },
		},
		{
			type: "message",
			id: "cut-user",
			parentId: "retained-assistant",
			timestamp: FIXTURE_TIME,
			message: { role: "user", content: [{ type: "text", text: "CUT_STAFF_PROMPT" }] },
		},
		{
			type: "message",
			id: "discarded-assistant",
			parentId: "cut-user",
			timestamp: FIXTURE_TIME,
			message: { role: "assistant", content: [{ type: "text", text: "DISCARDED_STAFF_HISTORY" }] },
		},
	];
	const file = path.join(gateway.bobbitDir, "state", "session-prompts", `${sessionId}-staff-history-fork.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`, "utf8");
	live.agentSessionFile = file;
	gateway.sessionManager.getSessionStore(persisted.projectId).update(sessionId, { agentSessionFile: file });
	return file;
}

let baselineStaffIds = new Set<string>();
let rpcBridgeModule: any;
let agentSessionsDir = "";

test.describe.serial("staff session fork identity", () => {
	test.beforeAll(async () => {
		const runtime = await loadServerTestRuntime();
		rpcBridgeModule = runtime.rpcBridge;
		agentSessionsDir = path.join(runtime.bobbitDir.globalAgentDir(), "sessions");
	});

	test.beforeEach(async ({ gateway }) => {
		baselineStaffIds = new Set((await listStaff(gateway)).map((staff: any) => staff.id));
	});

	test.afterEach(async ({ gateway }) => {
		const extras = (await listStaff(gateway)).filter((staff: any) => !baselineStaffIds.has(staff.id));
		// Borrowers/forks must be released before their source owners.
		extras.sort((a: any, b: any) => Number(b.name?.startsWith("Fork: ")) - Number(a.name?.startsWith("Fork: ")));
		for (const staff of extras) await deleteStaff(gateway, staff.id).catch(() => undefined);
	});

	test("clones a staff configuration snapshot, transcript and runtime authority without sharing inbox or trigger state", async ({ gateway }) => {
		const project = gateway.projectContextManager.getRegistry().get(gateway.defaultProjectId);
		const roleId = ["tester", "reviewer", "coder"].find(id => gateway.sessionManager.getRoleManager?.()?.getRole?.(id));
		expect(roleId, "the integration project must expose a built-in role fixture").toBeTruthy();

		const source = await createStaff(gateway, {
			name: "Configuration source",
			roleId,
			accessory: "magnifier",
			triggers: [
				{
					id: "source-git-trigger",
					type: "git",
					config: { event: "push", branch: "main", repo: "." },
					enabled: true,
					prompt: "Inspect changes.",
					lastFired: 1_700_000_000_000,
					lastSeenSha: "source-sha",
				},
			],
		});
		const updated = await gateway.api(`/api/staff/${source.id}`, jsonBody("PUT", {
			description: "configuration snapshot description",
			systemPrompt: "CONFIGURATION_SNAPSHOT_PROMPT",
			state: "paused",
			memory: "CONFIGURATION_SNAPSHOT_MEMORY",
			contextPolicy: "preserve",
			roleId,
			accessory: "magnifier",
			triggers: source.triggers,
		}));
		expect(updated.status, await updated.clone().text()).toBe(200);
		const sourceBefore = structuredClone(await updated.json());
		seedSessionTranscript(gateway, source.currentSessionId, [
			{ role: "user", text: "WHOLE_STAFF_FORK_USER" },
			{ role: "assistant", text: "WHOLE_STAFF_FORK_ASSISTANT" },
		]);
		await gateway.apiJson(`/api/staff/${source.id}/inbox`, jsonBody("POST", {
			title: "source only",
			prompt: "Do not copy this entry.",
		}));

		const manager = gateway.sessionManager as any;
		const originalCreateSession = manager.createSession;
		let capturedOptions: any;
		manager.createSession = async (...args: any[]) => {
			capturedOptions = structuredClone(args[4]);
			return originalCreateSession.apply(manager, args);
		};
		let result: { response: Response; value: any };
		try {
			result = await forkSession(gateway, source.currentSessionId, { newWorktree: false });
		} finally {
			manager.createSession = originalCreateSession;
		}
		expect(result.response.status, JSON.stringify(result.value)).toBe(201);

		const forkSessionRecord = gateway.sessionManager.getPersistedSession(result.value.id);
		const destination = (await listStaff(gateway, project.id)).find((staff: any) => staff.currentSessionId === result.value.id);
		expect(destination?.id, `${FAILURE_MARKER}: fork session must be owned by a persisted staff record`).toBe(forkSessionRecord.staffId);
		expect(destination.id, `${FAILURE_MARKER}: a staff fork must not reuse its source staffId`).not.toBe(source.id);
		expect(destination.name).toBe(`Fork: ${sourceBefore.name}`);
		expect(destination.currentSessionId).toBe(result.value.id);
		expect(capturedOptions.staffId).toBe(destination.id);
		expect(capturedOptions.env?.BOBBIT_STAFF_ID).toBe(destination.id);
		expect(gateway.sessionManager.getSession(result.value.id)?.staffId).toBe(destination.id);

		expect(sourceSnapshot(destination)).toMatchObject({
			name: `Fork: ${sourceBefore.name}`,
			description: sourceBefore.description,
			systemPrompt: sourceBefore.systemPrompt,
			cwd: sourceBefore.cwd,
			state: sourceBefore.state,
			memory: sourceBefore.memory,
			roleId: sourceBefore.roleId,
			accessory: sourceBefore.accessory,
			projectId: sourceBefore.projectId,
			sandboxed: sourceBefore.sandboxed,
			contextPolicy: sourceBefore.contextPolicy,
		});
		expect(destination.triggers).toHaveLength(sourceBefore.triggers.length);
		expect(destination.triggers[0].id).not.toBe(sourceBefore.triggers[0].id);
		expect(triggerWithoutId(destination.triggers[0])).toEqual(triggerWithoutId(sourceBefore.triggers[0]));
		expect(destination.triggers).not.toBe(sourceBefore.triggers);
		expect(destination.triggers[0].config).not.toBe(sourceBefore.triggers[0].config);

		const forkTranscript = fs.readFileSync(forkSessionRecord.agentSessionFile, "utf8");
		expect(forkTranscript).toContain("WHOLE_STAFF_FORK_USER");
		expect(forkTranscript).toContain("WHOLE_STAFF_FORK_ASSISTANT");
		expect(await inbox(gateway, source.id)).toHaveLength(1);
		expect(await inbox(gateway, destination.id)).toEqual([]);

		const mutatedTriggers = structuredClone(destination.triggers);
		mutatedTriggers[0].config.branch = "destination-only";
		mutatedTriggers[0].lastFired = 1_800_000_000_000;
		mutatedTriggers[0].lastSeenSha = "destination-sha";
		const destinationUpdate = await gateway.api(`/api/staff/${destination.id}`, jsonBody("PUT", {
			description: "destination-only description",
			memory: "destination-only memory",
			triggers: mutatedTriggers,
		}));
		expect(destinationUpdate.status, await destinationUpdate.clone().text()).toBe(200);
		await gateway.apiJson(`/api/staff/${destination.id}/inbox`, jsonBody("POST", {
			title: "destination only",
			prompt: "Only the fork may see this.",
		}));

		expect(sourceSnapshot(await gateway.apiJson(`/api/staff/${source.id}`))).toEqual(sourceSnapshot(sourceBefore));
		expect((await inbox(gateway, source.id)).map(entry => entry.title)).toEqual(["source only"]);
		expect((await inbox(gateway, destination.id)).map(entry => entry.title)).toEqual(["destination only"]);
	});

	test("preserves cut-before-prompt history and binds colliding fork names by ID", async ({ gateway }) => {
		const collisionName = `Collision ${randomUUID()}`;
		const source = await createStaff(gateway, { name: collisionName });
		const decoy = await createStaff(gateway, {
			name: `Fork: ${collisionName}`,
			description: "same-name decoy",
			systemPrompt: "DECOY_PROMPT",
		});
		seedHistoryTranscript(gateway, source.currentSessionId);

		const result = await forkSession(gateway, source.currentSessionId, {
			entryId: "cut-user",
			newWorktree: false,
		});
		expect(result.response.status, JSON.stringify(result.value)).toBe(201);
		const persisted = gateway.sessionManager.getPersistedSession(result.value.id);
		const owners = (await listStaff(gateway)).filter((staff: any) => staff.currentSessionId === result.value.id);
		expect(owners).toHaveLength(1);
		expect(owners[0].id).toBe(persisted.staffId);
		expect(owners[0].id).not.toBe(source.id);
		expect(owners[0].id).not.toBe(decoy.id);
		expect(owners[0].name).toBe(decoy.name);
		expect(decoy.currentSessionId).not.toBe(result.value.id);
		expect(decoy.systemPrompt).toBe("DECOY_PROMPT");

		const transcript = fs.readFileSync(persisted.agentSessionFile, "utf8");
		expect(transcript).toContain("RETAINED_STAFF_HISTORY");
		expect(transcript).toContain("RETAINED_STAFF_ANSWER");
		expect(transcript).not.toContain("CUT_STAFF_PROMPT");
		expect(transcript).not.toContain("DISCARDED_STAFF_HISTORY");
	});

	test("rejects host source-first deletion before mutation, then cleans the owner once after borrower deletion", async ({ gateway }) => {
		const root = path.join(gateway.bobbitDir, `staff-fork-host-source-first-${randomUUID()}`);
		copyGitTemplate(root);
		const project = await registerProject({
			name: `staff-fork-host-source-first-${randomUUID()}`,
			rootPath: root,
			seedWorkflows: false,
		});
		let source: any;
		let destination: any;
		const staffManager = (gateway.sessionManager as any).staffRecordSource;
		const originalCleanup = staffManager.cleanupStaffWorktree;
		let sourceCleanupCalls = 0;
		try {
			source = await createStaff(gateway, {
				name: "Host source-first owner",
				projectId: project.id,
				cwd: root,
				worktree: true,
			});
			seedSessionTranscript(gateway, source.currentSessionId, [
				{ role: "user", text: "HOST_SOURCE_FIRST_HISTORY" },
			]);
			await gateway.apiJson(`/api/staff/${source.id}/inbox`, jsonBody("POST", {
				title: "source retained",
				prompt: "The rejected delete must preserve this.",
			}));
			const fork = await forkSession(gateway, source.currentSessionId, { newWorktree: false });
			expect(fork.response.status, JSON.stringify(fork.value)).toBe(201);
			destination = (await listStaff(gateway, project.id)).find((staff: any) => staff.currentSessionId === fork.value.id);
			expect(destination).toBeTruthy();
			await gateway.apiJson(`/api/staff/${destination.id}/inbox`, jsonBody("POST", {
				title: "destination retained",
				prompt: "This borrower remains independent.",
			}));

			const sourceWorktree = source.worktreePath;
			const sourceStaffBefore = structuredClone(await gateway.apiJson(`/api/staff/${source.id}`));
			const destinationStaffBefore = structuredClone(await gateway.apiJson(`/api/staff/${destination.id}`));
			const sourceSessionBefore = structuredClone(gateway.sessionManager.getPersistedSession(source.currentSessionId));
			const destinationSessionBefore = structuredClone(gateway.sessionManager.getPersistedSession(fork.value.id));
			expect(destinationSessionBefore).toMatchObject({
				borrowsWorktree: true,
				borrowedWorktreeOwnerSessionId: source.currentSessionId,
				cwd: sourceSessionBefore.cwd,
			});
			expect(fs.existsSync(sourceWorktree)).toBe(true);

			staffManager.cleanupStaffWorktree = async (staff: any, ...args: any[]) => {
				if (staff.id === source.id) sourceCleanupCalls++;
				return originalCleanup.call(staffManager, staff, ...args);
			};
			const rejected = await deleteStaff(gateway, source.id);
			expect(rejected.status, await rejected.clone().text()).toBe(409);
			expect((await rejected.json()).code).toMatch(/^SHARED_(?:HOST_)?WORKTREE_IN_USE$/);
			expect(sourceCleanupCalls).toBe(0);
			expect(sourceSnapshot(
				await gateway.apiJson(`/api/staff/${source.id}`),
			)).toEqual(sourceSnapshot(sourceStaffBefore));
			expect(sourceSnapshot(
				await gateway.apiJson(`/api/staff/${destination.id}`),
			)).toEqual(sourceSnapshot(destinationStaffBefore));
			const sourceSessionAfter = gateway.sessionManager.getPersistedSession(source.currentSessionId);
			const destinationSessionAfter = gateway.sessionManager.getPersistedSession(fork.value.id);
			expect(durableSessionSnapshot(sourceSessionAfter)).toEqual(durableSessionSnapshot(sourceSessionBefore));
			expect(durableSessionSnapshot(destinationSessionAfter)).toEqual(durableSessionSnapshot(destinationSessionBefore));
			expect(gateway.sessionManager.getSession(source.currentSessionId)).toBeTruthy();
			expect(gateway.sessionManager.getSession(fork.value.id)).toBeTruthy();
			expect((await inbox(gateway, source.id)).map(entry => entry.title)).toEqual(["source retained"]);
			expect((await inbox(gateway, destination.id)).map(entry => entry.title)).toEqual(["destination retained"]);
			expect(fs.existsSync(sourceWorktree)).toBe(true);

			expect((await deleteStaff(gateway, destination.id)).status).toBe(200);
			destination = undefined;
			expect(fs.existsSync(sourceWorktree)).toBe(true);
			expect((await deleteStaff(gateway, source.id)).status).toBe(200);
			source = undefined;
			expect(sourceCleanupCalls).toBe(1);
			expect(fs.existsSync(sourceWorktree)).toBe(false);
		} finally {
			staffManager.cleanupStaffWorktree = originalCleanup;
			if (destination?.id) await deleteStaff(gateway, destination.id).catch(() => undefined);
			if (source?.id) await deleteStaff(gateway, source.id).catch(() => undefined);
			await cleanupHostOwnerFixture(gateway, source, project.id);
			await gateway.api(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => undefined);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("serializes host fork-first publication before source deletion and persists flattened ownership", async ({ gateway }) => {
		const root = path.join(gateway.bobbitDir, `staff-fork-host-fork-wins-${randomUUID()}`);
		copyGitTemplate(root);
		const project = await registerProject({
			name: `staff-fork-host-fork-wins-${randomUUID()}`,
			rootPath: root,
			seedWorkflows: false,
		});
		let source: any;
		let destination: any;
		let forkPromise: Promise<{ response: Response; value: any }> | undefined;
		let deletePromise: Promise<Response> | undefined;
		const manager = gateway.sessionManager as any;
		const staffManager = manager.staffRecordSource as any;
		const originalCreateSession = manager.createSession;
		const lifecycle = lifecycleMethod(manager);
		const createEntered = deferred<void>();
		const releaseCreate = deferred<void>();
		const deleteQueued = deferred<void>();
		let lifecycleCalls = 0;
		try {
			source = await createStaff(gateway, {
				name: "Host fork-first owner",
				projectId: project.id,
				cwd: root,
				worktree: true,
			});
			seedSessionTranscript(gateway, source.currentSessionId, [
				{ role: "user", text: "HOST_FORK_FIRST_HISTORY" },
			]);
			const sourceWorktree = source.worktreePath;
			manager[lifecycle.name] = function(ownerId: string, operation: () => Promise<unknown>) {
				if (ownerId === source.currentSessionId && ++lifecycleCalls === 2) deleteQueued.resolve();
				return lifecycle.fn.call(this, ownerId, operation);
			};
			manager.createSession = async (...args: any[]) => {
				createEntered.resolve();
				await releaseCreate.promise;
				return originalCreateSession.apply(manager, args);
			};

			forkPromise = forkSession(gateway, source.currentSessionId, { newWorktree: false });
			await waitForBarrier(createEntered, "HOST_STAFF_FORK_DID_NOT_ENTER_PUBLICATION");
			deletePromise = deleteStaff(gateway, source.id);
			await waitForBarrier(deleteQueued, "HOST_STAFF_FORK_LIFECYCLE_NOT_SERIALIZED");
			expect(lifecycleCalls).toBe(2);
			expect(gateway.sessionManager.getSession(source.currentSessionId)).toBeTruthy();

			releaseCreate.resolve();
			const fork = await forkPromise;
			expect(fork.response.status, JSON.stringify(fork.value)).toBe(201);
			destination = (await listStaff(gateway, project.id)).find((staff: any) => staff.currentSessionId === fork.value.id);
			expect(destination).toBeTruthy();
			const rejected = await deletePromise;
			expect(rejected.status, await rejected.clone().text()).toBe(409);

			const persisted = gateway.sessionManager.getPersistedSession(fork.value.id);
			expect(persisted).toMatchObject({
				staffId: destination.id,
				borrowsWorktree: true,
				borrowedWorktreeOwnerSessionId: source.currentSessionId,
			});
			expect(persisted.worktreePath).toBeUndefined();
			expect(fs.existsSync(sourceWorktree)).toBe(true);
			expect(staffManager.getStaff(source.id)).toBeTruthy();
			expect(staffManager.getStaff(destination.id)).toBeTruthy();

			const store = gateway.sessionManager.getSessionStore(project.id);
			await store.flushAsync();
			const reloaded = new SessionStore((store as any).storeDir);
			expect(reloaded.get(fork.value.id)).toMatchObject({
				staffId: destination.id,
				borrowsWorktree: true,
				borrowedWorktreeOwnerSessionId: source.currentSessionId,
			});
		} finally {
			releaseCreate.resolve();
			await Promise.allSettled([forkPromise, deletePromise].filter(Boolean) as Promise<unknown>[]);
			manager.createSession = originalCreateSession;
			manager[lifecycle.name] = lifecycle.fn;
			if (destination?.id) await deleteStaff(gateway, destination.id).catch(() => undefined);
			if (source?.id) await deleteStaff(gateway, source.id).catch(() => undefined);
			await cleanupHostOwnerFixture(gateway, source, project.id);
			await gateway.api(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => undefined);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("fails a host fork closed when source deletion wins the ownership lifecycle race", async ({ gateway }) => {
		const root = path.join(gateway.bobbitDir, `staff-fork-host-delete-wins-${randomUUID()}`);
		copyGitTemplate(root);
		const project = await registerProject({
			name: `staff-fork-host-delete-wins-${randomUUID()}`,
			rootPath: root,
			seedWorkflows: false,
		});
		let source: any;
		let forkPromise: Promise<{ response: Response; value: any }> | undefined;
		let deletePromise: Promise<Response> | undefined;
		const manager = gateway.sessionManager as any;
		const lifecycle = lifecycleMethod(manager);
		const deleteEntered = deferred<void>();
		const releaseDelete = deferred<void>();
		const forkQueued = deferred<void>();
		let lifecycleCalls = 0;
		let copiedDestination: string | undefined;
		const originalCopyFileSync = fs.copyFileSync;
		let originalGetState: any;
		try {
			source = await createStaff(gateway, {
				name: "Host delete-first owner",
				projectId: project.id,
				cwd: root,
				worktree: true,
			});
			const sourceTranscript = seedSessionTranscript(gateway, source.currentSessionId, [
				{ role: "user", text: "HOST_DELETE_FIRST_HISTORY" },
			]);
			const sourceSession = manager.getSession(source.currentSessionId);
			const sourceStaffId = source.id;
			const sourceWorktree = source.worktreePath;
			const staffIdsBefore = new Set((await listStaff(gateway, project.id)).map((staff: any) => staff.id));
			const sessionIdsBefore = new Set(manager.getSessionStore(project.id).getAll().map((session: any) => session.id));
			originalGetState = sourceSession.rpcClient.getState;
			sourceSession.rpcClient.getState = async () => {
				deleteEntered.resolve();
				await releaseDelete.promise;
				return { success: true, data: {} };
			};
			manager[lifecycle.name] = function(ownerId: string, operation: () => Promise<unknown>) {
				if (ownerId === source.currentSessionId && ++lifecycleCalls === 2) forkQueued.resolve();
				return lifecycle.fn.call(this, ownerId, operation);
			};
			fs.copyFileSync = ((sourcePath: fs.PathLike, destinationPath: fs.PathLike, mode?: number) => {
				if (String(sourcePath) === sourceTranscript) copiedDestination = String(destinationPath);
				return originalCopyFileSync(sourcePath, destinationPath, mode);
			}) as typeof fs.copyFileSync;

			deletePromise = deleteStaff(gateway, source.id);
			await waitForBarrier(deleteEntered, "HOST_STAFF_DELETE_DID_NOT_ENTER_LIFECYCLE");
			forkPromise = forkSession(gateway, source.currentSessionId, { newWorktree: false });
			await waitForBarrier(forkQueued, "HOST_STAFF_DELETE_FIRST_RACE_NOT_SERIALIZED");
			expect(lifecycleCalls).toBe(2);

			releaseDelete.resolve();
			const deleted = await deletePromise;
			expect(deleted.status, await deleted.clone().text()).toBe(200);
			source = undefined;
			const fork = await forkPromise;
			expect(fork.response.status, JSON.stringify(fork.value)).toBe(422);
			expect(fork.value).toMatchObject({ code: "HISTORY_FORK_SOURCE_UNAVAILABLE" });
			expect(fs.existsSync(sourceWorktree)).toBe(false);
			expect(new Set((await listStaff(gateway, project.id)).map((staff: any) => staff.id))).toEqual(new Set([...staffIdsBefore].filter(id => id !== sourceStaffId)));
			expect(manager.getSessionStore(project.id).getAll().filter((session: any) => !session.archived && !sessionIdsBefore.has(session.id))).toEqual([]);
			if (copiedDestination) expect(fs.existsSync(copiedDestination)).toBe(false);
			const destinationId = copiedDestination?.match(/_([0-9a-f-]{36})\.jsonl$/i)?.[1];
			if (destinationId) {
				expect(manager.getSession(destinationId)).toBeUndefined();
				expect(manager.getPersistedSession(destinationId)).toBeUndefined();
				expect(fs.existsSync(statePath(gateway, "skill-sidecar", destinationId, ".jsonl"))).toBe(false);
				expect(fs.existsSync(statePath(gateway, "compaction-sidecar", destinationId, ".jsonl"))).toBe(false);
				expect(fs.existsSync(statePath(gateway, "proposal-drafts", destinationId))).toBe(false);
				expect(fs.existsSync(statePath(gateway, "tool-content", destinationId))).toBe(false);
			}
		} finally {
			releaseDelete.resolve();
			await Promise.allSettled([forkPromise, deletePromise].filter(Boolean) as Promise<unknown>[]);
			fs.copyFileSync = originalCopyFileSync;
			manager[lifecycle.name] = lifecycle.fn;
			if (source?.currentSessionId && originalGetState) {
				const live = manager.getSession(source.currentSessionId);
				if (live) live.rpcClient.getState = originalGetState;
			}
			if (source?.id) await deleteStaff(gateway, source.id).catch(() => undefined);
			await cleanupHostOwnerFixture(gateway, source, project.id);
			await gateway.api(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => undefined);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("borrowed-worktree mode persists destination-only borrower provenance and cleanup", async ({ gateway }) => {
		const source = await createStaff(gateway, { name: "Borrowed worktree source", worktree: false });
		seedSessionTranscript(gateway, source.currentSessionId);
		const sourceSessionBefore = structuredClone(gateway.sessionManager.getPersistedSession(source.currentSessionId));

		const result = await forkSession(gateway, source.currentSessionId, { newWorktree: false });
		expect(result.response.status, JSON.stringify(result.value)).toBe(201);
		const destination = (await listStaff(gateway)).find((staff: any) => staff.currentSessionId === result.value.id);
		const forkPersisted = gateway.sessionManager.getPersistedSession(result.value.id);
		expect(forkPersisted).toMatchObject({
			staffId: destination.id,
			cwd: sourceSessionBefore.cwd,
			borrowsWorktree: true,
			borrowedWorktreeOwnerSessionId: source.currentSessionId,
		});
		expect(forkPersisted.worktreePath).toBeUndefined();
		expect(forkPersisted.branch).toBeUndefined();
		expect(forkPersisted.repoPath).toBeUndefined();
		expect(forkPersisted.repoWorktrees).toBeUndefined();

		const deleted = await deleteStaff(gateway, destination.id);
		expect(deleted.status, await deleted.clone().text()).toBe(200);
		const staffManager = (gateway.sessionManager as any).staffRecordSource;
		expect(staffManager.getStaff(destination.id)).toBeUndefined();
		expect(gateway.sessionManager.getPersistedSession(result.value.id)?.archived).toBe(true);
		expect(staffManager.getStaff(source.id)).toMatchObject({ currentSessionId: source.currentSessionId });
		expect(gateway.sessionManager.getPersistedSession(source.currentSessionId)?.id).toBe(source.currentSessionId);
		expect(gateway.sessionManager.getPersistedSession(source.currentSessionId)?.archived).not.toBe(true);
	});

	test("new-worktree mode gives source and destination disjoint durable ownership", async ({ gateway }) => {
		const root = path.join(gateway.bobbitDir, `staff-fork-worktree-${randomUUID()}`);
		copyGitTemplate(root);
		const project = await registerProject({
			name: `staff-fork-worktree-${randomUUID()}`,
			rootPath: root,
			seedWorkflows: false,
		});
		let source: any;
		let destination: any;
		try {
			source = await createStaff(gateway, {
				name: "Owned worktree source",
				projectId: project.id,
				cwd: root,
				worktree: true,
			});
			seedSessionTranscript(gateway, source.currentSessionId);
			const result = await forkSession(gateway, source.currentSessionId, { newWorktree: true });
			expect(result.response.status, JSON.stringify(result.value)).toBe(201);
			destination = (await listStaff(gateway, project.id)).find((staff: any) => staff.currentSessionId === result.value.id);
			const sourcePersisted = gateway.sessionManager.getPersistedSession(source.currentSessionId);
			const destinationPersisted = gateway.sessionManager.getPersistedSession(result.value.id);

			expect(destinationPersisted.staffId).toBe(destination.id);
			expect(destinationPersisted.borrowsWorktree).not.toBe(true);
			expect(destinationPersisted.worktreePath).toBeTruthy();
			expect(destinationPersisted.branch).toMatch(/^session\//);
			expect(destinationPersisted.worktreePath).not.toBe(sourcePersisted.worktreePath);
			expect(destinationPersisted.branch).not.toBe(sourcePersisted.branch);
			expect(fs.existsSync(destinationPersisted.worktreePath)).toBe(true);
			expect(fs.existsSync(sourcePersisted.worktreePath)).toBe(true);

			const destinationWorktree = destinationPersisted.worktreePath;
			const sourceWorktree = sourcePersisted.worktreePath;
			expect((await deleteStaff(gateway, destination.id)).status).toBe(200);
			destination = undefined;
			expect(fs.existsSync(destinationWorktree)).toBe(false);
			expect(fs.existsSync(sourceWorktree)).toBe(true);
			expect((gateway.sessionManager as any).staffRecordSource.getStaff(source.id)).toBeTruthy();
		} finally {
			if (destination?.id) await deleteStaff(gateway, destination.id).catch(() => undefined);
			if (source?.id) await deleteStaff(gateway, source.id).catch(() => undefined);
			await gateway.api(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => undefined);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("whole-session sandbox staff fork keeps a canonical container transcript in its filesystem realm", async ({ gateway }) => {
		await assertSandboxWholeStaffFork(gateway, "canonical-container");
	});

	test("whole-session sandbox staff fork retains legacy host-absolute transcript compatibility", async ({ gateway }) => {
		await assertSandboxWholeStaffFork(gateway, "legacy-host");
	});

	test("stages a hidden durable staff identity before publishing its destination session, then commits it atomically", async ({ gateway }) => {
		const source = await createStaff(gateway, { name: "Publication ordering source" });
		seedSessionTranscript(gateway, source.currentSessionId);
		const manager = gateway.sessionManager as any;
		const staffManager = manager.staffRecordSource as any;
		const originalPrepare = staffManager.prepareForkedStaff;
		const originalRegister = staffManager.registerForkedStaff;
		let preparedId = "";
		let preparedSessionId = "";
		let observedDurableSession = false;
		staffManager.prepareForkedStaff = (...args: any[]) => {
			const destination = args[1];
			preparedId = destination.id;
			preparedSessionId = destination.sessionId;
			expect(manager.getPersistedSession(preparedSessionId)).toBeUndefined();
			const candidate = originalPrepare.apply(staffManager, args);
			expect(staffManager.getStaff(preparedId), "pending publication must stay off public staff surfaces").toBeUndefined();
			const context = gateway.projectContextManager.getOrCreate(destination.projectId);
			expect(context.staffStore.getIncludingPending(preparedId)?.forkPublication).toEqual({ version: 1, sessionId: preparedSessionId });
			return candidate;
		};
		staffManager.registerForkedStaff = (...args: any[]) => {
			const destination = args[1];
			const context = gateway.projectContextManager.getOrCreate(destination.projectId);
			observedDurableSession = context.sessionStore.get(destination.session.id)?.staffId === preparedId;
			expect(context.staffStore.getIncludingPending(preparedId)?.forkPublication).toEqual({ version: 1, sessionId: preparedSessionId });
			return originalRegister.apply(staffManager, args);
		};

		let result: { response: Response; value: any };
		try {
			result = await forkSession(gateway, source.currentSessionId, { newWorktree: false });
		} finally {
			staffManager.prepareForkedStaff = originalPrepare;
			staffManager.registerForkedStaff = originalRegister;
		}

		expect(result.response.status, JSON.stringify(result.value)).toBe(201);
		expect(result.value.id).toBe(preparedSessionId);
		expect(observedDurableSession).toBe(true);
		expect(staffManager.getStaff(preparedId)).toMatchObject({
			id: preparedId,
			currentSessionId: preparedSessionId,
			projectId: source.projectId,
		});
		expect(staffManager.getStaff(preparedId)?.forkPublication).toBeUndefined();
		const context = gateway.projectContextManager.getOrCreate(source.projectId);
		const durableStaff = JSON.parse(fs.readFileSync((context.staffStore as any).storeFile, "utf8"))
			.find((staff: any) => staff.id === preparedId);
		expect(durableStaff).toMatchObject({
			id: preparedId,
			currentSessionId: preparedSessionId,
			projectId: source.projectId,
		});
		expect(durableStaff.forkPublication, "successful publication must durably clear the hidden marker").toBeUndefined();
		expect((await listStaff(gateway, source.projectId)).find((staff: any) => staff.id === preparedId))
			.toMatchObject({ currentSessionId: preparedSessionId });
	});

	test("reconciles the durable destination identity after a crash between session and staff commits", async ({ gateway }) => {
		const source = await createStaff(gateway, { name: "Crash reconciliation source" });
		const sourceBefore = structuredClone(await gateway.apiJson(`/api/staff/${source.id}`));
		const manager = gateway.sessionManager as any;
		const staffManager = manager.staffRecordSource as any;
		const projectId = source.projectId as string;
		const context = gateway.projectContextManager.getOrCreate(projectId);
		const destinationStaffId = randomUUID();
		const destinationSessionId = randomUUID();
		const destinationName = `Fork: ${source.name}`;
		const now = Date.now();

		staffManager.prepareForkedStaff(sourceBefore, {
			id: destinationStaffId,
			name: destinationName,
			projectId,
			sessionId: destinationSessionId,
		});
		context.sessionStore.put({
			id: destinationSessionId,
			title: destinationName,
			cwd: source.cwd,
			agentSessionFile: "",
			createdAt: now,
			lastActivity: now,
			projectId,
			staffId: destinationStaffId,
			borrowsWorktree: true,
		});
		await context.sessionStore.flushAsync();
		const staffFile = (context.staffStore as any).storeFile as string;
		const durableCandidate = JSON.parse(fs.readFileSync(staffFile, "utf8"))
			.find((staff: any) => staff.id === destinationStaffId);
		expect(durableCandidate?.forkPublication).toEqual({ version: 1, sessionId: destinationSessionId });
		expect(staffManager.getStaff(destinationStaffId)).toBeUndefined();
		expect((await listStaff(gateway, projectId)).some((staff: any) => staff.id === destinationStaffId)).toBe(false);

		try {
			const reconciled = staffManager.reconcileForkedStaffPublications();
			expect(reconciled).toEqual({ committed: [destinationStaffId], aborted: [] });
			const destination = staffManager.getStaff(destinationStaffId);
			expect(destination).toMatchObject({
				id: destinationStaffId,
				name: destinationName,
				currentSessionId: destinationSessionId,
				projectId,
			});
			expect(destination.forkPublication).toBeUndefined();
			expect(await inbox(gateway, destinationStaffId)).toEqual([]);
			expect(await gateway.apiJson(`/api/staff/${source.id}`)).toEqual(sourceBefore);
		} finally {
			context.staffStore.remove(destinationStaffId);
			context.searchIndex?.removeStaff(destinationStaffId);
			context.sessionStore.remove(destinationSessionId);
			await context.sessionStore.flushAsync();
		}
	});

	test("rolls back a failed launch without changing or deauthorizing the source", async ({ gateway }) => {
		const source = await createStaff(gateway, { name: "Failed launch source" });
		const sourceBefore = structuredClone(await gateway.apiJson(`/api/staff/${source.id}`));
		seedSessionTranscript(gateway, source.currentSessionId);
		const manager = gateway.sessionManager as any;
		const originalCreateSession = manager.createSession;
		let options: any;
		manager.createSession = async (...args: any[]) => {
			options = args[4];
			throw new Error("STAFF_FORK_LAUNCH_FAILURE");
		};
		let result: { response: Response; value: any };
		try {
			result = await forkSession(gateway, source.currentSessionId, { newWorktree: false });
		} finally {
			manager.createSession = originalCreateSession;
		}

		expect(result.response.status).toBe(500);
		expect(result.value.error).toContain("STAFF_FORK_LAUNCH_FAILURE");
		expect(options.staffId, `${FAILURE_MARKER}: even a failed staff fork must reserve a destination-only identity`).not.toBe(source.id);
		expect(gateway.sessionManager.getSession(options.sessionId)).toBeUndefined();
		expect(gateway.sessionManager.getPersistedSession(options.sessionId)).toBeUndefined();
		expect((gateway.sessionManager as any).staffRecordSource.getStaff(options.staffId)).toBeUndefined();
		expect(gateway.projectContextManager.getOrCreate(source.projectId).staffStore.getIncludingPending(options.staffId)).toBeUndefined();
		expect(fs.existsSync(options.preExistingAgentSessionFile)).toBe(false);
		expect(sourceSnapshot(await gateway.apiJson(`/api/staff/${source.id}`))).toEqual(sourceSnapshot(sourceBefore));
		expect(gateway.sessionManager.getPersistedSession(source.currentSessionId)?.staffId).toBe(source.id);
	});

	test("rolls back the launched destination when strict staff persistence fails", async ({ gateway }) => {
		const source = await createStaff(gateway, { name: "Failed staff persistence source" });
		const sourceBefore = structuredClone(await gateway.apiJson(`/api/staff/${source.id}`));
		seedSessionTranscript(gateway, source.currentSessionId);
		const manager = gateway.sessionManager as any;
		const staffManager = manager.staffRecordSource as any;
		const originalCreateSession = manager.createSession;
		const originalRegister = staffManager.registerForkedStaff;
		let options: any;
		manager.createSession = async (...args: any[]) => {
			options = args[4];
			return originalCreateSession.apply(manager, args);
		};
		staffManager.registerForkedStaff = () => {
			throw new Error("STAFF_FORK_PERSISTENCE_FAILURE");
		};
		let result: { response: Response; value: any };
		try {
			result = await forkSession(gateway, source.currentSessionId, { newWorktree: false });
		} finally {
			manager.createSession = originalCreateSession;
			if (originalRegister === undefined) delete staffManager.registerForkedStaff;
			else staffManager.registerForkedStaff = originalRegister;
		}

		expect(result.response.status).toBe(500);
		expect(result.value.error).toContain("STAFF_FORK_PERSISTENCE_FAILURE");
		expect(gateway.sessionManager.getSession(options.sessionId)).toBeUndefined();
		expect(gateway.sessionManager.getPersistedSession(options.sessionId)).toBeUndefined();
		expect((gateway.sessionManager as any).staffRecordSource.getStaff(options.staffId)).toBeUndefined();
		expect(gateway.projectContextManager.getOrCreate(source.projectId).staffStore.getIncludingPending(options.staffId)).toBeUndefined();
		expect(fs.existsSync(options.preExistingAgentSessionFile)).toBe(false);
		expect(sourceSnapshot(await gateway.apiJson(`/api/staff/${source.id}`))).toEqual(sourceSnapshot(sourceBefore));
	});

	test("publishes nothing when the source transcript cannot be cloned", async ({ gateway }) => {
		const source = await createStaff(gateway, { name: "Failed transcript clone source" });
		const sourceBefore = structuredClone(await gateway.apiJson(`/api/staff/${source.id}`));
		const transcript = seedSessionTranscript(gateway, source.currentSessionId);
		const transcriptBefore = fs.readFileSync(transcript, "utf8");
		const staffIdsBefore = new Set((await listStaff(gateway)).map((staff: any) => staff.id));
		const sessionIdsBefore = new Set(gateway.projectContextManager.getAllLiveSessions().map((session: any) => session.id));
		const sourcePersisted = gateway.sessionManager.getPersistedSession(source.currentSessionId);
		const persistedIdsBefore = new Set(gateway.sessionManager.getSessionStore(sourcePersisted.projectId).getAll().map((session: any) => session.id));
		const manager = gateway.sessionManager as any;
		const originalRecoverSessionFile = manager.recoverSessionFile;
		const originalCopyFileSync = fs.copyFileSync;
		const missingTranscript = path.join(gateway.bobbitDir, "state", "session-prompts", `missing-${randomUUID()}.jsonl`);
		let destinationTranscript: string | undefined;
		manager.recoverSessionFile = (persisted: any) => persisted.id === source.currentSessionId
			? missingTranscript
			: originalRecoverSessionFile.call(manager, persisted);
		fs.copyFileSync = ((sourcePath: fs.PathLike, destinationPath: fs.PathLike, mode?: number) => {
			if (String(sourcePath) === missingTranscript) {
				destinationTranscript = String(destinationPath);
				throw new Error("STAFF_FORK_TRANSCRIPT_COPY_FAILURE");
			}
			return originalCopyFileSync(sourcePath, destinationPath, mode);
		}) as typeof fs.copyFileSync;

		let result: { response: Response; value: any };
		try {
			result = await forkSession(gateway, source.currentSessionId, { newWorktree: false });
		} finally {
			manager.recoverSessionFile = originalRecoverSessionFile;
			fs.copyFileSync = originalCopyFileSync;
		}

		expect(result.response.status).toBe(500);
		expect(result.value.error).toContain("STAFF_FORK_TRANSCRIPT_COPY_FAILURE");
		expect(destinationTranscript).toBeTruthy();
		expect(fs.existsSync(destinationTranscript!)).toBe(false);
		expect(new Set((await listStaff(gateway)).map((staff: any) => staff.id))).toEqual(staffIdsBefore);
		expect(new Set(gateway.projectContextManager.getAllLiveSessions().map((session: any) => session.id))).toEqual(sessionIdsBefore);
		expect(new Set(gateway.sessionManager.getSessionStore(sourcePersisted.projectId).getAll().map((session: any) => session.id))).toEqual(persistedIdsBefore);
		expect(sourceSnapshot(await gateway.apiJson(`/api/staff/${source.id}`))).toEqual(sourceSnapshot(sourceBefore));
		expect(gateway.sessionManager.getPersistedSession(source.currentSessionId)?.staffId).toBe(source.id);
		expect(fs.readFileSync(transcript, "utf8")).toBe(transcriptBefore);
	});
});
