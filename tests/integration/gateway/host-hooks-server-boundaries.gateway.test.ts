import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { Type } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectContext } from "../../../src/server/agent/project-context.js";
import { broadcastStatus } from "../../../src/server/agent/session-status.js";
import type { PiExtensionExternalTool, ScopedToolContext } from "../../../src/server/agent/tool-manager.js";
import type { RegisteredProject } from "../../../src/server/agent/project-registry.js";
import { TaskManager } from "../../../src/server/agent/task-manager.js";
import {
	HostNotificationDispatcher,
	type HostNotificationDeliveryAdapter,
} from "../../../src/server/extension-host/host-notification-dispatcher.js";
import type { HostNotification } from "../../../src/shared/extension-host/host-hooks.js";
import { wireProjectHostNotificationBoundaries } from "../../../src/server/server.js";
import { enableTsWorkerResolver } from "../../../tests/support/helpers/unit/enable-ts-worker.js";
import { createMemFs } from "../../../tests/support/harnesses/shared/mem-fs.js";
import { getGateway, type EntityCounts, type GatewayFixture } from "../../../tests/support/harnesses/shared/gateway.js";
import { assertNoLeaks, snapshotEntities } from "../../../tests/support/harnesses/shared/leak-detector.js";
import { createRunChild, removeOwnedRunChild } from "../../../tests/support/harnesses/shared/run-isolation.js";
import { createScope, type TestScope } from "../../../tests/support/harnesses/shared/scope.js";

const contexts: ProjectContext[] = [];
const contextRoots: string[] = [];

afterEach(async () => {
	await Promise.allSettled(contexts.splice(0).map(context => context.close()));
	for (const root of contextRoots.splice(0)) removeOwnedRunChild(root);
});

function project(id: string, rootPath: string): RegisteredProject {
	return {
		id,
		name: id,
		rootPath,
		createdAt: 1,
		kind: "normal",
		colorLight: "oklch(0.6 0.1 250)",
		colorDark: "oklch(0.7 0.1 250)",
	};
}

function context(id: string, fs = createMemFs()): ProjectContext {
	const rootPath = createRunChild("host-hooks-project");
	const registered = project(id, rootPath);
	fs.mkdirSync(registered.rootPath, { recursive: true });
	try {
		const ctx = new ProjectContext(registered, {
			fsImpl: fs,
			goalPersistence: "json",
			taskPersistence: "json",
			gatePersistence: "json",
		});
		contexts.push(ctx);
		contextRoots.push(rootPath);
		return ctx;
	} catch (error) {
		removeOwnedRunChild(rootPath);
		throw error;
	}
}

async function settleFanout(): Promise<void> {
	await new Promise<void>(resolve => setTimeout(resolve, 0));
}

interface CapturedSocket {
	ws: WebSocket;
	frames: any[];
	cursor(): number;
	waitFor(predicate: (frame: any) => boolean, from?: number, timeoutMs?: number): Promise<any>;
	barrier(from?: number): Promise<void>;
}

async function connectCaptured(
	wsBase: string,
	sessionId: string,
	token: string,
	clientKind?: "app",
): Promise<CapturedSocket> {
	const ws = new WebSocket(`${wsBase}/ws/${sessionId}`);
	const frames: any[] = [];
	ws.on("message", raw => {
		try { frames.push(JSON.parse(String(raw))); } catch { /* ignore non-JSON frames */ }
	});
	await new Promise<void>((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	ws.send(JSON.stringify({ type: "auth", token, ...(clientKind ? { clientKind } : {}) }));
	const waitFor = (predicate: (frame: any) => boolean, from = 0, timeoutMs = 3_000): Promise<any> => {
		const existing = frames.slice(from).find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`WebSocket frame timed out for ${sessionId}`));
			}, timeoutMs);
			const onMessage = (raw: unknown) => {
				let frame: any;
				try { frame = JSON.parse(String(raw)); } catch { return; }
				if (!predicate(frame) || frames.length - 1 < from) return;
				cleanup();
				resolve(frame);
			};
			const cleanup = () => {
				clearTimeout(timer);
				ws.off("message", onMessage);
			};
			ws.on("message", onMessage);
		});
	};
	await waitFor(frame => frame.type === "auth_ok");
	return {
		ws,
		frames,
		cursor: () => frames.length,
		waitFor,
		async barrier(from = frames.length) {
			ws.send(JSON.stringify({ type: "ping" }));
			await waitFor(frame => frame.type === "pong", from);
		},
	};
}

async function poll<T>(read: () => T | undefined | Promise<T | undefined>, label: string, timeoutMs = 3_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await new Promise<void>(resolve => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function waitForIdle(gw: GatewayFixture, sessionId: string): Promise<void> {
	await poll(() => gw.sessionManager.getSession(sessionId)?.status === "idle" ? true : undefined, `idle session ${sessionId}`);
}

async function inboxEntries(gw: GatewayFixture, staffId: string, sessionSecret?: string): Promise<any[]> {
	const response = await gw.api(`/api/staff/${encodeURIComponent(staffId)}/inbox`, {
		headers: sessionSecret ? { "X-Bobbit-Session-Secret": sessionSecret } : undefined,
	});
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json()).entries;
}

async function waitForInboxCount(gw: GatewayFixture, staffId: string, count: number, sessionSecret?: string): Promise<any[]> {
	return poll(async () => {
		const entries = await inboxEntries(gw, staffId, sessionSecret);
		return entries.length === count ? entries : undefined;
	}, `${count} inbox entries for ${staffId}`, 5_000);
}

async function refreshPackIndex(gw: GatewayFixture, scope: "server" | "project", projectId?: string): Promise<void> {
	const projectQuery = projectId ? `&projectId=${encodeURIComponent(projectId)}` : "";
	const current = await gw.apiJson<{ order: string[] }>(`/api/marketplace/pack-order?scope=${scope}${projectQuery}`);
	const response = await gw.api("/api/marketplace/pack-order", {
		method: "PUT",
		body: JSON.stringify({ scope, order: current.order, ...(projectId ? { projectId } : {}) }),
	});
	expect(response.status, await response.clone().text()).toBe(200);
}

async function refreshServerPackIndex(gw: GatewayFixture): Promise<void> {
	await refreshPackIndex(gw, "server");
}

function writeSessionAuthorityPack(gw: GatewayFixture, packName: string) {
	const packDir = path.join(gw.bobbitDir, "config", "market-packs", packName);
	const startedPath = path.join(packDir, "handler-started");
	const releasePath = path.join(packDir, "handler-release");
	const resultPath = path.join(packDir, "handler-result.json");
	mkdirSync(path.join(packDir, "hooks"), { recursive: true });
	mkdirSync(path.join(packDir, "lib"), { recursive: true });
	writeFileSync(path.join(packDir, "pack.yaml"), [
		"schema: 2", `name: ${packName}`, "description: Session authority fixture", "version: 1.0.0",
		"contents:", "  roles: []", "  tools: []", "  skills: []", "  entrypoints: []", "  hooks: [session-authority]",
	].join("\n") + "\n");
	writeFileSync(path.join(packDir, ".pack-meta.yaml"), [
		"sourceUrl: integration", "sourceRef: local", "commit: test", `packName: ${packName}`, "version: 1.0.0",
		"installedAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'", "scope: server",
	].join("\n") + "\n");
	writeFileSync(path.join(packDir, "hooks", "session-authority.yaml"), [
		"id: session.authority", "module: ../lib/hooks.mjs", "kind: notification",
		"notifications:", "  - { scope: session, name: statusChanged }",
		"capabilities: [session, agents]", "budget: { timeoutMs: 5000 }",
	].join("\n") + "\n");
	writeFileSync(path.join(packDir, "lib", "hooks.mjs"), [
		'import { existsSync, writeFileSync } from "node:fs";',
		`const started = ${JSON.stringify(startedPath)};`,
		`const release = ${JSON.stringify(releasePath)};`,
		`const result = ${JSON.stringify(resultPath)};`,
		"const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));",
		"export default { statusChanged: async (ctx, notification) => {",
		"  if (notification.payload.status !== 'streaming') return;",
		"  writeFileSync(started, 'started');",
		"  while (!existsSync(release)) await sleep(5);",
		"  const out = {};",
		"  try { out.transcript = await ctx.host.session.readTranscript(); } catch (error) { out.transcriptError = String(error?.message ?? error); }",
		"  try { out.spawn = await ctx.host.agents.spawn({ instructions: 'must-not-cross-project-move' }); } catch (error) { out.spawnError = String(error?.message ?? error); }",
		"  writeFileSync(result, JSON.stringify(out));",
		"} };",
	].join("\n") + "\n");
	return { packDir, startedPath, releasePath, resultPath };
}

function writeInterceptorAuditPack(gw: GatewayFixture, packName: string): string {
	const packDir = path.join(gw.bobbitDir, "config", "market-packs", packName);
	mkdirSync(path.join(packDir, "hooks"), { recursive: true });
	mkdirSync(path.join(packDir, "lib"), { recursive: true });
	writeFileSync(path.join(packDir, "pack.yaml"), [
		"schema: 2", `name: ${packName}`, "description: Host interceptor audit fixture", "version: 1.0.0",
		"contents:", "  roles: []", "  tools: []", "  skills: []", "  entrypoints: []", "  hooks: [audit-project]",
	].join("\n") + "\n");
	writeFileSync(path.join(packDir, ".pack-meta.yaml"), [
		"sourceUrl: integration", "sourceRef: local", "commit: test", `packName: ${packName}`, "version: 1.0.0",
		"installedAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'", "scope: server",
	].join("\n") + "\n");
	writeFileSync(path.join(packDir, "hooks", "audit-project.yaml"), [
		"id: audit.project", "module: ../lib/hooks.mjs", "kind: interceptor", "interceptors: [projectImported]", "capabilities: []",
	].join("\n") + "\n");
	writeFileSync(path.join(packDir, "lib", "hooks.mjs"), "export default { projectImported: async () => { throw new Error('private worker failure sentinel'); } };\n");
	return packDir;
}

function writeToolMutationPack(gw: GatewayFixture, packName: string): string {
	const packDir = path.join(gw.bobbitDir, "config", "market-packs", packName);
	mkdirSync(path.join(packDir, "hooks"), { recursive: true });
	mkdirSync(path.join(packDir, "lib"), { recursive: true });
	writeFileSync(path.join(packDir, "pack.yaml"), [
		"schema: 2", `name: ${packName}`, "description: Tool mutation validation fixture", "version: 1.0.0",
		"contents:", "  roles: []", "  tools: []", "  skills: []", "  entrypoints: []", "  hooks: [tool-mutation]",
	].join("\n") + "\n");
	writeFileSync(path.join(packDir, ".pack-meta.yaml"), [
		"sourceUrl: integration", "sourceRef: local", "commit: test", `packName: ${packName}`, "version: 1.0.0",
		"installedAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'", "scope: server",
	].join("\n") + "\n");
	writeFileSync(path.join(packDir, "hooks", "tool-mutation.yaml"), [
		"id: tool.mutation", "module: ../lib/hooks.mjs", "kind: interceptor",
		"interceptors: [beforeToolCall, afterToolResult]", "failurePolicy: failClosed", "capabilities: []",
	].join("\n") + "\n");
	writeFileSync(path.join(packDir, "lib", "hooks.mjs"), [
		"export default {",
		"  beforeToolCall: async (_ctx, input) => ({ action: 'replaceArgs', args: { approved: input.args?.forceInvalid ? 'invalid' : true } }),",
		"  afterToolResult: async (_ctx, input) => {",
		"    let result = { approved: input.result?.approved === true, replaced: true };",
		"    if (input.result?.generateDeep === true) { result = 'leaf'; for (let depth = 0; depth < 9; depth++) result = { child: result }; }",
		"    return { action: 'replaceResult', result };",
		"  },",
		"};",
	].join("\n") + "\n");
	return packDir;
}

function writePiToolPack(root: string, packName: string, scope: "server" | "project", toolName: string): string {
	const packDir = path.join(root, scope === "server" ? "config" : ".bobbit/config", "market-packs", packName);
	mkdirSync(path.join(packDir, "pi-extensions", "fixture"), { recursive: true });
	writeFileSync(path.join(packDir, "pack.yaml"), [
		"schema: 2", `name: ${packName}`, "description: Active runtime Pi snapshot fixture", "version: 1.0.0",
		"contents:", "  roles: []", "  tools: []", "  skills: []", "  entrypoints: []", "  pi-extensions: [fixture]",
	].join("\n") + "\n");
	writeFileSync(path.join(packDir, ".pack-meta.yaml"), [
		"sourceRef: local", "commit: test", `packName: ${packName}`, "version: 1.0.0",
		"installedAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'", `scope: ${scope}`,
	].join("\n") + "\n");
	writeFileSync(path.join(packDir, "pi-extensions", "fixture", "index.mjs"), [
		"export default function activate(pi) {",
		"  pi.registerTool({",
		`    name: ${JSON.stringify(toolName)},`,
		"    description: 'Claim-bound active runtime fixture',",
		"    parameters: { type: 'object', properties: { approved: { const: true } }, required: ['approved'], additionalProperties: false },",
		"    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),",
		"  });",
		"}",
	].join("\n") + "\n");
	return packDir;
}

function scopedPiTool(name: string, packName: string): PiExtensionExternalTool {
	return {
		name,
		runtimeName: name,
		description: `${name} scoped fixture`,
		group: "Pi Extensions",
		inputSchema: Type.Object({ approved: Type.Literal(true) }, { additionalProperties: false }),
		providerKey: `pi-ext:fixture:${packName}:${name}`,
		packName,
		packId: `market:fixture:${packName}`,
		listName: "fixture",
		scope: "fixture",
	};
}

function toolScope(projectId: string | undefined, cwd: string): ScopedToolContext {
	return {
		...(projectId ? { projectId } : {}),
		cwd,
		scopeKey: projectId ? `project:${projectId}` : `cwd:${path.resolve(cwd)}`,
	};
}

describe("gateway-owned host hook boundaries", () => {
	it("routes project store commits through one canonical dispatcher without replacing legacy callbacks", async () => {
		const delivered: HostNotification[] = [];
		const adapter: HostNotificationDeliveryAdapter = {
			consumer: "browser",
			deliver: notification => { delivered.push(notification); },
		};
		const dispatcher = new HostNotificationDispatcher({
			adapters: [adapter],
			idGenerator: (() => { let id = 0; return () => `notification-${++id}`; })(),
			now: (() => { let now = 100; return () => ++now; })(),
		});
		const ctx = context("project-a");
		let legacyCreates = 0;
		ctx.goalStore.onGoalCreated = () => { legacyCreates++; };
		ctx.setHostNotificationDispatcher(dispatcher);
		wireProjectHostNotificationBoundaries(ctx);

		await ctx.goalStore.putStrict({
			id: "goal-1",
			title: "Goal",
			cwd: ctx.project.rootPath,
			state: "todo",
			spec: "",
			createdAt: 10,
			updatedAt: 10,
			setupStatus: "ready",
			projectId: ctx.project.id,
		});
		expect(await ctx.goalManager.updateGoal("goal-1", { state: "complete" })).toBe(true);

		const tasks = new TaskManager(ctx.taskStore);
		const task = tasks.createTask("goal-1", "Implement", "implementation");
		tasks.updateTask(task.id, { state: "in-progress", title: "Implement safely" });
		await ctx.taskStore.flush();

		ctx.gateStore.initGatesForGoal("goal-1", ["implementation"]);
		await ctx.gateStore.flush();
		ctx.gateStore.updateGateStatus("goal-1", "implementation", "passed");
		await ctx.gateStore.flush();
		ctx.projectConfigStore.set("build_command", "npm run build");
		await settleFanout();

		expect(legacyCreates).toBe(1);
		expect(delivered.map(notification => notification.name)).toEqual([
			"goalCreated",
			"goalUpdated",
			"goalCompleted",
			"taskCreated",
			"gateStatusChanged",
			"settingsChanged",
		]);
		expect(delivered.every(notification => notification.projectId === "project-a")).toBe(true);
		expect(delivered.find(notification => notification.name === "taskCreated")).toMatchObject({
			aggregate: { id: task.id, revision: task.updatedAt },
			payload: { taskId: task.id, goalId: "goal-1", type: "implementation", state: "in-progress" },
		});
		expect(delivered.find(notification => notification.name === "gateStatusChanged")).toMatchObject({
			aggregate: { id: "goal-1:implementation", revision: 1 },
			payload: { goalId: "goal-1", gateId: "implementation", previousStatus: "pending", status: "passed" },
		});
		expect(delivered.find(notification => notification.name === "settingsChanged")?.payload).toEqual({
			target: "project",
			changedKeys: ["commands"],
		});
	});

	it("publishes every public worktree setting family only after rename and omits values, unknown keys, and failed writes", async () => {
		const delivered: HostNotification[] = [];
		const fs = createMemFs();
		let renameCount = 0;
		const rename = fs.renameSync.bind(fs);
		fs.renameSync = ((from: Parameters<typeof fs.renameSync>[0], to: Parameters<typeof fs.renameSync>[1]) => {
			rename(from, to);
			renameCount++;
		}) as typeof fs.renameSync;
		const dispatcher = new HostNotificationDispatcher({
			adapters: [{
				consumer: "browser",
				deliver: notification => {
					expect(renameCount).toBeGreaterThan(0);
					delivered.push(notification);
				},
			}],
			idGenerator: (() => { let id = 0; return () => `settings-${++id}`; })(),
		});
		const ctx = context("project-settings", fs);
		ctx.setHostNotificationDispatcher(dispatcher);
		wireProjectHostNotificationBoundaries(ctx);

		ctx.projectConfigStore.set("base_ref", "origin/sensitive-value");
		ctx.projectConfigStore.set("worktree_pool_size", "19");
		ctx.projectConfigStore.set("worktree_setup_timeout_ms", "987654");
		ctx.projectConfigStore.set("arbitrary_secret_key", "forbidden-secret-value");
		await settleFanout();

		expect(delivered).toHaveLength(3);
		expect(delivered.map(notification => notification.payload)).toEqual([
			{ target: "project", changedKeys: ["baseRef"] },
			{ target: "project", changedKeys: ["worktrees"] },
			{ target: "project", changedKeys: ["worktrees"] },
		]);
		expect(new Set(delivered.map(notification => notification.aggregate.revision)).size).toBe(3);
		for (const notification of delivered) {
			expect(notification.aggregate.revision).toMatch(/^[a-f0-9]{64}$/);
		}
		const publicFacts = JSON.stringify(delivered);
		expect(publicFacts).not.toContain("sensitive-value");
		expect(publicFacts).not.toContain("987654");
		expect(publicFacts).not.toContain("forbidden-secret-value");

		const committedRename = fs.renameSync;
		fs.renameSync = (() => { throw new Error("rename sentinel path and value"); }) as typeof fs.renameSync;
		expect(() => ctx.projectConfigStore.set("sandbox", "docker")).toThrow();
		fs.renameSync = committedRename;
		await settleFanout();
		expect(delivered).toHaveLength(3);
		expect(ctx.projectConfigStore.get("sandbox")).toBeUndefined();
	});
});

describe("real gateway notification authority", () => {
	let gw: GatewayFixture;
	let scope: TestScope;
	let baseline: EntityCounts;
	let tempRoots: string[];

	beforeAll(async () => {
		// The integration gateway runs from the TypeScript source bundle. ModuleHost
		// workers need the supported .js-to-.ts resolver before their first spawn.
		enableTsWorkerResolver();
		gw = await getGateway();
		baseline = snapshotEntities(gw);
	});
	beforeEach(() => {
		scope = createScope(gw);
		tempRoots = [];
	});
	afterEach(async () => {
		await scope.cleanup();
		for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
	});
	afterAll(() => { assertNoLeaks(baseline, snapshotEntities(gw)); });

	it("uses the production router audit sink for project-only interceptor decisions", async () => {
		const packName = `host-audit-${process.pid}-${Date.now()}`;
		const packDir = writeInterceptorAuditPack(gw, packName);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await refreshServerPackIndex(gw);
			const result = await gw.hostInterceptorRouter.dispatch("projectImported", {
				projectId: gw.defaultProjectId,
				components: [],
			}, {
				projectId: gw.defaultProjectId,
				cwd: gw.projectContextManager.getOrCreate(gw.defaultProjectId).project.rootPath,
				signal: new AbortController().signal,
			});
			expect(result.decisions).toHaveLength(1);
			expect(result.decisions[0]).toMatchObject({
				hook: "projectImported", projectId: gw.defaultProjectId, contributionId: "audit.project",
				outcome: "failed-open", proposalReceived: false, valid: false, applied: false,
			});
			expect(result.decisions[0]).not.toHaveProperty("sessionId");
			const auditCalls = log.mock.calls.filter(call => call[0] === "[host-interceptor-audit] %s");
			expect(auditCalls).toHaveLength(1);
			const diagnostic = JSON.parse(String(auditCalls[0]?.[1]));
			expect(diagnostic).toEqual(result.decisions[0]);
			expect(diagnostic).not.toHaveProperty("sessionId");
			expect(JSON.stringify(diagnostic)).not.toContain("private worker failure sentinel");
		} finally {
			log.mockRestore();
			rmSync(packDir, { recursive: true, force: true });
			await refreshServerPackIndex(gw);
		}
	});

	it("keeps a project Pi runtime schema snapshot claim-bound across marketplace invalidation and replacement", async () => {
		const suffix = `${process.pid}-${Date.now()}`;
		const hookPackName = `host-tool-runtime-${suffix}`;
		const piPackName = `project-pi-runtime-${suffix}`;
		const toolName = `project_runtime_pi_${Date.now()}`;
		const hookPackDir = writeToolMutationPack(gw, hookPackName);
		const projectContext = gw.projectContextManager.getOrCreate(gw.defaultProjectId);
		const projectManager = projectContext.toolManager;
		const serverManager = (gw.sessionManager as any).toolManager;
		const cwd = projectContext.project.rootPath as string;
		const projectScope = toolScope(gw.defaultProjectId, cwd);
		const piPackDir = writePiToolPack(cwd, piPackName, "project", toolName);
		const originalPiResolver = (gw.sessionManager as any).marketplacePiExtensionResolver;
		let finalizeSpawnOptions: ReturnType<typeof vi.spyOn> | undefined;
		try {
			// Tier-1 forbids the discovery probe's child process. Preserve the production
			// marketplace resolver and replace only this fixture's blocked probe result
			// with the schema the on-disk extension declares.
			gw.sessionManager.setMarketplacePiExtensionResolver((receivedScope: { projectId?: string; cwd?: string }, selectedManager?: any) => {
				const rows = originalPiResolver(receivedScope, selectedManager);
				const enabled = rows.some((row: any) => row.origin.packName === piPackName
					&& row.diagnostic.status !== "disabled" && row.diagnostic.status !== "unresolved");
				if (enabled) selectedManager?.registerScopedPiExtensionTools(
					toolScope(receivedScope.projectId, receivedScope.cwd ?? cwd),
					[scopedPiTool(toolName, piPackName)],
				);
				return rows.map((row: any) => row.origin.packName === piPackName && enabled
					? { ...row, discovery: { ...row.discovery, status: "ok", tools: [{
						name: toolName,
						description: "Claim-bound active runtime fixture",
						inputSchema: Type.Object({ approved: Type.Literal(true) }, { additionalProperties: false }),
					}] } }
					: row);
			});
			await refreshServerPackIndex(gw);
			await refreshPackIndex(gw, "project", gw.defaultProjectId);
			expect(projectManager).not.toBe(serverManager);
			expect(serverManager.getToolByName(toolName, projectScope)).toBeUndefined();

			const session = await scope.createSession({ cwd, sandboxed: false, worktree: false, allowedTools: [] });
			await waitForIdle(gw, session.id);
			const live = gw.sessionManager.getSession(session.id);
			const runtimeSnapshot = live.runtimePiExtensions;
			expect(runtimeSnapshot?.flatMap((extension: any) => extension.tools ?? [])).toContainEqual(expect.objectContaining({
				name: toolName,
				inputSchema: expect.objectContaining({ required: ["approved"], additionalProperties: false }),
			}));
			expect(projectManager.getToolByName(toolName, projectScope)).toBeDefined();
			expect(serverManager.getToolByName(toolName, projectScope)).toBeUndefined();

			const exactContext = {
				projectId: gw.defaultProjectId,
				sessionId: session.id,
				cwd,
				signal: new AbortController().signal,
			};
			const before = await gw.hostInterceptorRouter.dispatch("beforeToolCall", {
				toolCallId: "project-runtime-before",
				toolName,
				args: { approved: false },
			}, exactContext);
			expect(before.value.args).toEqual({ approved: true });
			expect(before.decisions).toMatchObject([{ outcome: "applied", valid: true, applied: true }]);

			const after = await gw.hostInterceptorRouter.dispatch("afterToolResult", {
				toolCallId: "project-runtime-after",
				toolName,
				result: { approved: true },
			}, exactContext);
			expect(after.value.result).toEqual({ approved: true, replaced: true });
			expect(after.decisions).toMatchObject([{ outcome: "applied", valid: true, applied: true }]);

			const invalidProposal = await gw.hostInterceptorRouter.dispatch("beforeToolCall", {
				toolCallId: "project-runtime-invalid-schema",
				toolName,
				args: { forceInvalid: true },
			}, exactContext);
			expect(invalidProposal.terminal).toEqual({ action: "block", reasonCode: "not_permitted" });
			expect(invalidProposal.decisions).toMatchObject([{ outcome: "failed-closed", valid: false, applied: false }]);

			const registry = (gw.hostInterceptorRouter as any).options.registry;
			const epochBefore = registry.getActivationEpoch();
			const disabled = await gw.api("/api/marketplace/pack-activation", {
				method: "PUT",
				body: JSON.stringify({
					scope: "project",
					projectId: gw.defaultProjectId,
					packName: piPackName,
					disabled: { piExtensions: ["fixture"] },
				}),
			});
			expect(disabled.status, await disabled.clone().text()).toBe(200);
			expect(registry.getActivationEpoch()).toBeGreaterThan(epochBefore);
			expect(projectManager.resolveScopedPiExtensionTools(projectScope)).toEqual([]);
			expect(projectManager.getToolByName(toolName, projectScope)).toBeUndefined();
			expect(projectManager.getToolByName(toolName)).toBeUndefined();
			expect(serverManager.getToolByName(toolName, projectScope)).toBeUndefined();
			expect(serverManager.getToolByName(toolName)).toBeUndefined();

			const foreignRoot = path.join(path.dirname(gw.bobbitDir), `host-hooks-pi-foreign-${suffix}`);
			tempRoots.push(foreignRoot);
			mkdirSync(foreignRoot, { recursive: true });
			const foreignProject = await gw.apiJson("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: `host-hooks-pi-foreign-${suffix}`, rootPath: foreignRoot }),
			});
			scope.trackProject(foreignProject.id);
			const foreignManager = gw.projectContextManager.getOrCreate(foreignProject.id).toolManager;
			expect(foreignManager.getToolByName(toolName, toolScope(foreignProject.id, foreignRoot))).toBeUndefined();

			for (const [label, context] of [
				["session", { ...exactContext, sessionId: `${session.id}-wrong` }],
				["project", { ...exactContext, projectId: foreignProject.id }],
				["cwd", { ...exactContext, cwd: path.join(cwd, "wrong-cwd") }],
			] as const) {
				const rejected = await gw.hostInterceptorRouter.dispatch("beforeToolCall", {
					toolCallId: `project-runtime-wrong-${label}`,
					toolName,
					args: {},
				}, context);
				expect(rejected.terminal, label).toEqual({ action: "block", reasonCode: "not_permitted" });
				expect(rejected.decisions, label).toMatchObject([{ outcome: "failed-closed", valid: false, applied: false }]);
			}

			await gw.sessionManager.grantToolPermission(
				session.id,
				"removed_pi_permission_request",
				"group",
				"Pi Extensions",
				"session-only",
			);
			expect(live.sessionOnlyGrantedTools ?? []).not.toContain(toolName);

			// A failed staged role replacement must not overwrite the still-live runtime
			// snapshot with its newly computed (now disabled) provider surface.
			finalizeSpawnOptions = vi.spyOn(gw.sessionManager as any, "finalizeSpawnOptions")
				.mockRejectedValueOnce(new Error("replacement fixture rejected"));
			const failedReplacement = await gw.api(`/api/sessions/${encodeURIComponent(session.id)}`, {
				method: "PATCH",
				body: JSON.stringify({ roleId: "coder" }),
			});
			expect(failedReplacement.status).toBe(400);
			finalizeSpawnOptions.mockRestore();
			finalizeSpawnOptions = undefined;
			expect(gw.sessionManager.getSession(session.id).runtimePiExtensions).toBe(runtimeSnapshot);
			const afterFailedReplacement = await gw.hostInterceptorRouter.dispatch("beforeToolCall", {
				toolCallId: "project-runtime-after-failed-replacement",
				toolName,
				args: {},
			}, exactContext);
			expect(afterFailedReplacement.value.args).toEqual({ approved: true });
			expect(afterFailedReplacement.decisions).toMatchObject([{ outcome: "applied", valid: true, applied: true }]);

			const replacement = await gw.api(`/api/sessions/${encodeURIComponent(session.id)}`, {
				method: "PATCH",
				body: JSON.stringify({ roleId: "coder" }),
			});
			expect(replacement.status, await replacement.clone().text()).toBe(200);
			expect(gw.sessionManager.getSession(session.id).runtimePiExtensions
				?.flatMap((extension: any) => extension.tools ?? []).map((tool: any) => tool.name)).not.toContain(toolName);
			const replacedRuntime = await gw.hostInterceptorRouter.dispatch("beforeToolCall", {
				toolCallId: "project-runtime-after-successful-replacement",
				toolName,
				args: {},
			}, exactContext);
			expect(replacedRuntime.terminal).toEqual({ action: "block", reasonCode: "not_permitted" });

			const fresh = await scope.createSession({ cwd, sandboxed: false, worktree: false });
			await waitForIdle(gw, fresh.id);
			expect(gw.sessionManager.getSession(fresh.id).runtimePiExtensions
				?.flatMap((extension: any) => extension.tools ?? []).map((tool: any) => tool.name)).not.toContain(toolName);
			expect(projectManager.getToolByName(toolName, projectScope)).toBeUndefined();
		} finally {
			finalizeSpawnOptions?.mockRestore();
			gw.sessionManager.setMarketplacePiExtensionResolver(originalPiResolver);
			rmSync(piPackDir, { recursive: true, force: true });
			await refreshPackIndex(gw, "project", gw.defaultProjectId);
			rmSync(hookPackDir, { recursive: true, force: true });
			await refreshServerPackIndex(gw);
		}
	});

	it("uses the server-owned runtime snapshot for an active projectless claim", async () => {
		const packName = `host-tool-projectless-${process.pid}-${Date.now()}`;
		const packDir = writeToolMutationPack(gw, packName);
		const serverManager = (gw.sessionManager as any).toolManager;
		const cwd = path.join(path.dirname(gw.bobbitDir), `host-tool-projectless-cwd-${Date.now()}`);
		const sessionId = `projectless-runtime-${Date.now()}`;
		const toolName = `projectless_runtime_pi_${Date.now()}`;
		const serverScope = toolScope(undefined, cwd);
		mkdirSync(cwd, { recursive: true });
		tempRoots.push(cwd);
		try {
			await refreshServerPackIndex(gw);
			serverManager.setScopedPiExtensionTools(serverScope, [scopedPiTool(toolName, packName)]);
			const runtimeExtensions = [{
				listName: "fixture",
				entryPath: path.join(packDir, "fixture.mjs"),
				packRoot: packDir,
				tools: [{ name: toolName, inputSchema: Type.Object({ approved: Type.Literal(true) }, { additionalProperties: false }) }],
				origin: { scope: "server", packName, packId: `market:server:${packName}` },
			}];
			(gw.sessionManager as any).sessions.set(sessionId, { id: sessionId, cwd, projectId: undefined, runtimePiExtensions: runtimeExtensions });
			serverManager.clearScopedPiExtensionTools(serverScope);
			expect(serverManager.getToolByName(toolName, serverScope)).toBeUndefined();

			const exact = await gw.hostInterceptorRouter.dispatch("beforeToolCall", {
				toolCallId: "projectless-runtime-exact",
				toolName,
				args: {},
			}, { sessionId, cwd, signal: new AbortController().signal });
			expect(exact.value.args).toEqual({ approved: true });
			expect(exact.decisions).toMatchObject([{ outcome: "applied", valid: true, applied: true }]);

			for (const context of [
				{ sessionId: `${sessionId}-wrong`, cwd },
				{ sessionId, cwd: path.join(cwd, "wrong") },
				{ sessionId, cwd, projectId: gw.defaultProjectId },
			]) {
				const rejected = await gw.hostInterceptorRouter.dispatch("beforeToolCall", {
					toolCallId: "projectless-runtime-wrong-claim",
					toolName,
					args: {},
				}, { ...context, signal: new AbortController().signal });
				expect(rejected.terminal).toEqual({ action: "block", reasonCode: "not_permitted" });
			}
		} finally {
			(gw.sessionManager as any).sessions.delete(sessionId);
			serverManager.clearScopedPiExtensionTools(serverScope);
			rmSync(packDir, { recursive: true, force: true });
			await refreshServerPackIndex(gw);
		}
	});

	async function createTaskAndObserver(suffix: string) {
		const project = gw.projectContextManager.getRegistry().get(gw.defaultProjectId);
		const cwd = project.rootPath as string;
		const goal = await scope.createGoal({
			title: `Host hook authority ${suffix}`,
			spec: "Deterministic host hook authority fixture with enough detail to satisfy goal validation.",
			cwd,
			worktree: false,
		});
		const task = await gw.apiJson(`/api/goals/${encodeURIComponent(goal.id)}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: `Observed task ${suffix}`, type: "testing", spec: "fixture" }),
		});
		const staff = await gw.apiJson("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name: `Task observer ${suffix}`,
				systemPrompt: "Observe bounded task notifications.",
				cwd,
				projectId: gw.defaultProjectId,
				worktree: false,
				sandboxed: false,
				contextPolicy: "preserve",
				triggers: [{
					id: "task-updated",
					type: "notification",
					notification: { scope: "project", name: "taskUpdated" },
					filter: { state: "todo" },
					enabled: true,
				}],
			}),
		});
		expect(staff.currentSessionId).toEqual(expect.any(String));
		scope.trackSession(staff.currentSessionId);
		await waitForIdle(gw, staff.currentSessionId);
		return { goal, task, staff, cwd };
	}

	async function updateTask(taskId: string, title: string, headers?: HeadersInit, extra: Record<string, unknown> = {}) {
		return gw.api(`/api/tasks/${encodeURIComponent(taskId)}`, {
			method: "PUT",
			headers,
			body: JSON.stringify({ title, ...extra }),
		});
	}

	it("rebinds an authenticated app socket after the session PATCH route moves projects", async () => {
		const defaultProject = gw.projectContextManager.getRegistry().get(gw.defaultProjectId);
		const foreignRoot = path.join(path.dirname(gw.bobbitDir), `host-hooks-moved-${Date.now()}`);
		tempRoots.push(foreignRoot);
		mkdirSync(foreignRoot, { recursive: true });
		const destination = await gw.apiJson("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `host-hooks-moved-${Date.now()}`, rootPath: foreignRoot }),
		});
		scope.trackProject(destination.id);
		const session = await scope.createSession({ cwd: defaultProject.rootPath });
		const oldGoal = await scope.createGoal({
			title: "Moved socket old project",
			spec: "Old-project notification fixture with enough detail for validation.",
			cwd: defaultProject.rootPath,
			worktree: false,
		});
		const newGoal = await scope.createGoal({
			title: "Moved socket new project",
			spec: "New-project notification fixture with enough detail for validation.",
			cwd: foreignRoot,
			projectId: destination.id,
			worktree: false,
		});
		await waitForIdle(gw, session.id);
		const captured = await connectCaptured(gw.wsBase, session.id, gw.token, "app");
		const cursor = captured.cursor();
		try {
			const moved = await gw.api(`/api/sessions/${encodeURIComponent(session.id)}`, {
				method: "PATCH",
				body: JSON.stringify({ projectId: destination.id }),
			});
			expect(moved.status, await moved.clone().text()).toBe(200);

			const oldUpdate = await gw.api(`/api/goals/${encodeURIComponent(oldGoal.id)}`, {
				method: "PUT",
				body: JSON.stringify({ title: "Old project must stay silent" }),
			});
			expect(oldUpdate.status, await oldUpdate.clone().text()).toBe(200);
			const refresh = await captured.waitFor(
				frame => frame.type === "host_notifications_refresh_required" && frame.scope === "project",
				cursor,
			);
			expect(refresh).toMatchObject({ type: "host_notifications_refresh_required", scope: "project" });
			await captured.barrier(cursor);
			expect(captured.frames.slice(cursor).filter(frame =>
				frame.type === "host_notification" && frame.notification?.aggregate?.id === oldGoal.id,
			)).toHaveLength(0);

			const newUpdate = await gw.api(`/api/goals/${encodeURIComponent(newGoal.id)}`, {
				method: "PUT",
				body: JSON.stringify({ title: "New project is authoritative" }),
			});
			expect(newUpdate.status, await newUpdate.clone().text()).toBe(200);
			const newFact = await captured.waitFor(
				frame => frame.type === "host_notification" && frame.notification?.aggregate?.id === newGoal.id,
				cursor,
			);
			expect(newFact.notification).toMatchObject({
				name: "goalUpdated",
				projectId: destination.id,
				aggregate: { id: newGoal.id },
			});
			const scopedFrames = captured.frames.slice(cursor).filter(frame =>
				frame.type === "host_notifications_refresh_required"
				|| (frame.type === "host_notification" && frame.notification?.aggregate?.id === newGoal.id),
			);
			expect(scopedFrames.map(frame => frame.type)).toEqual([
				"host_notifications_refresh_required",
				"host_notification",
			]);
		} finally {
			await gw.api(`/api/sessions/${encodeURIComponent(session.id)}`, {
				method: "PATCH",
				body: JSON.stringify({ projectId: gw.defaultProjectId }),
			});
			captured.ws.close();
		}
	});

	it("revokes paused session and agents capabilities when the source session moves projects", async () => {
		const defaultProject = gw.projectContextManager.getRegistry().get(gw.defaultProjectId);
		const foreignRoot = path.join(path.dirname(gw.bobbitDir), `host-hooks-capability-move-${Date.now()}`);
		tempRoots.push(foreignRoot);
		mkdirSync(foreignRoot, { recursive: true });
		const destination = await gw.apiJson("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `host-hooks-capability-move-${Date.now()}`, rootPath: foreignRoot }),
		});
		scope.trackProject(destination.id);
		const source = await scope.createSession({ cwd: defaultProject.rootPath });
		await waitForIdle(gw, source.id);
		const fixture = writeSessionAuthorityPack(gw, `host-authority-${process.pid}-${Date.now()}`);
		try {
			await refreshServerPackIndex(gw);
			const sourceSession = gw.sessionManager.getSession(source.id);
			const persistedBeforeMove = gw.sessionManager.getPersistedSession(source.id);
			expect(persistedBeforeMove?.agentSessionFile).toEqual(expect.any(String));
			const agentSessionFile = persistedBeforeMove!.agentSessionFile!;
			const beforeChildren = gw.orchestrationCore.list(source.id).map((row: any) => row.sessionId);
			broadcastStatus(sourceSession, "streaming");
			await poll(() => existsSync(fixture.startedPath) ? true : undefined, "paused notification handler");

			const moved = await gw.api(`/api/sessions/${encodeURIComponent(source.id)}`, {
				method: "PATCH",
				body: JSON.stringify({ projectId: destination.id }),
			});
			expect(moved.status, await moved.clone().text()).toBe(200);
			expect(gw.sessionManager.getSession(source.id)?.projectId).toBe(destination.id);
			expect(gw.sessionManager.getSessionStore(gw.defaultProjectId).get(source.id)?.projectId).toBe(destination.id);
			appendFileSync(agentSessionFile, `${JSON.stringify({
				type: "message",
				message: { role: "assistant", content: "destination-project-transcript-sentinel" },
			})}\n`);
			writeFileSync(fixture.releasePath, "release");
			await poll(() => existsSync(fixture.resultPath) ? true : undefined, "fenced notification result", 5_000);
			const result = JSON.parse(readFileSync(fixture.resultPath, "utf8"));

			expect(result).not.toHaveProperty("transcript");
			expect(result).not.toHaveProperty("spawn");
			expect(result.transcriptError).toMatch(/session authority is no longer valid/);
			expect(result.spawnError).toMatch(/session authority is no longer valid/);
			expect(JSON.stringify(result)).not.toContain("destination-project-transcript-sentinel");
			expect(gw.orchestrationCore.list(source.id).map((row: any) => row.sessionId)).toEqual(beforeChildren);
		} finally {
			// Unblock a worker even when an assertion fails so its ordered module lane
			// cannot bleed into a retry or a later boundary case in this shared gateway.
			writeFileSync(fixture.releasePath, "release");
			const live = gw.sessionManager.getSession(source.id);
			if (live) {
				broadcastStatus(live, "idle");
				await gw.api(`/api/sessions/${encodeURIComponent(source.id)}`, {
					method: "PATCH",
					body: JSON.stringify({ projectId: gw.defaultProjectId }),
				});
			}
			rmSync(fixture.packDir, { recursive: true, force: true });
			await refreshServerPackIndex(gw);
		}
	});

	it("sends enqueueWithId invalidations only to the current staff UI principal and keeps canonical input off the wire", async () => {
		const { task, staff } = await createTaskAndObserver("socket-routing");
		const foreignRoot = path.join(path.dirname(gw.bobbitDir), `host-hooks-foreign-${Date.now()}`);
		tempRoots.push(foreignRoot);
		mkdirSync(foreignRoot, { recursive: true });
		const foreignProject = await gw.apiJson("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `host-hooks-foreign-${Date.now()}`, rootPath: foreignRoot }),
		});
		scope.trackProject(foreignProject.id);
		const foreignSession = await scope.createSession({ projectId: foreignProject.id, cwd: foreignRoot });
		const staleSession = await scope.createSession({ cwd: gw.projectContextManager.getRegistry().get(gw.defaultProjectId).rootPath });
		await Promise.all([waitForIdle(gw, foreignSession.id), waitForIdle(gw, staleSession.id)]);

		const sandboxStore = gw.sessionManager.sandboxTokenStore;
		const sandboxToken = sandboxStore.register(gw.defaultProjectId);
		sandboxStore.addSession(gw.defaultProjectId, staff.currentSessionId);
		const sockets = await Promise.all([
			connectCaptured(gw.wsBase, staff.currentSessionId, gw.token, "app"),
			connectCaptured(gw.wsBase, staff.currentSessionId, sandboxToken, "app"),
			connectCaptured(gw.wsBase, staleSession.id, gw.token, "app"),
			connectCaptured(gw.wsBase, foreignSession.id, gw.token, "app"),
			connectCaptured(gw.wsBase, "__viewer__", gw.token, "app"),
		]);
		const [exact, sandbox, stale, foreign, viewer] = sockets;
		const staffSessionSecret = gw.sessionManager.sessionSecretStore.getOrCreateSecret(staff.currentSessionId);
		const cursors = sockets.map(socket => socket.cursor());
		const unboundFrames: any[] = [];
		const unbound = {
			authenticated: true,
			isViewer: false,
			authPrincipal: { kind: "admin" },
			readyState: WebSocket.OPEN,
			send: (data: string) => { unboundFrames.push(JSON.parse(data)); },
		};
		gw.sessionManager.getSession(staff.currentSessionId).clients.add(unbound as any);
		try {
			const response = await updateTask(task.id, "route this notification");
			expect(response.status, await response.clone().text()).toBe(200);
			const live = await exact.waitFor(frame => frame.type === "inbox.entry.added", cursors[0]);
			expect(live).toMatchObject({
				type: "inbox.entry.added",
				staffId: staff.id,
				entry: {
					staffId: staff.id,
					source: { type: "notification", triggerId: "task-updated" },
					prompt: "A host notification is available in this inbox entry's notification metadata.",
				},
			});
			expect(live.entry).not.toHaveProperty("notificationInput");
			expect(JSON.stringify(live)).not.toContain("rootCorrelationId");
			expect(JSON.stringify(live)).not.toContain("causationDepth");

			const persisted = await waitForInboxCount(gw, staff.id, 1, staffSessionSecret);
			expect(persisted[0].id).toBe(live.entry.id);
			expect(persisted[0].notificationInput).toMatchObject({
				rootCorrelationId: expect.any(String),
				causationDepth: 1,
				notification: {
					name: "taskUpdated",
					projectId: gw.defaultProjectId,
					aggregate: { id: task.id },
				},
			});

			await Promise.all(sockets.slice(1).map((socket, index) => socket.barrier(cursors[index + 1])));
			expect(unboundFrames.filter(frame => frame.type === "inbox.entry.added"), "unbound principal").toHaveLength(0);
			for (const [name, socket, cursor] of [
				["sandbox", sandbox, cursors[1]],
				["stale", stale, cursors[2]],
				["foreign", foreign, cursors[3]],
				["viewer", viewer, cursors[4]],
			] as const) {
				expect(socket.frames.slice(cursor).filter(frame => frame.type === "inbox.entry.added"), `${name} principal`).toHaveLength(0);
			}
		} finally {
			gw.sessionManager.getSession(staff.currentSessionId)?.clients.delete(unbound as any);
			for (const socket of sockets) socket.ws.close();
			sandboxStore.removeSession(gw.defaultProjectId, staff.currentSessionId);
			await gw.api(`/api/staff/${encodeURIComponent(staff.id)}`, { method: "DELETE" });
		}
	});

	it("propagates only an authentic notification turn through a first-party mutation and fences stale authority", async () => {
		const { task, staff } = await createTaskAndObserver("causal-loop");
		const enqueuePrompt = vi.spyOn(gw.sessionManager, "enqueuePrompt").mockResolvedValue({ status: "dispatched" });
		const sessionId = staff.currentSessionId as string;
		const secret = gw.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId);
		const foreignSession = await scope.createSession({ cwd: gw.projectContextManager.getRegistry().get(gw.defaultProjectId).rootPath });
		const foreignSecret = gw.sessionManager.sessionSecretStore.getOrCreateSecret(foreignSession.id);
		try {
			expect((await updateTask(task.id, "seed notification root")).status).toBe(200);
			const initialEntries = await waitForInboxCount(gw, staff.id, 1, secret);
			const initialInput = initialEntries[0].notificationInput;
			const turn = await poll(
				() => gw.sessionManager.getStaffNotificationTurnContext(sessionId),
				"notification-triggered staff turn context",
				5_000,
			);
			expect(turn).toMatchObject({
				sessionId,
				projectId: gw.defaultProjectId,
				staffId: staff.id,
				triggerId: "task-updated",
				notificationId: initialInput.notification.id,
				rootCorrelationId: initialInput.rootCorrelationId,
				causationDepth: 1,
			});
			expect(enqueuePrompt).toHaveBeenCalledWith(sessionId, expect.stringContaining(initialEntries[0].id), expect.objectContaining({ source: "system" }));

			// The real request/session-secret/ALS/task-publisher/dispatcher path keeps
			// this child fact in the original root, so the same subscriber is suppressed.
			const sameRoot = await updateTask(task.id, "same root child fact", { "X-Bobbit-Session-Secret": secret });
			expect(sameRoot.status, await sameRoot.clone().text()).toBe(200);
			await settleFanout();
			expect(await inboxEntries(gw, staff.id)).toHaveLength(1);

			// Callers cannot smuggle loop controls through the strict first-party body.
			const forgedFields = await updateTask(task.id, "forged fields", undefined, {
				rootCorrelationId: initialInput.rootCorrelationId,
				causationDepth: 1,
			});
			expect(forgedFields.status).toBe(400);
			expect(await inboxEntries(gw, staff.id)).toHaveLength(1);

			// Missing, random, and another real session's secret cannot borrow the turn.
			for (const [label, headers] of [
				["missing", undefined],
				["forged", { "X-Bobbit-Session-Secret": "not-a-host-secret" }],
				["foreign", { "X-Bobbit-Session-Secret": foreignSecret }],
			] as const) {
				const response = await updateTask(task.id, `${label} secret gets a fresh root`, headers);
				expect(response.status, await response.clone().text()).toBe(200);
			}
			const independentEntries = await waitForInboxCount(gw, staff.id, 4, secret);
			const roots = independentEntries.map(entry => entry.notificationInput.rootCorrelationId);
			expect(new Set(roots).size).toBe(4);
			expect(roots.slice(1)).not.toContain(initialInput.rootCorrelationId);

			// Retirement invalidates the live staff/session authority before another
			// request can inherit it; reactivation does not resurrect the stale root.
			expect((await gw.api(`/api/staff/${staff.id}`, { method: "PUT", body: JSON.stringify({ state: "retired" }) })).status).toBe(200);
			expect(gw.sessionManager.getStaffNotificationTurnContext(sessionId)).toBeUndefined();
			expect((await gw.api(`/api/staff/${staff.id}`, { method: "PUT", body: JSON.stringify({ state: "active" }) })).status).toBe(200);
			expect((await updateTask(task.id, "after retirement fence", { "X-Bobbit-Session-Secret": secret })).status).toBe(200);
			await waitForInboxCount(gw, staff.id, 5);

			const reserve = async (notificationId: string, rootCorrelationId: string) => {
				const result = await gw.sessionManager.enqueueStaffNotificationPrompt(sessionId, `[INBOX] ${notificationId}`, {
					projectId: gw.defaultProjectId,
					staffId: staff.id,
					triggerId: "task-updated",
					notificationId,
					rootCorrelationId,
					causationDepth: 1,
				});
				expect(result.status).toBe("dispatched");
			};

			// Terminal completion clears only the exact notification turn.
			await reserve("completion-notification", "completion-root");
			gw.sessionManager.clearStaffNotificationTurnContext(sessionId, "different-notification");
			expect(gw.sessionManager.getStaffNotificationTurnContext(sessionId)?.notificationId).toBe("completion-notification");
			gw.sessionManager.clearStaffNotificationTurnContext(sessionId, "completion-notification");
			expect(gw.sessionManager.getStaffNotificationTurnContext(sessionId)).toBeUndefined();
			expect((await updateTask(task.id, "after completion fence", { "X-Bobbit-Session-Secret": secret })).status).toBe(200);
			await waitForInboxCount(gw, staff.id, 6);

			// Abort clears authority before the bridge abort can settle.
			await reserve("abort-notification", "abort-root");
			const liveSession = gw.sessionManager.getSession(sessionId);
			liveSession.status = "streaming";
			await gw.sessionManager.abortSessionTurn(sessionId);
			expect(gw.sessionManager.getStaffNotificationTurnContext(sessionId)).toBeUndefined();
			liveSession.status = "idle";
			expect((await updateTask(task.id, "after abort fence", { "X-Bobbit-Session-Secret": secret })).status).toBe(200);
			await waitForInboxCount(gw, staff.id, 7);

			// Lifecycle fencing (the in-process half of restart) erases a stale turn.
			await reserve("restart-notification", "restart-root");
			liveSession.lifecycleFenced = true;
			expect(gw.sessionManager.getStaffNotificationTurnContext(sessionId)).toBeUndefined();
			liveSession.lifecycleFenced = false;
			expect((await updateTask(task.id, "after lifecycle fence", { "X-Bobbit-Session-Secret": secret })).status).toBe(200);
			await waitForInboxCount(gw, staff.id, 8);
		} finally {
			enqueuePrompt.mockRestore();
			await gw.api(`/api/staff/${encodeURIComponent(staff.id)}`, { method: "DELETE" });
		}
	});
});
