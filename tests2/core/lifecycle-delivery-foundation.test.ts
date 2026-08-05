import { describe, expect, it } from "vitest";
import {
	createLifecycleDeadline,
	deliverLifecycleOnce,
	lifecycleDeliveryMarkerKey,
	type LifecycleDeliveryStore,
} from "../../src/server/extension-host/lifecycle-delivery.ts";

function memoryStore(values = new Map<string, unknown>()): LifecycleDeliveryStore {
	return {
		async read(key) {
			return values.has(key) ? { state: "present", value: values.get(key) } : { state: "absent" };
		},
		async put(key, value) { values.set(key, value); },
	};
}

describe("lifecycle delivery foundation", () => {
	it("coalesces concurrent delivery and suppresses replay from its durable marker", async () => {
		const values = new Map<string, unknown>();
		const store = memoryStore(values);
		let deliveries = 0;
		const run = async () => {
			const deadline = createLifecycleDeadline(1_000);
			try {
				return await deliverLifecycleOnce({
					key: "goalProvisioned:pack:provider:goal:worktree",
					deadline,
					store,
					deliver: async () => {
						deliveries++;
						await new Promise(resolve => setTimeout(resolve, 5));
					},
				});
			} finally {
				deadline.dispose();
			}
		};

		const [first, second] = await Promise.all([run(), run()]);
		expect(first.state).toBe("completed");
		expect(second).toEqual({ state: "duplicate", original: "completed" });
		expect(deliveries).toBe(1);

		const replay = await run();
		expect(replay).toEqual({ state: "duplicate" });
		expect(deliveries).toBe(1);
		expect(values.has(lifecycleDeliveryMarkerKey("goalProvisioned:pack:provider:goal:worktree"))).toBe(true);
	});

	it("does not write a completion marker when a deadline expires during delivery", async () => {
		const values = new Map<string, unknown>();
		const deadline = createLifecycleDeadline(10);
		try {
			const result = await deliverLifecycleOnce({
				key: "goalProvisioned:pack:provider:goal:late-worktree",
				deadline,
				store: memoryStore(values),
				deliver: async signal => {
					if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
				},
			});
			expect(result.state).toBe("timed_out");
			expect(values.size).toBe(0);
		} finally {
			deadline.dispose();
		}
	});

	it("classifies non-retryable delivery failures without creating a marker", async () => {
		const values = new Map<string, unknown>();
		const deadline = createLifecycleDeadline(1_000);
		try {
			const result = await deliverLifecycleOnce({
				key: "goalProvisioned:pack:provider:goal:bad-worktree",
				deadline,
				store: memoryStore(values),
				deliver: async () => { throw Object.assign(new Error("bad request"), { status: 400 }); },
			});
			expect(result.state).toBe("terminal");
			expect(values.size).toBe(0);
		} finally {
			deadline.dispose();
		}
	});
});
