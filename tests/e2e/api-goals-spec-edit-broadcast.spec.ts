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

		const before = ws.messages.length;
		const tBefore = Date.now();

		const resp = await apiFetch(`/api/goals/${goalId}`, {
			method: "PUT",
			body: JSON.stringify({ spec: newSpec }),
		});
		expect(resp.ok).toBe(true);

		const msg = await ws.waitFor(
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

		// Sanity: only ONE goal_spec_changed event was emitted (no duplicate).
		const matches = ws.messages
			.slice(before)
			.filter((m) => m.type === "goal_spec_changed" && m.goalId === goalId);
		expect(matches).toHaveLength(1);
	});

	test("is a no-op when the body contains an identical spec", async () => {
		// Read current spec to PUT the same value back.
		const cur = await apiFetch(`/api/goals/${goalId}`).then((r) => r.json());
		const sameSpec: string = cur.spec;

		const before = ws.messages.length;
		const resp = await apiFetch(`/api/goals/${goalId}`, {
			method: "PUT",
			body: JSON.stringify({ spec: sameSpec }),
		});
		expect(resp.ok).toBe(true);

		// Wait a beat to give any erroneous broadcast a chance to arrive.
		await new Promise((r) => setTimeout(r, 250));
		const matches = ws.messages
			.slice(before)
			.filter((m) => m.type === "goal_spec_changed" && m.goalId === goalId);
		expect(matches).toHaveLength(0);
	});

	test("is a no-op when the body omits the spec field", async () => {
		const before = ws.messages.length;
		const resp = await apiFetch(`/api/goals/${goalId}`, {
			method: "PUT",
			body: JSON.stringify({ title: "Spec-edit broadcast test (renamed)" }),
		});
		expect(resp.ok).toBe(true);

		await new Promise((r) => setTimeout(r, 250));
		const matches = ws.messages
			.slice(before)
			.filter((m) => m.type === "goal_spec_changed" && m.goalId === goalId);
		expect(matches).toHaveLength(0);
	});
});
