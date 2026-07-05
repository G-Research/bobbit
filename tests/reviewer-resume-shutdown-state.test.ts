import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SessionManager, sessionNeedsRestartRedrive } from "../src/server/agent/session-manager.ts";

function sessionManagerSource(): string {
	return fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-manager.ts"), "utf-8");
}

function shutdownBody(source: string): string {
	const start = source.indexOf("\tasync shutdown(): Promise<void> {");
	assert.notEqual(start, -1, "precondition: SessionManager.shutdown() must exist");
	const end = source.indexOf("\n// ── Sandbox credential auto-resolution", start);
	assert.notEqual(end, -1, "precondition: SessionManager.shutdown() section must be bounded before sandbox credential code");
	return source.slice(start, end);
}

function makeShutdownSession(id: string, status: any, extra: Record<string, unknown> = {}) {
	return {
		id,
		title: id,
		status,
		streamingStartedAt: undefined,
		clients: new Set<any>(),
		rpcClient: { stop: async () => {} },
		unsubscribe: () => {},
		promptQueue: { length: 0 },
		...extra,
	};
}

test("restart re-drive predicate covers busy states but not idle/terminal states", () => {
	assert.equal(sessionNeedsRestartRedrive("idle"), false);
	assert.equal(sessionNeedsRestartRedrive("terminated"), false);
	assert.equal(sessionNeedsRestartRedrive("streaming"), true);
	assert.equal(sessionNeedsRestartRedrive("preparing"), true);
	assert.equal(sessionNeedsRestartRedrive("aborting"), true);
	assert.equal(sessionNeedsRestartRedrive("starting"), true, "fresh active startup should still be redriven");
});

test("restore-startup starting uses the persisted interrupted-turn bit", () => {
	assert.equal(
		sessionNeedsRestartRedrive({ status: "starting", restoreStartupWasStreaming: false }),
		false,
		"rapid shutdown during cold restore of a previously idle session must not create a false boot re-prompt",
	);
	assert.equal(
		sessionNeedsRestartRedrive({ status: "starting", restoreStartupWasStreaming: true }),
		true,
		"rapid shutdown during cold restore of a truly interrupted session must preserve re-drive",
	);
});

test("shutdown persists re-drive state from session lifecycle state", async () => {
	const updates: Record<string, any> = {};
	const manager: any = new SessionManager();
	manager._testStore = {
		update: (id: string, update: any) => { updates[id] = update; },
		get: () => undefined,
		flush: () => {},
	};
	manager.closeExtensionChannelsForSession = async () => {};
	manager.cancelPendingAutoRetry = () => {};
	manager._untrackConnectedSession = () => {};

	manager.sessions.set("restored-idle", makeShutdownSession("restored-idle", "starting", { restoreStartupWasStreaming: false }));
	manager.sessions.set("restored-active", makeShutdownSession("restored-active", "starting", { restoreStartupWasStreaming: true }));
	manager.sessions.set("fresh-starting", makeShutdownSession("fresh-starting", "starting"));
	manager.sessions.set("preparing", makeShutdownSession("preparing", "preparing"));
	manager.sessions.set("idle", makeShutdownSession("idle", "idle"));

	await manager.shutdown();

	assert.equal(updates["restored-idle"].wasStreaming, false);
	assert.equal(updates["restored-idle"].streamingStartedAt, undefined);
	assert.equal(updates["restored-active"].wasStreaming, true);
	assert.equal(typeof updates["restored-active"].streamingStartedAt, "number");
	assert.equal(updates["fresh-starting"].wasStreaming, true);
	assert.equal(updates.preparing.wasStreaming, true);
	assert.equal(updates.idle.wasStreaming, false);
});

test("MEM-1: shutdown() dispatches sessionShutdown for every live session before it settles", async () => {
	const dispatched: Array<{ hook: string; ctx: any }> = [];
	const manager: any = new SessionManager();
	manager._testStore = {
		update: () => {},
		get: () => undefined,
		flush: () => {},
	};
	manager.closeExtensionChannelsForSession = async () => {};
	manager.cancelPendingAutoRetry = () => {};
	manager._untrackConnectedSession = () => {};
	manager.lifecycleHub = {
		dispatch: async (hook: string, ctx: any) => {
			dispatched.push({ hook, ctx });
			return { blocks: [], diagnostics: [] };
		},
	};

	manager.sessions.set("s1", makeShutdownSession("s1", "idle", { projectId: "p1", cwd: "/w/p1", goalId: "g1", role: "coder" }));
	manager.sessions.set("s2", makeShutdownSession("s2", "idle", { projectId: undefined, cwd: "/w/global", teamGoalId: "tg2" }));

	await manager.shutdown();

	assert.equal(dispatched.length, 2, "sessionShutdown dispatched once per live session (previously never dispatched at all — MEM-1)");
	assert.ok(dispatched.every((d) => d.hook === "sessionShutdown"));
	const s1 = dispatched.find((d) => d.ctx.sessionId === "s1");
	assert.equal(s1?.ctx.projectId, "p1");
	assert.equal(s1?.ctx.scope, "project");
	assert.equal(s1?.ctx.cwd, "/w/p1");
	assert.equal(s1?.ctx.goalId, "g1");
	assert.equal(s1?.ctx.roleName, "coder");
	const s2 = dispatched.find((d) => d.ctx.sessionId === "s2");
	assert.equal(s2?.ctx.scope, "global", "no projectId ⇒ global scope");
	assert.equal(s2?.ctx.goalId, "tg2", "falls back to teamGoalId when goalId is absent");
});

test("MEM-1: a throwing sessionShutdown dispatch never blocks graceful shutdown", async () => {
	const manager: any = new SessionManager();
	manager._testStore = {
		update: () => {},
		get: () => undefined,
		flush: () => {},
	};
	manager.closeExtensionChannelsForSession = async () => {};
	manager.cancelPendingAutoRetry = () => {};
	manager._untrackConnectedSession = () => {};
	manager.lifecycleHub = {
		dispatch: async () => {
			throw new Error("provider hook boom");
		},
	};
	manager.sessions.set("s1", makeShutdownSession("s1", "idle"));

	await assert.doesNotReject(manager.shutdown());
	assert.equal(manager.sessions.has("s1"), false, "session teardown still completes despite the dispatch failure");
});

test("shutdown uses the centralized restart re-drive predicate, not exact streaming", () => {
	const source = sessionManagerSource();
	const body = shutdownBody(source);

	assert.match(
		body,
		/wasStreaming:\s*needsRestartRedrive\s*[,}]/,
		"shutdown must persist the centralized restart re-drive predicate into the legacy wasStreaming field.",
	);
	assert.doesNotMatch(
		body,
		/wasStreaming:\s*session\.status\s*===\s*["']streaming["']\s*[,}]/,
		"SessionManager.shutdown() must mark active/busy reviewer statuses as interrupted for restart re-drive, not only status === \"streaming\".",
	);
});
