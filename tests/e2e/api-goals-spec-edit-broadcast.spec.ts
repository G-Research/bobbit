/**
 * `PUT /api/goals/:id` with a changed `spec` field MUST broadcast a
 * `goal_spec_changed` WS event with `{goalId, prevSpecHash, newSpecHash,
 * prevLen, newLen, ts}`.
 *
 * No-op skips:
 *   - body without a `spec` field → no broadcast
 *   - body with an identical `spec` value → no broadcast
 *
 * The event is broadcast via `broadcastToAll`, so any authenticated WS
 * client receives it (we listen on a goal-bound session for convenience).
 *
 * Negative cases use the "barrier-event" technique to avoid hardcoded
 * sleeps (see no-new-sleeps.mjs): we send a no-op PUT followed by a
 * known-change PUT and assert exactly ONE `goal_spec_changed` event
 * arrives. If the no-op had erroneously emitted, we'd see two.
 */
import { test, expect } from "./in-process-harness.js";
import {
	createGoal,
	createSession,
	deleteGoal,
	deleteSession,
	connectWs,
	apiFetch,
	WsConnection,
} from "./e2e-setup.js";

let goalId: string;
let sessionId: string;
let ws: WsConnection;

test.beforeAll(async () => {
	const goal = await createGoal({ title: "Spec-edit broadcast test", spec: "# initial spec\nfoo bar" });
	goalId = goal.id;
	sessionId = await createSession({ goalId });
	ws = await connectWs(sessionId);
});

test.afterAll(async () => {
	ws?.close();
	await deleteSession(sessionId).catch(() => {});
	await deleteGoal(goalId).catch(() => {});
});

test.describe("PUT /api/goals/:id spec edit broadcasts goal_spec_changed", () => {
	test.describe.configure({ mode: "serial" });

	test("emits goal_spec_changed with correct payload when spec changes", async () => {
		const newSpec = "# updated spec\nfoo bar baz qux";

		const before = ws.messageCount();
		const tBefore = Date.now();

		const resp = await apiFetch(`/api/goals/${goalId}`, {
			method: "PUT",
			body: JSON.stringify({ spec: newSpec }),
		});
		expect(resp.ok).toBe(true);

		const msg = await ws.waitForFrom(
			before,
			(m) => m.type === "goal_spec_changed" && m.goalId === goalId,
			5000,
		);

		expect(msg.type).toBe("goal_spec_changed");
		expect(msg.goalId).toBe(goalId);
		expect(typeof msg.prevSpecHash).toBe("string");
		expect(typeof msg.newSpecHash).toBe("string");
		expect(msg.prevSpecHash).not.toBe(msg.newSpecHash);
		expect(msg.prevSpecHash).toHaveLength(16);
		expect(msg.newSpecHash).toHaveLength(16);
		expect(msg.prevLen).toBe("# initial spec\nfoo bar".length);
		expect(msg.newLen).toBe(newSpec.length);
		expect(typeof msg.ts).toBe("number");
		expect(msg.ts).toBeGreaterThanOrEqual(tBefore);
	});

	test("no-op PUTs (identical spec, missing field) do not broadcast", async () => {
		// Read current spec
		const cur = await apiFetch(`/api/goals/${goalId}`).then((r) => r.json());
		const sameSpec: string = cur.spec;

		const before = ws.messageCount();

		// 1. Identical spec — should NOT broadcast.
		await apiFetch(`/api/goals/${goalId}`, {
			method: "PUT",
			body: JSON.stringify({ spec: sameSpec }),
		}).then((r) => expect(r.ok).toBe(true));

		// 2. No spec field — should NOT broadcast.
		await apiFetch(`/api/goals/${goalId}`, {
			method: "PUT",
			body: JSON.stringify({ title: "Spec-edit broadcast test (renamed)" }),
		}).then((r) => expect(r.ok).toBe(true));

		// 3. BARRIER: a real spec change — DOES broadcast. We use this as the
		//    deterministic event barrier. If either of (1) or (2) had emitted,
		//    `waitForFrom` would have returned that match instead of the
		//    barrier — and we'd see >1 goal_spec_changed events between
		//    `before` and now. Single match = the negative cases were silent.
		const realChange = sameSpec + "\n# barrier change";
		await apiFetch(`/api/goals/${goalId}`, {
			method: "PUT",
			body: JSON.stringify({ spec: realChange }),
		}).then((r) => expect(r.ok).toBe(true));

		const barrier = await ws.waitForFrom(
			before,
			(m) =>
				m.type === "goal_spec_changed" &&
				m.goalId === goalId &&
				m.newLen === realChange.length,
			5000,
		);
		expect(barrier).toBeDefined();

		// Now scan everything received since `before` — only ONE event
		// total (the barrier). The two earlier no-op PUTs must be silent.
		const allEvents = ws.messages
			.slice(before)
			.filter((m) => m.type === "goal_spec_changed" && m.goalId === goalId);
		expect(allEvents).toHaveLength(1);
		expect(allEvents[0]).toBe(barrier);
	});
});
