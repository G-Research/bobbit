import path from "node:path";
import { describe, expect, it } from "vitest";
import { GoalStore, type PersistedGoal } from "../../../../src/server/agent/goal-store.js";
import { GateStore } from "../../../../src/server/agent/gate-store.js";
import { GateResetCoordinator } from "../../../../src/server/agent/gate-reset-intent.js";
import type { Workflow } from "../../../../src/server/agent/workflow-store.js";
import { createMemFs, type MemFs } from "../../../../tests2/harness/mem-fs.js";

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

function goal(state: PersistedGoal["state"] = "complete", id = "goal-1"): PersistedGoal {
	return {
		id,
		title: `Reset WAL fixture ${id}`,
		cwd: "/workspace",
		state,
		spec: "",
		createdAt: 1,
		updatedAt: 1,
		workflow,
	};
}

type Fixture = {
	memfs: MemFs;
	stateDir: string;
	goals: GoalStore;
	gates: GateStore;
	coordinator: GateResetCoordinator;
};

async function fixture(memfs = createMemFs(), suffix = Math.random().toString(36).slice(2)): Promise<Fixture> {
	const stateDir = path.resolve("/memfs/gate-reset-intent", suffix);
	memfs.mkdirSync(stateDir, { recursive: true });
	const goals = new GoalStore(stateDir, memfs);
	const gates = new GateStore(stateDir, memfs, { persistence: "json" });
	if (!goals.get("goal-1")) goals.put(goal());
	if (gates.getGatesForGoal("goal-1").length === 0) {
		gates.initGatesForGoal("goal-1", ["root", "child"]);
		gates.updateGateStatus("goal-1", "root", "passed");
		gates.updateGateStatus("goal-1", "child", "passed");
	}
	// The explicit barrier models a completed startup write before tests
	// simulate a process restart; normal hot-path mutations remain coalesced.
	await Promise.all([goals.flush(), gates.flush()]);
	const coordinator = new GateResetCoordinator(stateDir, goals, gates, memfs);
	return { memfs, stateDir, goals, gates, coordinator };
}

function beginReset(ctx: Fixture) {
	return ctx.coordinator.begin({
		goalId: "goal-1",
		gateId: "root",
		affectedGateIds: ["root", "child"],
		previousStatuses: { root: "passed", child: "passed" },
		previousState: "complete",
		reopenRequired: true,
	}).intent;
}

async function restart(ctx: Fixture): Promise<Fixture> {
	const goals = new GoalStore(ctx.stateDir, ctx.memfs);
	const gates = new GateStore(ctx.stateDir, ctx.memfs, { persistence: "json" });
	const coordinator = new GateResetCoordinator(ctx.stateDir, goals, gates, ctx.memfs);
	await coordinator.recovery;
	return { ...ctx, goals, gates, coordinator };
}

function expectRecovered(ctx: Fixture): void {
	expect(ctx.goals.get("goal-1")?.state).toBe("in-progress");
	expect(ctx.gates.getGate("goal-1", "root")?.status).toBe("pending");
	expect(ctx.gates.getGate("goal-1", "child")?.status).toBe("pending");
	expect(ctx.coordinator.intents.getAll()).toEqual([]);
}

describe("durable gate-reset intent", () => {
	it.each(["after-intent", "after-goal", "after-gates"] as const)(
		"idempotently recovers a restart %s",
		async (phase) => {
			let ctx = await fixture();
			const intent = beginReset(ctx);
			if (phase === "after-goal" || phase === "after-gates") {
				await ctx.goals.updateStrict("goal-1", { state: "in-progress" });
			}
			if (phase === "after-gates") {
				await ctx.gates.resetGateAndDependentsStrict("goal-1", "root", workflow);
			}

			ctx = await restart(ctx);
			expectRecovered(ctx);
			// A second restart proves replay/clear is idempotent.
			expectRecovered(await restart(ctx));
			expect(intent.goalId).toBe("goal-1");
		},
	);

	it("makes every retained reset pending synchronously before strict recovery publishes", async () => {
		const ctx = await fixture();
		ctx.goals.put(goal("complete", "goal-2"));
		ctx.gates.initGatesForGoal("goal-2", ["root", "child"]);
		ctx.gates.updateGateStatus("goal-2", "root", "passed");
		ctx.gates.updateGateStatus("goal-2", "child", "passed");
		await Promise.all([ctx.goals.flush(), ctx.gates.flush()]);

		const first = beginReset(ctx);
		const second = ctx.coordinator.begin({
			goalId: "goal-2",
			gateId: "root",
			affectedGateIds: ["root", "child"],
			previousStatuses: { root: "passed", child: "passed" },
			previousState: "complete",
			reopenRequired: false,
		}).intent;

		const goals = new GoalStore(ctx.stateDir, ctx.memfs);
		const gates = new GateStore(ctx.stateDir, ctx.memfs, { persistence: "json" });
		const coordinator = new GateResetCoordinator(ctx.stateDir, goals, gates, ctx.memfs);

		// No await: construction must restore all WAL intent state before the
		// first strict goal/gate publication yields to the event loop.
		expect(goals.get("goal-1")?.state).toBe("in-progress");
		expect(gates.getGate("goal-1", "root")?.status).toBe("pending");
		expect(gates.getGate("goal-1", "child")?.status).toBe("pending");
		expect(goals.get("goal-2")?.state).toBe("complete");
		expect(gates.getGate("goal-2", "root")?.status).toBe("pending");
		expect(gates.getGate("goal-2", "child")?.status).toBe("pending");

		await coordinator.recovery;
		expect(coordinator.intents.getAll()).toEqual([]);

		const recovered = await restart({ ...ctx, goals, gates, coordinator });
		expectRecovered(recovered);
		expect(recovered.goals.get("goal-2")?.state).toBe("complete");
		expect(recovered.gates.getGate("goal-2", "root")?.status).toBe("pending");
		expect(recovered.gates.getGate("goal-2", "child")?.status).toBe("pending");
		expect(first.goalId).toBe("goal-1");
		expect(second.goalId).toBe("goal-2");
	});

	it("keeps gate persistence behind a failed recovery goal fence", async () => {
		const ctx = await fixture();
		beginReset(ctx);
		const originalRename = ctx.memfs.promises.rename.bind(ctx.memfs.promises);
		(ctx.memfs.promises as any).rename = async (from: string, to: string) => {
			if (String(to).endsWith("goals.json")) throw new Error("injected recovery goal write failure");
			return originalRename(from, to);
		};

		const goals = new GoalStore(ctx.stateDir, ctx.memfs);
		const gates = new GateStore(ctx.stateDir, ctx.memfs, { persistence: "json" });
		const coordinator = new GateResetCoordinator(ctx.stateDir, goals, gates, ctx.memfs);
		expect(gates.getGate("goal-1", "root")?.status).toBe("pending");
		await coordinator.recovery;
		expect(coordinator.intents.get("goal-1")).toBeTruthy();

		(ctx.memfs.promises as any).rename = originalRename;
		const durableGoals = new GoalStore(ctx.stateDir, ctx.memfs);
		const durableGates = new GateStore(ctx.stateDir, ctx.memfs, { persistence: "json" });
		expect(durableGoals.get("goal-1")?.state).toBe("complete");
		expect(durableGates.getGate("goal-1", "root")?.status).toBe("passed");
		expect(durableGates.getGate("goal-1", "child")?.status).toBe("passed");
	});

	it("rejects an explicit gate barrier when atomic rename fails", async () => {
		const ctx = await fixture();
		const originalRename = ctx.memfs.promises.rename.bind(ctx.memfs.promises);
		(ctx.memfs.promises as any).rename = async (from: string, to: string) => {
			if (String(to).endsWith("gates.json")) throw new Error("injected async gate rename failure");
			return originalRename(from, to);
		};
		ctx.gates.updateGateStatus("goal-1", "root", "pending");
		await expect(ctx.gates.flush()).rejects.toThrow(/injected async gate rename failure/);
	});

	it.each(["goal", "gate", "intent"] as const)("propagates and rolls back a strict %s write failure", async (target) => {
		const ctx = await fixture();
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
			await expect(ctx.coordinator.commitDurable(intent, workflow)).rejects.toThrow(/injected goal write failure/);
			expect(ctx.goals.get("goal-1")?.state).toBe("complete");
			expect(ctx.gates.getGate("goal-1", "root")?.status).toBe("passed");
		} else {
			await expect(ctx.coordinator.commitDurable(intent, workflow)).rejects.toThrow(/injected gate write failure/);
			expect(ctx.goals.get("goal-1")?.state).toBe("in-progress");
			expect(ctx.gates.getGate("goal-1", "root")?.status).toBe("passed");
		}
		expect(ctx.coordinator.intents.get("goal-1")?.id).toBe(intent.id);
	});

	it("fences an older async gate rename behind the strict reset before clearing its WAL", async () => {
		let ctx = await fixture();
		const originalRename = ctx.memfs.promises.rename.bind(ctx.memfs.promises);
		let releaseOlderRename: (() => void) | undefined;
		let olderRenameStarted: (() => void) | undefined;
		const olderRenameStartedPromise = new Promise<void>(resolve => { olderRenameStarted = resolve; });
		const releaseOlderRenamePromise = new Promise<void>(resolve => { releaseOlderRename = resolve; });
		let holdOnce = true;
		(ctx.memfs.promises as any).rename = async (from: string, to: string) => {
			if (holdOnce && String(to).endsWith("gates.json")) {
				holdOnce = false;
				olderRenameStarted!();
				await releaseOlderRenamePromise;
			}
			return originalRename(from, to);
		};

		// Start an ordinary publication containing passed gates, then reset while
		// its rename is in flight. The strict reset must publish after it.
		ctx.gates.updateGateStatus("goal-1", "root", "passed");
		const olderFlush = ctx.gates.flush();
		await olderRenameStartedPromise;
		const intent = beginReset(ctx);
		const commit = ctx.coordinator.commitDurable(intent, workflow);
		releaseOlderRename!();
		await olderFlush;
		await commit;
		ctx.coordinator.complete(intent);

		ctx = await restart(ctx);
		expectRecovered(ctx);
	});

	it("retains a fully committed intent when final clear fails, then clears it on restart", async () => {
		let ctx = await fixture();
		const intent = beginReset(ctx);
		await ctx.coordinator.commitDurable(intent, workflow);
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

		ctx = await restart(ctx);
		expectRecovered(ctx);
	});

	it("does not reopen a goal made dormant before boot recovery", async () => {
		let ctx = await fixture();
		beginReset(ctx);
		await ctx.goals.updateStrict("goal-1", { paused: true });
		ctx = await restart(ctx);
		expect(ctx.goals.get("goal-1")).toMatchObject({ state: "complete", paused: true });
		expect(ctx.gates.getGate("goal-1", "root")?.status).toBe("passed");
		expect(ctx.coordinator.intents.getAll()).toEqual([]);
	});
});
