import path from "node:path";
import { describe, expect, it } from "vitest";
import { GoalStore, type PersistedGoal } from "../../src/server/agent/goal-store.js";
import { GateStore } from "../../src/server/agent/gate-store.js";
import { GateResetCoordinator } from "../../src/server/agent/gate-reset-intent.js";
import type { Workflow } from "../../src/server/agent/workflow-store.js";
import { createMemFs, type MemFs } from "../harness/mem-fs.js";

const workflow: Workflow = {
	id: "reset-wal",
	name: "Reset WAL",
	description: "",
	createdAt: 1,
	updatedAt: 1,
	gates: [
		{ id: "root", name: "Root", dependsOn: [] },
		{ id: "child", name: "Child", dependsOn: ["root"] },
	],
};

function goal(state: PersistedGoal["state"] = "complete"): PersistedGoal {
	return {
		id: "goal-1",
		title: "Reset WAL fixture",
		cwd: "/workspace",
		state,
		spec: "",
		createdAt: 1,
		updatedAt: 1,
		workflow,
	};
}

function fixture(memfs = createMemFs(), suffix = Math.random().toString(36).slice(2)): {
	memfs: MemFs;
	stateDir: string;
	goals: GoalStore;
	gates: GateStore;
	coordinator: GateResetCoordinator;
} {
	const stateDir = path.resolve("/memfs/gate-reset-intent", suffix);
	memfs.mkdirSync(stateDir, { recursive: true });
	const goals = new GoalStore(stateDir, memfs);
	const gates = new GateStore(stateDir, memfs);
	if (!goals.get("goal-1")) goals.put(goal());
	if (gates.getGatesForGoal("goal-1").length === 0) {
		gates.initGatesForGoal("goal-1", ["root", "child"]);
		gates.updateGateStatus("goal-1", "root", "passed");
		gates.updateGateStatus("goal-1", "child", "passed");
	}
	const coordinator = new GateResetCoordinator(stateDir, goals, gates, memfs);
	return { memfs, stateDir, goals, gates, coordinator };
}

function beginReset(ctx: ReturnType<typeof fixture>) {
	return ctx.coordinator.begin({
		goalId: "goal-1",
		gateId: "root",
		affectedGateIds: ["root", "child"],
		previousStatuses: { root: "passed", child: "passed" },
		previousState: "complete",
		reopenRequired: true,
	}).intent;
}

function restart(ctx: ReturnType<typeof fixture>) {
	const goals = new GoalStore(ctx.stateDir, ctx.memfs);
	const gates = new GateStore(ctx.stateDir, ctx.memfs);
	const coordinator = new GateResetCoordinator(ctx.stateDir, goals, gates, ctx.memfs);
	return { ...ctx, goals, gates, coordinator };
}

function expectRecovered(ctx: ReturnType<typeof fixture>): void {
	expect(ctx.goals.get("goal-1")?.state).toBe("in-progress");
	expect(ctx.gates.getGate("goal-1", "root")?.status).toBe("pending");
	expect(ctx.gates.getGate("goal-1", "child")?.status).toBe("pending");
	expect(ctx.coordinator.intents.getAll()).toEqual([]);
}

describe("durable gate-reset intent", () => {
	it.each(["after-intent", "after-goal", "after-gates"] as const)(
		"idempotently recovers a restart %s",
		(phase) => {
			let ctx = fixture();
			const intent = beginReset(ctx);
			if (phase === "after-goal" || phase === "after-gates") {
				ctx.goals.updateStrict("goal-1", { state: "in-progress" });
			}
			if (phase === "after-gates") {
				ctx.gates.resetGateAndDependentsStrict("goal-1", "root", workflow);
			}

			ctx = restart(ctx);
			expectRecovered(ctx);
			// A second restart proves replay/clear is idempotent.
			expectRecovered(restart(ctx));
			expect(intent.goalId).toBe("goal-1");
		},
	);

	it.each(["goal", "gate", "intent"] as const)("propagates and rolls back a strict %s write failure", (target) => {
		const ctx = fixture();
		const originalRename = ctx.memfs.renameSync.bind(ctx.memfs) as (...args: any[]) => void;
		let failed = false;
		(ctx.memfs as any).renameSync = (from: string, to: string) => {
			if (!failed && String(to).endsWith(target === "goal" ? "goals.json" : target === "gate" ? "gates.json" : "gate-reset-intents.json")) {
				failed = true;
				throw new Error(`injected ${target} write failure`);
			}
			originalRename(from, to);
		};

		if (target === "intent") {
			expect(() => beginReset(ctx)).toThrow(/injected intent write failure/);
			expect(ctx.coordinator.intents.getAll()).toEqual([]);
			expect(ctx.goals.get("goal-1")?.state).toBe("complete");
			return;
		}

		const intent = beginReset(ctx);
		if (target === "goal") {
			expect(() => ctx.coordinator.commitDurable(intent, workflow)).toThrow(/injected goal write failure/);
			expect(ctx.goals.get("goal-1")?.state).toBe("complete");
			expect(ctx.gates.getGate("goal-1", "root")?.status).toBe("passed");
		} else {
			expect(() => ctx.coordinator.commitDurable(intent, workflow)).toThrow(/injected gate write failure/);
			expect(ctx.goals.get("goal-1")?.state).toBe("in-progress");
			expect(ctx.gates.getGate("goal-1", "root")?.status).toBe("passed");
		}
		expect(ctx.coordinator.intents.get("goal-1")?.id).toBe(intent.id);
	});

	it("retains a fully committed intent when final clear fails, then clears it on restart", () => {
		let ctx = fixture();
		const intent = beginReset(ctx);
		ctx.coordinator.commitDurable(intent, workflow);
		const originalRename = ctx.memfs.renameSync.bind(ctx.memfs) as (...args: any[]) => void;
		let failed = false;
		(ctx.memfs as any).renameSync = (from: string, to: string) => {
			if (!failed && String(to).endsWith("gate-reset-intents.json")) {
				failed = true;
				throw new Error("injected intent clear failure");
			}
			originalRename(from, to);
		};

		expect(() => ctx.coordinator.complete(intent)).toThrow(/injected intent clear failure/);
		expect(ctx.coordinator.intents.get("goal-1")?.id).toBe(intent.id);
		expect(ctx.goals.get("goal-1")?.state).toBe("in-progress");
		expect(ctx.gates.getGate("goal-1", "root")?.status).toBe("pending");

		ctx = restart(ctx);
		expectRecovered(ctx);
	});

	it("does not reopen a goal made dormant before boot recovery", () => {
		let ctx = fixture();
		beginReset(ctx);
		ctx.goals.updateStrict("goal-1", { paused: true });
		ctx = restart(ctx);
		expect(ctx.goals.get("goal-1")).toMatchObject({ state: "complete", paused: true });
		expect(ctx.gates.getGate("goal-1", "root")?.status).toBe("passed");
		expect(ctx.coordinator.intents.getAll()).toEqual([]);
	});
});
