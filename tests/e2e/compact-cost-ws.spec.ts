import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	connectWs,
	createSession,
	deleteSession,
	waitForSessionStatus,
	type WsConnection,
	type WsMsg,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * This spec exercises server WS hydration through the in-process harness,
 * which imports compiled files from dist/server. The shared E2E global setup
 * only builds when dist is missing, so a persistent worktree can otherwise run
 * these regression tests against a stale pre-hydration server build.
 */
function ensureFreshServerBuild(): void {
	const sourceFiles = [
		"src/server/agent/session-manager.ts",
		"src/server/ws/handler.ts",
		"src/server/ws/protocol.ts",
	].map((p) => resolve(PROJECT_ROOT, p));
	const outputFiles = [
		"dist/server/agent/session-manager.js",
		"dist/server/ws/handler.js",
		"dist/server/ws/protocol.js",
	].map((p) => resolve(PROJECT_ROOT, p));

	const missingOutput = outputFiles.some((p) => !existsSync(p));
	const newestSource = Math.max(...sourceFiles.map((p) => statSync(p).mtimeMs));
	const oldestOutput = missingOutput ? 0 : Math.min(...outputFiles.map((p) => statSync(p).mtimeMs));
	if (!missingOutput && oldestOutput >= newestSource) return;

	execSync("npm run build:server", { cwd: PROJECT_ROOT, stdio: "inherit" });
}

ensureFreshServerBuild();

const TOTAL_COST = 2.5;

function costUpdateFor(sessionId: string, totalCost = TOTAL_COST) {
	return (m: WsMsg) =>
		m.type === "cost_update" &&
		m.sessionId === sessionId &&
		m.cost?.totalCost === totalCost;
}

function stateCost(totalCost = TOTAL_COST) {
	return (m: WsMsg) =>
		m.type === "state" &&
		m.data?.serverCost?.totalCost === totalCost;
}

async function seedPersistedCost(gateway: any, sessionId: string, totalCost = TOTAL_COST) {
	await waitForSessionStatus(sessionId, "idle");
	const session = gateway.sessionManager.getSession(sessionId);
	if (!session) throw new Error(`session ${sessionId} not found`);
	const cost = gateway.sessionManager.getCostTracker(session.projectId).recordUsage(sessionId, {
		inputTokens: 9_000,
		outputTokens: 1_000,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: totalCost,
	});
	expect(cost.totalCost).toBe(totalCost);
	return session;
}

function setMockTranscript(gateway: any, sessionId: string, messages: any[]) {
	const session = gateway.sessionManager.getSession(sessionId);
	if (!session) throw new Error(`session ${sessionId} not found`);
	const mockAgent = session.rpcClient?._agent;
	if (!mockAgent || !Array.isArray(mockAgent.conversationMessages)) {
		throw new Error("expected in-process mock agent with conversationMessages");
	}
	mockAgent.conversationMessages = messages;
	return session;
}

async function closeWs(ws: WsConnection) {
	const closed = new Promise<void>((resolve) => ws.ws.once("close", () => resolve()));
	ws.close();
	await closed.catch(() => {});
}

test.setTimeout(30_000);

test.describe("compact cost WS hydration", () => {
	test("hydrates persisted cumulative cost on active attach, get_state, resume fallback, and compaction refresh", async ({ gateway }) => {
		const sessionId = await createSession();
		try {
			await seedPersistedCost(gateway, sessionId);

			const ws = await connectWs(sessionId);
			try {
				await ws.waitFor(costUpdateFor(sessionId), 5_000);
				await ws.waitFor(stateCost(), 5_000);

				const getStateCursor = ws.messageCount();
				ws.send({ type: "get_state" });
				await ws.waitForFrom(getStateCursor, costUpdateFor(sessionId), 5_000);
				await ws.waitForFrom(getStateCursor, stateCost(), 5_000);

				const resumeCursor = ws.messageCount();
				ws.send({ type: "resume", fromSeq: -999 });
				await ws.waitForFrom(resumeCursor, costUpdateFor(sessionId), 5_000);
				await ws.waitForFrom(resumeCursor, (m) => m.type === "resume_gap", 5_000);

				const compactedTranscript = [
					{ id: "u-after", role: "user", content: [{ type: "text", text: "after compaction" }] },
					{
						id: "a-after",
						role: "assistant",
						content: [{ type: "text", text: "visible post-compaction response" }],
						usage: { cost: { total: 0.4 } },
					},
				];
				const session = setMockTranscript(gateway, sessionId, compactedTranscript);
				const refreshCursor = ws.messageCount();
				await gateway.sessionManager.refreshAfterCompaction(session);

				const costFrame = await ws.waitForFrom(refreshCursor, costUpdateFor(sessionId), 5_000);
				const messagesFrame = await ws.waitForFrom(
					refreshCursor,
					(m) => m.type === "messages" && Array.isArray(m.data) && m.data.length === compactedTranscript.length,
					5_000,
				);
				await ws.waitForFrom(refreshCursor, stateCost(), 5_000);

				const costIdx = ws.messages.indexOf(costFrame);
				const messagesIdx = ws.messages.indexOf(messagesFrame);
				expect(costIdx).toBeGreaterThanOrEqual(refreshCursor);
				expect(messagesIdx).toBeGreaterThan(costIdx);
			} finally {
				await closeWs(ws);
			}
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("hydrates archived session state and cost_update when persisted cost exists", async ({ gateway }) => {
		const sessionId = await createSession();
		try {
			await seedPersistedCost(gateway, sessionId);

			const delResp = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
			expect(delResp.ok).toBe(true);
			await pollUntil(async () => {
				const resp = await apiFetch("/api/sessions?include=archived");
				if (!resp.ok) return false;
				const data = await resp.json();
				return Array.isArray(data.sessions) && data.sessions.some((s: any) => s.id === sessionId && s.archived);
			}, { timeoutMs: 5_000, intervalMs: 50, label: "session archived" });

			const ws = await connectWs(sessionId);
			try {
				await ws.waitFor(costUpdateFor(sessionId), 5_000);
				await ws.waitFor((m) => m.type === "state" && m.data?.archived === true && m.data?.serverCost?.totalCost === TOTAL_COST, 5_000);

				const cursor = ws.messageCount();
				ws.send({ type: "get_state" });
				await ws.waitForFrom(cursor, costUpdateFor(sessionId), 5_000);
				await ws.waitForFrom(cursor, (m) => m.type === "state" && m.data?.archived === true && m.data?.serverCost?.totalCost === TOTAL_COST, 5_000);
			} finally {
				await closeWs(ws);
			}
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("does not add serverCost to state when no persisted cost exists", async () => {
		const sessionId = await createSession();
		try {
			const ws = await connectWs(sessionId);
			try {
				const cursor = ws.messageCount();
				ws.send({ type: "get_state" });
				const state = await ws.waitForFrom(cursor, (m) => m.type === "state", 5_000);
				expect(state.data?.serverCost).toBeUndefined();
			} finally {
				await closeWs(ws);
			}
		} finally {
			await deleteSession(sessionId);
		}
	});
});
