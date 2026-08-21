import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectContext } from "../../src/server/agent/project-context.js";
import type { RegisteredProject } from "../../src/server/agent/project-registry.js";
import { TaskManager } from "../../src/server/agent/task-manager.js";
import {
	HostNotificationDispatcher,
	type HostNotificationDeliveryAdapter,
} from "../../src/server/extension-host/host-notification-dispatcher.js";
import type { HostNotification } from "../../src/shared/extension-host/host-hooks.js";
import { wireProjectHostNotificationBoundaries } from "../../src/server/server.js";
import { createMemFs } from "../harness/mem-fs.js";
import { getGateway, type EntityCounts, type GatewayFixture } from "../harness/gateway.js";
import { assertNoLeaks, snapshotEntities } from "../harness/leak-detector.js";
import { createRunChild, removeOwnedRunChild } from "../harness/run-isolation.js";
import { createScope, type TestScope } from "../harness/scope.js";

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

async function refreshServerPackIndex(gw: GatewayFixture): Promise<void> {
	const current = await gw.apiJson<{ order: string[] }>("/api/marketplace/pack-order?scope=server");
	const response = await gw.api("/api/marketplace/pack-order", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", order: current.order }),
	});
	expect(response.status, await response.clone().text()).toBe(200);
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
