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

const FANOUT_EVENT_TIMEOUT_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 120_000;

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

async function waitForWsReady(conn: WsConnection): Promise<void> {
	const cursor = conn.messageCount();
	conn.send({ type: "ping" });
	await conn.waitForFrom(cursor, (m) => m.type === "pong", PONG_TIMEOUT_MS);
}

function connectViewerWs(goalId?: string): Promise<WsConnection> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${wsBase()}/ws/viewer`);
		const messages: WsMsg[] = [];
		const waiters: Array<{ fromIndex: number; pred: (m: WsMsg) => boolean; res: (m: WsMsg) => void; rej: (e: Error) => void; timer: NodeJS.Timeout }> = [];

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
		ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: readE2EToken(), ...(goalId ? { goalId } : {}) })));
		ws.on("error", reject);

		const authTimer = setTimeout(() => reject(new Error("viewer WS auth timeout")), 10_000);
		const authPoll = setInterval(() => {
			if (!messages.some((m) => m.type === "auth_ok")) return;
			clearTimeout(authTimer);
			clearInterval(authPoll);
			const conn: WsConnection = {
				ws,
				messages,
				waitFor(pred, timeoutMs = 15_000) {
					const existing = messages.find(pred);
					if (existing) return Promise.resolve(existing);
					return new Promise((res, rej) => {
						const timer = setTimeout(() => rej(new Error(`viewer WS waitFor timed out (${timeoutMs}ms)`)), timeoutMs);
						waiters.push({ fromIndex: 0, pred, res, rej, timer });
					});
				},
				waitForFrom(fromIndex, pred, timeoutMs = 15_000) {
					const existing = messages.slice(fromIndex).find(pred);
					if (existing) return Promise.resolve(existing);
					return new Promise((res, rej) => {
						const timer = setTimeout(() => rej(new Error(`viewer WS waitForFrom timed out (${timeoutMs}ms)`)), timeoutMs);
						waiters.push({ fromIndex, pred, res, rej, timer });
					});
				},
				messageCount: () => messages.length,
				send: (msg) => ws.send(JSON.stringify(msg)),
				close: () => ws.close(),
			};
			resolve(conn);
		}, 25);
	});
}

test.describe("Goal WebSocket fanout", () => {
	test("subscribed viewer and matching goal session receive goal events while unrelated viewers and sessions do not", async () => {
		test.setTimeout(TEST_TIMEOUT_MS);
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
			await Promise.all([viewerConn, unscopedViewerConn, otherGoalViewerConn, goalConn, unrelatedConn].map(waitForWsReady));

			const viewerCursor = viewerConn.messageCount();
			const unscopedViewerCursor = unscopedViewerConn.messageCount();
			const otherGoalViewerCursor = otherGoalViewerConn.messageCount();
			const goalCursor = goalConn.messageCount();
			const unrelatedCursor = unrelatedConn.messageCount();

			const bypassResp = await bypassGate(goal.id, "design-doc");
			expect(bypassResp.status, await bypassResp.text()).toBe(200);

			const expectedFanout = (m: WsMsg) => m.type === "gate_status_changed" && m.goalId === goal.id && m.gateId === "design-doc" && m.status === "bypassed";
			await Promise.all([
				viewerConn.waitForFrom(viewerCursor, expectedFanout, FANOUT_EVENT_TIMEOUT_MS),
				goalConn.waitForFrom(goalCursor, expectedFanout, FANOUT_EVENT_TIMEOUT_MS),
			]);
			// Drain unrelated sockets after the action. A leaked goal broadcast would be
			// queued before these pong frames on the same socket, so the negative checks
			// below are not racing delivery under suite-level CPU pressure.
			await Promise.all([unscopedViewerConn, otherGoalViewerConn, unrelatedConn].map(waitForWsReady));

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
