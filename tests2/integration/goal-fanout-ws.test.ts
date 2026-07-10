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

function isGoalBroadcast(msg: WsMsg, goalId: string): boolean {
	return msg.goalId === goalId && typeof msg.type === "string" && (
		msg.type.startsWith("gate_") || msg.type.startsWith("team_") || msg.type.startsWith("goal_")
	);
}

function connectViewerWs(goalId?: string): Promise<WsConnection> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${wsBase()}/ws/viewer`);
		const messages: WsMsg[] = [];
		const waiters: Array<{ fromIndex: number; pred: (m: WsMsg) => boolean; res: (m: WsMsg) => void; rej: (e: Error) => void; timer: NodeJS.Timeout }> = [];
		let settled = false;

		function waitForFrom(fromIndex: number, pred: (m: WsMsg) => boolean, timeoutMs = 15_000): Promise<WsMsg> {
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
				waitFor(pred, timeoutMs = 15_000) {
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

		void waitForFrom(0, (m) => m.type === "auth_ok", 10_000)
			.then(async () => {
				const cursor = messages.length;
				if (goalId) ws.send(JSON.stringify({ type: "subscribe_goal", goalId }));
				ws.send(JSON.stringify({ type: "ping" }));
				await waitForFrom(cursor, (m) => m.type === "pong", 10_000);
				if (settled) return;
				settled = true;
				resolve(buildConnection());
			})
			.catch(fail);
	});
}

test.describe("Goal WebSocket fanout", () => {
	test("subscribed viewer and matching goal session receive goal events while unrelated viewers and sessions do not", async () => {
		const goal = await createGoal({ title: `Goal fanout WS ${Date.now()}`, workflowId: "test-fast" });
		const otherGoal = await createGoal({ title: `Other fanout WS ${Date.now()}`, workflowId: "test-fast" });
		const goalSessionId = await createSession({ goalId: goal.id });
		const unrelatedSessionId = await createSession();
		const viewerConn = await connectViewerWs(goal.id);
		const unscopedViewerConn = await connectViewerWs();
		const otherGoalViewerConn = await connectViewerWs(otherGoal.id);
		const goalConn = await connectWs(goalSessionId);
		const unrelatedConn = await connectWs(unrelatedSessionId);

		try {
			const viewerCursor = viewerConn.messageCount();
			const unscopedViewerCursor = unscopedViewerConn.messageCount();
			const otherGoalViewerCursor = otherGoalViewerConn.messageCount();
			const goalCursor = goalConn.messageCount();
			const unrelatedCursor = unrelatedConn.messageCount();

			const signalResp = await apiFetch(`/api/goals/${goal.id}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design\n\nApproach: test\n\nFiles: src/test.ts\n\nCriteria: pass" }),
			});
			expect(signalResp.status).toBe(201);

			await Promise.all([
				viewerConn.waitForFrom(viewerCursor, (m) => m.type === "gate_signal_received" && m.goalId === goal.id && m.gateId === "design-doc"),
				goalConn.waitForFrom(goalCursor, (m) => m.type === "gate_signal_received" && m.goalId === goal.id && m.gateId === "design-doc"),
			]);
			await Promise.all([
				viewerConn.waitForFrom(viewerCursor, (m) => m.type === "gate_status_changed" && m.goalId === goal.id && m.gateId === "design-doc" && m.status === "passed"),
				goalConn.waitForFrom(goalCursor, (m) => m.type === "gate_status_changed" && m.goalId === goal.id && m.gateId === "design-doc" && m.status === "passed"),
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
