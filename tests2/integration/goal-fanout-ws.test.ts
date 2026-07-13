import { expect } from "./_e2e/in-process-harness.js";
import WebSocket from "ws";
import { test } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	connectWs,
	createGoal,
	createSession,
	deleteGoal,
	deleteSession,
	readE2EToken,
	wsBase,
	type WsConnection,
	type WsMsg,
} from "./_e2e/e2e-setup.js";

const FANOUT_WS_READY_TIMEOUT_MS = 30_000;
const FANOUT_WS_EVENT_TIMEOUT_MS = 60_000;
const FANOUT_TEST_TIMEOUT_MS = 120_000;

function isGoalBroadcast(msg: WsMsg, goalId: string): boolean {
	return msg.goalId === goalId && typeof msg.type === "string" && (
		msg.type.startsWith("gate_") || msg.type.startsWith("team_") || msg.type.startsWith("goal_")
	);
}

async function waitForGoalSetupReady(goalId: string, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastStatus = "unknown";
	while (Date.now() < deadline) {
		const res = await apiFetch(`/api/goals/${goalId}`);
		if (res.ok) {
			const goal = await res.json();
			lastStatus = goal?.setupStatus ?? "missing";
			if (goal?.setupStatus === "ready") return;
			if (goal?.setupStatus === "error") throw new Error(`Goal ${goalId} setup failed: ${JSON.stringify(goal)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Goal ${goalId} setup did not become ready within ${timeoutMs}ms (last status: ${lastStatus})`);
}

async function bypassGate(goalId: string, gateId: string): Promise<Response> {
	return apiFetch(`/api/goals/${goalId}/gates/${gateId}/bypass`, {
		method: "POST",
		body: JSON.stringify({
			whyBypassed: "Fanout routing test uses bypass to avoid command-runner timing noise",
			whoAmI: "goal-fanout-ws.test.ts",
			isInitiatedByHuman: true,
		}),
	});
}

function connectViewerWs(goalId?: string): Promise<WsConnection> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${wsBase()}/ws/viewer`);
		const messages: WsMsg[] = [];
		const waiters: Array<{ fromIndex: number; pred: (m: WsMsg) => boolean; res: (m: WsMsg) => void; rej: (e: Error) => void; timer: NodeJS.Timeout }> = [];
		let settled = false;

		function waitForFrom(fromIndex: number, pred: (m: WsMsg) => boolean, timeoutMs = FANOUT_WS_EVENT_TIMEOUT_MS): Promise<WsMsg> {
			const existing = messages.slice(fromIndex).find(pred);
			if (existing) return Promise.resolve(existing);
			return new Promise((res, rej) => {
				const timer = setTimeout(() => {
					const idx = waiters.findIndex((w) => w.timer === timer);
					if (idx >= 0) waiters.splice(idx, 1);
					rej(new Error(`viewer WS waitForFrom timed out (${timeoutMs}ms)`));
				}, timeoutMs);
				waiters.push({ fromIndex, pred, res, rej, timer });
			});
		}

		function fail(error: Error): void {
			if (settled) return;
			settled = true;
			for (const waiter of waiters.splice(0)) {
				clearTimeout(waiter.timer);
				waiter.rej(error);
			}
			reject(error);
		}

		function buildConnection(): WsConnection {
			return {
				ws,
				messages,
				waitFor(pred, timeoutMs = FANOUT_WS_EVENT_TIMEOUT_MS) {
					return waitForFrom(0, pred, timeoutMs);
				},
				waitForFrom,
				messageCount: () => messages.length,
				send: (msg) => ws.send(JSON.stringify(msg)),
				close: () => ws.close(),
			};
		}

		ws.on("message", (raw) => {
			const msg: WsMsg = JSON.parse(raw.toString());
			messages.push(msg);
			for (let i = waiters.length - 1; i >= 0; i--) {
				const waiter = waiters[i];
				if (messages.length - 1 >= waiter.fromIndex && waiter.pred(msg)) {
					clearTimeout(waiter.timer);
					waiter.res(msg);
					waiters.splice(i, 1);
				}
			}
		});
		ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: readE2EToken() })));
		ws.on("error", fail);
		ws.on("close", () => fail(new Error("viewer WS closed before ready")));

		void waitForFrom(0, (m) => m.type === "auth_ok", FANOUT_WS_READY_TIMEOUT_MS)
			.then(async () => {
				const cursor = messages.length;
				if (goalId) ws.send(JSON.stringify({ type: "subscribe_goal", goalId }));
				ws.send(JSON.stringify({ type: "ping" }));
				await waitForFrom(cursor, (m) => m.type === "pong", FANOUT_WS_READY_TIMEOUT_MS);
				if (settled) return;
				settled = true;
				resolve(buildConnection());
			})
			.catch(fail);
	});
}

async function waitForWsRoundTrip(conn: WsConnection, timeoutMs = FANOUT_WS_EVENT_TIMEOUT_MS): Promise<void> {
	const cursor = conn.messageCount();
	conn.send({ type: "ping" });
	await conn.waitForFrom(cursor, (m) => m.type === "pong", timeoutMs);
}

test.setTimeout(180_000);

test.describe("Goal WebSocket fanout", () => {
	test.setTimeout(FANOUT_TEST_TIMEOUT_MS);

	test("subscribed viewer and matching goal session receive goal events while unrelated viewers and sessions do not", async () => {
		const goal = await createGoal({ title: `Goal fanout WS ${Date.now()}`, workflowId: "test-fast", team: false, autoStartTeam: false });
		const otherGoal = await createGoal({ title: `Other fanout WS ${Date.now()}`, workflowId: "test-fast", team: false, autoStartTeam: false });
		await Promise.all([waitForGoalSetupReady(goal.id), waitForGoalSetupReady(otherGoal.id)]);

		const goalSessionId = await createSession({ goalId: goal.id });
		const unrelatedSessionId = await createSession();
		const [viewerConn, unscopedViewerConn, otherGoalViewerConn, goalConn, unrelatedConn] = await Promise.all([
			connectViewerWs(goal.id),
			connectViewerWs(),
			connectViewerWs(otherGoal.id),
			connectWs(goalSessionId),
			connectWs(unrelatedSessionId),
		]);

		try {
			await Promise.all([
				waitForWsRoundTrip(viewerConn),
				waitForWsRoundTrip(unscopedViewerConn),
				waitForWsRoundTrip(otherGoalViewerConn),
				waitForWsRoundTrip(goalConn),
				waitForWsRoundTrip(unrelatedConn),
			]);

			const viewerCursor = viewerConn.messageCount();
			const unscopedViewerCursor = unscopedViewerConn.messageCount();
			const otherGoalViewerCursor = otherGoalViewerConn.messageCount();
			const goalCursor = goalConn.messageCount();
			const unrelatedCursor = unrelatedConn.messageCount();

			const bypassResp = await bypassGate(goal.id, "design-doc");
			expect(bypassResp.status, await bypassResp.text()).toBe(200);

			const expectedFanout = (m: WsMsg) => m.type === "gate_status_changed" && m.goalId === goal.id && m.gateId === "design-doc" && m.status === "bypassed";
			await Promise.all([
				viewerConn.waitForFrom(viewerCursor, expectedFanout, FANOUT_WS_EVENT_TIMEOUT_MS),
				goalConn.waitForFrom(goalCursor, expectedFanout, FANOUT_WS_EVENT_TIMEOUT_MS),
			]);
			// Drain unrelated sockets after the action. A leaked goal broadcast would be
			// queued before these pong frames on the same socket, so the negative checks
			// below are not racing delivery under suite-level CPU pressure.
			await Promise.all([
				waitForWsRoundTrip(unrelatedConn),
				waitForWsRoundTrip(unscopedViewerConn),
				waitForWsRoundTrip(otherGoalViewerConn),
			]);

			const unrelatedGoalMessages = unrelatedConn.messages.slice(unrelatedCursor).filter((m) => isGoalBroadcast(m, goal.id));
			const unscopedViewerGoalMessages = unscopedViewerConn.messages.slice(unscopedViewerCursor).filter((m) => isGoalBroadcast(m, goal.id));
			const otherGoalViewerGoalMessages = otherGoalViewerConn.messages.slice(otherGoalViewerCursor).filter((m) => isGoalBroadcast(m, goal.id));
			expect(unrelatedGoalMessages).toEqual([]);
			expect(unscopedViewerGoalMessages).toEqual([]);
			expect(otherGoalViewerGoalMessages).toEqual([]);
		} finally {
			viewerConn.close();
			unscopedViewerConn.close();
			otherGoalViewerConn.close();
			goalConn.close();
			unrelatedConn.close();
			await deleteSession(goalSessionId);
			await deleteSession(unrelatedSessionId);
			await deleteGoal(goal.id);
			await deleteGoal(otherGoal.id);
		}
	});
});
