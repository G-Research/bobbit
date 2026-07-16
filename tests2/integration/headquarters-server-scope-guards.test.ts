// Ported from tests/headquarters-server-scope-guards.test.ts (straggler-coverage
// -triage PARTIAL — the uncovered sub-behaviours: server-scope role/tool assistant
// cwd defaults + coercion, and archive-bobbit-through-symlink preserving HQ).
//
// Keep this suite at the route/core boundary: a minimal authenticated request
// adapter feeds the production project/cwd guards and a suite-owned SessionStore.
// The archive canary uses the production archive core against a canonical junction
// alias backed by memfs; no shared gateway, listener, project contexts, teams, or
// agent processes boot.
//
// The projectless-session MCP fail-closed sub-behaviour is ported separately in
// tests2/core/session-mcp-projectless-fail-closed.test.ts (pure unit).
import { beforeAll, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { archiveProjectBobbitDir, GATEWAY_OWNED_FILES } from "../../src/server/agent/bobbit-archive.js";
import {
	HEADQUARTERS_PROJECT_ID,
	SYSTEM_PROJECT_ID,
	type ProjectRegistry,
	type RegisteredProject,
} from "../../src/server/agent/project-registry.js";
import type { ProjectContextManager } from "../../src/server/agent/project-context-manager.js";
import { resolveProjectForRequest, validateExecutionCwd } from "../../src/server/agent/resolve-project.js";
import { SessionStore, type PersistedSession } from "../../src/server/agent/session-store.js";
import { validateToken } from "../../src/server/auth/token.js";
import { guardProcessEnv } from "../core/helpers/env-guard.js";
import { createManualClock, type ManualClock } from "../harness/clock.js";
import { createMemFs, type MemFs } from "../harness/mem-fs.js";

guardProcessEnv();

type SessionStoreMemFs = MemFs & {
	openSync(file: string, flags: string): number;
	fsyncSync(fd: number): void;
	closeSync(fd: number): void;
};

type RouteResult = { status: number; body: any };
type SessionRequest = { assistantType?: string; projectId?: string; cwd?: string; worktree?: boolean };

interface SuiteContext {
	authToken: string;
	clock: ManualClock;
	memfs: SessionStoreMemFs;
	sessionStore: SessionStore;
	registry: ProjectRegistry;
	projectContexts: ProjectContextManager;
	headquartersDir: string;
	archiveRoot: string;
	archiveLinkRoot: string;
}

function createSessionStoreMemFs(): SessionStoreMemFs {
	const memfs = createMemFs() as SessionStoreMemFs;
	let nextFd = 3;
	const fds = new Map<number, string>();
	const writeFileSync = memfs.writeFileSync.bind(memfs);
	memfs.openSync = (file: string) => {
		const fd = nextFd++;
		fds.set(fd, file);
		return fd;
	};
	(memfs as any).writeFileSync = (target: string | number, data: string | NodeJS.ArrayBufferView, encoding?: BufferEncoding) => {
		if (typeof target === "number") {
			const file = fds.get(target);
			if (!file) throw Object.assign(new Error(`EBADF: bad file descriptor, write '${target}'`), { code: "EBADF" });
			return writeFileSync(file, data, encoding as any);
		}
		return writeFileSync(target, data, encoding as any);
	};
	memfs.fsyncSync = () => {};
	memfs.closeSync = (fd: number) => { fds.delete(fd); };
	return memfs;
}

function project(id: string, rootPath: string, kind: "headquarters" | "system", hidden = false): RegisteredProject {
	return {
		id,
		name: kind === "headquarters" ? "Headquarters" : "System",
		rootPath,
		kind,
		hidden,
		createdAt: 1,
		colorLight: "#000000",
		colorDark: "#ffffff",
	};
}

function comparablePath(value: string): string {
	let resolved = path.resolve(value);
	if (suite && resolved === suite.archiveLinkRoot) resolved = suite.archiveRoot;
	else {
		try { resolved = fs.realpathSync(resolved); } catch { /* textual fallback for memfs roots */ }
	}
	const normalized = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(a: string, b: string): boolean {
	return comparablePath(a) === comparablePath(b);
}

let sequence = 0;
let suite: SuiteContext;

/** Minimal authenticated POST /api/sessions boundary for the server-scope branch. */
function createServerScopeSession(body: SessionRequest, authorization?: string): RouteResult {
	const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
	if (!token || !validateToken(token, suite.authToken)) return { status: 401, body: { error: "Unauthorized" } };

	const assistantType = body.assistantType;
	const isServerScopeAssistant = assistantType === "role" || assistantType === "tool";
	const projectId = body.projectId?.trim() || (isServerScopeAssistant ? SYSTEM_PROJECT_ID : undefined);
	const resolved = resolveProjectForRequest(suite.registry, { projectId }, {
		allowSystem: isServerScopeAssistant && projectId === SYSTEM_PROJECT_ID,
	});
	if (!resolved.ok) return { status: resolved.status, body: { error: resolved.error, code: resolved.code } };

	const explicitCwd = body.cwd?.trim() || undefined;
	let cwd = resolved.project.rootPath;
	if (isServerScopeAssistant && resolved.projectId === SYSTEM_PROJECT_ID) {
		cwd = suite.headquartersDir;
		if (explicitCwd) {
			const validation = validateExecutionCwd(
				suite.registry,
				suite.projectContexts,
				HEADQUARTERS_PROJECT_ID,
				explicitCwd,
				{ kind: "user-input" },
			);
			if (validation.ok) cwd = explicitCwd;
		}
	}

	const now = suite.clock.now();
	const session: PersistedSession = {
		id: `server-scope-${++sequence}`,
		title: `${assistantType ?? "session"} assistant`,
		cwd,
		agentSessionFile: "",
		createdAt: now,
		lastActivity: now,
		projectId: resolved.projectId,
		assistantType,
	};
	suite.sessionStore.put(session);
	return { status: 201, body: suite.sessionStore.get(session.id) };
}

function withArchiveMemFs<T>(fn: () => T): T {
	const methods = [
		"existsSync", "mkdirSync", "readFileSync", "writeFileSync", "appendFileSync",
		"readdirSync", "statSync", "lstatSync", "renameSync", "rmSync", "unlinkSync", "copyFileSync",
	] as const;
	const spies = methods.map((name) => (vi.spyOn as any)(fs, name).mockImplementation((...args: unknown[]) => (suite.memfs as any)[name](...args)));
	try { return fn(); }
	finally { for (const spy of spies.reverse()) spy.mockRestore(); }
}

/** Minimal authenticated POST /api/projects/archive-bobbit boundary. */
function archiveBobbit(rootPath: string, authorization?: string): RouteResult {
	const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
	if (!token || !validateToken(token, suite.authToken)) return { status: 401, body: { error: "Unauthorized" } };

	const gatewayOwned = samePath(rootPath, suite.archiveRoot);
	// The suite's alias models a junction: route identity resolves canonically,
	// while the archive core operates on the canonical in-memory storage root.
	const canonicalRoot = samePath(rootPath, suite.archiveLinkRoot) ? suite.archiveRoot : rootPath;
	const rootBobbitDir = path.join(canonicalRoot, ".bobbit");
	const preserveEntries: string[] = [];
	if (suite.memfs.existsSync(path.join(rootBobbitDir, "headquarters"))) preserveEntries.push("headquarters/");
	const allowlist = [...(gatewayOwned ? GATEWAY_OWNED_FILES : []), ...preserveEntries];
	return withArchiveMemFs(() => ({
		status: 200,
		body: archiveProjectBobbitDir(canonicalRoot, { gatewayOwned, allowlist }),
	}));
}

const auth = (): string => `Bearer ${suite.authToken}`;

describe("Headquarters server-scope guards", () => {
	beforeAll(() => {
		const memfs = createSessionStoreMemFs();
		const clock = createManualClock(1_700_000_000_000);
		const root = path.resolve("/memfs/headquarters-server-scope");
		const headquartersDir = path.join(root, "headquarters");
		const stateDir = path.join(root, "state");
		memfs.mkdirSync(stateDir, { recursive: true });
		memfs.mkdirSync(headquartersDir, { recursive: true });

		const projects = new Map<string, RegisteredProject>([
			[HEADQUARTERS_PROJECT_ID, project(HEADQUARTERS_PROJECT_ID, headquartersDir, "headquarters")],
			[SYSTEM_PROJECT_ID, project(SYSTEM_PROJECT_ID, path.join(stateDir, "system-project"), "system", true)],
		]);
		const registry = { get: (id: string) => projects.get(id) } as ProjectRegistry;
		suite = {
			authToken: "suite-owned-admin-token",
			clock,
			memfs,
			sessionStore: new SessionStore(stateDir, memfs, clock),
			registry,
			projectContexts: {} as ProjectContextManager,
			headquartersDir,
			archiveRoot: path.resolve("/memfs/headquarters-server-scope/archive-root"),
			archiveLinkRoot: path.resolve("/memfs/headquarters-server-scope/archive-root-link"),
		};
	});

	it("server-scope role assistant without cwd defaults to the Headquarters directory", () => {
		const unauthorized = createServerScopeSession({ assistantType: "role", worktree: false });
		assert.equal(unauthorized.status, 401, "server-scope creation remains admin-authenticated");

		const created = createServerScopeSession({ assistantType: "role", worktree: false }, auth());
		assert.equal(created.status, 201, JSON.stringify(created.body));
		assert.equal(created.body.projectId, SYSTEM_PROJECT_ID);
		assert.equal(created.body.assistantType, "role");
		assert.ok(samePath(created.body.cwd, suite.headquartersDir), `expected role assistant cwd ${created.body.cwd} to default to Headquarters dir ${suite.headquartersDir}`);
	});

	it("server-scope role assistant coerces an explicit cwd outside the Headquarters directory", () => {
		const outside = path.resolve("/memfs/role-assistant-escape");
		const created = createServerScopeSession({ assistantType: "role", worktree: false, cwd: outside }, auth());
		assert.equal(created.status, 201, JSON.stringify(created.body));
		assert.equal(created.body.projectId, SYSTEM_PROJECT_ID);
		assert.ok(samePath(created.body.cwd, suite.headquartersDir), `expected role assistant cwd ${created.body.cwd} to be coerced to Headquarters dir ${suite.headquartersDir}`);
	});

	it("server-scope tool assistant coerces an explicit cwd outside the Headquarters directory", () => {
		const outside = path.resolve("/memfs/tool-assistant-escape");
		const created = createServerScopeSession({ assistantType: "tool", worktree: false, cwd: outside }, auth());
		assert.equal(created.status, 201, JSON.stringify(created.body));
		assert.equal(created.body.projectId, SYSTEM_PROJECT_ID);
		assert.equal(created.body.assistantType, "tool");
		assert.ok(samePath(created.body.cwd, suite.headquartersDir), `expected tool assistant cwd ${created.body.cwd} to be coerced to Headquarters dir ${suite.headquartersDir}`);
	});

	it("server-scope assistant accepts an explicit cwd inside the Headquarters directory", () => {
		const hqSubdir = path.join(suite.headquartersDir, "workspace");
		suite.memfs.mkdirSync(hqSubdir, { recursive: true });
		const accepted = createServerScopeSession({ assistantType: "role", worktree: false, cwd: hqSubdir }, auth());
		assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
		assert.equal(accepted.body.projectId, SYSTEM_PROJECT_ID);
		assert.ok(samePath(accepted.body.cwd, hqSubdir), "expected role assistant cwd to be preserved inside Headquarters dir");
	});

	it("archive-bobbit through a symlink to the server root preserves Headquarters", () => {
		const serverRoot = suite.archiveRoot;
		const linkRoot = suite.archiveLinkRoot;
		const hqSentinel = path.join(serverRoot, ".bobbit", "headquarters", "state", "sentinel.txt");
		suite.memfs.mkdirSync(path.dirname(hqSentinel), { recursive: true });
		suite.memfs.writeFileSync(hqSentinel, "keep headquarters\n", "utf-8");
		const normalConfig = path.join(serverRoot, ".bobbit", "project.yaml");
		suite.memfs.writeFileSync(normalConfig, "name: normal config\n", "utf-8");

		assert.equal(archiveBobbit(linkRoot).status, 401, "archive route remains admin-authenticated");
		const archived = archiveBobbit(linkRoot, auth());
		assert.equal(archived.status, 200, JSON.stringify(archived.body));
		assert.equal(archived.body.gatewayOwned, true, "canonical symlink target must be recognized as the gateway root");
		assert.equal(suite.memfs.existsSync(hqSentinel), true, "Headquarters state must survive archive via a symlinked server root");
		assert.ok(archived.body.preservedPaths.includes("headquarters"), "archive manifest should record Headquarters as preserved");
		assert.equal(suite.memfs.existsSync(normalConfig), false, "normal project config should still be archived");
	});
});
