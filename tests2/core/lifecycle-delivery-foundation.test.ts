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

	it("surfaces a coalesced failure rather than classifying it as a successful duplicate", async () => {
		const values = new Map<string, unknown>();
		const store = memoryStore(values);
		const firstDeadline = createLifecycleDeadline(1_000);
		const secondDeadline = createLifecycleDeadline(1_000);
		let entered!: () => void;
		const started = new Promise<void>(resolve => { entered = resolve; });
		let release!: () => void;
		const blocked = new Promise<void>(resolve => { release = resolve; });
		try {
			const first = deliverLifecycleOnce({
				key: "goalProvisioned:pack:provider:goal:failed-worktree",
				deadline: firstDeadline,
				store,
				deliver: async () => {
					entered();
					await blocked;
					throw Object.assign(new Error("transient provider failure"), { status: 500 });
				},
			});
			await started;
			const second = deliverLifecycleOnce({
				key: "goalProvisioned:pack:provider:goal:failed-worktree",
				deadline: secondDeadline,
				store,
				deliver: async () => { throw new Error("coalesced caller must not deliver"); },
			});
			release();

			await expect(first).resolves.toEqual({ state: "retryable", error: "transient provider failure" });
			await expect(second).resolves.toEqual({ state: "retryable", error: "transient provider failure" });
			expect(values.has(lifecycleDeliveryMarkerKey("goalProvisioned:pack:provider:goal:failed-worktree"))).toBe(false);
		} finally {
			firstDeadline.dispose();
			secondDeadline.dispose();
		}
	});

	it("bounds and redacts provider failure diagnostics", async () => {
		const deadline = createLifecycleDeadline(1_000);
		try {
			const secret = "sk-0123456789abcdefghijklmnopqrstuvwxyz";
			const result = await deliverLifecycleOnce({
				key: "goalProvisioned:pack:provider:goal:diagnostic-worktree",
				deadline,
				deliver: async () => { throw new Error(`request failed with ${secret}: ${"detail ".repeat(100)}`); },
			});
			expect(result.state).toBe("retryable");
			expect(result.error?.length).toBeLessThanOrEqual(500);
			expect(result.error).not.toContain(secret);
			expect(result.error).toContain("<redacted-api-key>");
		} finally {
			deadline.dispose();
		}
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
