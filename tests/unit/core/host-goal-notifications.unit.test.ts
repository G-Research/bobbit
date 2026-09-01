import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalManager } from "../../../src/server/agent/goal-manager.js";
import {
	GoalStore,
	type GoalStoreNotification,
	type PersistedGoal,
} from "../../../src/server/agent/goal-store.js";
import { HostNotificationDispatcher } from "../../../src/server/extension-host/host-notification-dispatcher.js";
import type { HostNotification } from "../../../src/shared/extension-host/host-hooks.js";
import { createMemFs, type MemFs } from "../../../tests/support/harnesses/shared/mem-fs.js";

const stores: GoalStore[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.allSettled(stores.splice(0).map(store => store.close()));
});

function fixture(suffix: string): { memfs: MemFs; stateDir: string; store: GoalStore; manager: GoalManager } {
	const memfs = createMemFs();
	const stateDir = path.resolve("/memfs/host-goal-notifications", suffix);
	memfs.mkdirSync(stateDir, { recursive: true });
	const store = new GoalStore(stateDir, memfs, { persistence: "json" });
	stores.push(store);
	return { memfs, stateDir, store, manager: new GoalManager(store, undefined, stateDir) };
}

function goal(id: string, overrides: Partial<PersistedGoal> = {}): PersistedGoal {
	return {
		id,
		title: `Goal ${id}`,
		cwd: `/work/${id}`,
		state: "todo",
		spec: "",
		createdAt: 100,
		updatedAt: 100,
		setupStatus: "ready",
		projectId: "project-a",
		...overrides,
	};
}

function durableGoal(memfs: MemFs, stateDir: string, id: string): PersistedGoal | undefined {
	const rows = JSON.parse(memfs.readFileSync(path.join(stateDir, "goals.json"), "utf-8")) as PersistedGoal[];
	return rows.find(row => row.id === id);
}

function captureDispatchedGoals(store: GoalStore): {
	notifications: HostNotification[];
	dispatcher: HostNotificationDispatcher;
} {
	const notifications: HostNotification[] = [];
	let nextId = 0;
	const dispatcher = new HostNotificationDispatcher({
		idGenerator: () => `goal-notification-${++nextId}`,
		now: () => 1_000,
	});
	store.onHostNotification = fact => {
		const common = { projectId: "project-a", aggregateRevision: fact.revision };
		let notification: HostNotification | undefined;
		switch (fact.name) {
			case "goalCreated":
				notification = dispatcher.publish("goalCreated", { ...common, aggregateId: fact.payload.goalId, payload: fact.payload });
				break;
			case "goalUpdated":
				notification = dispatcher.publish("goalUpdated", {
					...common,
					aggregateId: fact.payload.goalId,
					payload: { ...fact.payload, changedFields: [...fact.payload.changedFields] },
				});
				break;
			case "goalCompleted":
				notification = dispatcher.publish("goalCompleted", { ...common, aggregateId: fact.payload.goalId, payload: fact.payload });
				break;
			case "goalArchived":
				notification = dispatcher.publish("goalArchived", { ...common, aggregateId: fact.payload.goalId, payload: fact.payload });
				break;
		}
		if (notification) notifications.push(notification);
	};
	return { notifications, dispatcher };
}

describe("authoritative goal host notifications", () => {
	it("publishes create only after the strict record commit while legacy callbacks remain independent", async () => {
		const { memfs, stateDir, store, manager } = fixture("create");
		const hostFacts: GoalStoreNotification[] = [];
		const legacy: string[] = [];
		store.onIndexUpdate = () => { legacy.push("index"); };
		store.onGoalCreated = () => { legacy.push("goal-created"); };
		store.onHostNotification = fact => {
			hostFacts.push(fact);
			expect(durableGoal(memfs, stateDir, fact.payload.goalId)?.updatedAt).toBe(fact.revision);
		};

		const created = await manager.createGoal("Strict create", "/workspace", {
			projectId: "headquarters",
			worktree: false,
		});

		expect(hostFacts).toEqual([{
			name: "goalCreated",
			revision: created.updatedAt,
			payload: { goalId: created.id, state: "todo" },
		}]);
		expect(legacy).toEqual(["index", "goal-created"]);
	});

	it("suppresses no-ops and emits monotonic update then genuine completion facts", async () => {
		const { memfs, stateDir, store, manager } = fixture("update-complete");
		await store.putStrict(goal("child", { parentGoalId: "parent", updatedAt: 500 }));
		const facts: GoalStoreNotification[] = [];
		store.onHostNotification = fact => {
			facts.push(fact);
			expect(durableGoal(memfs, stateDir, "child")?.updatedAt).toBeGreaterThanOrEqual(fact.revision);
		};
		vi.spyOn(Date, "now").mockReturnValue(100);

		expect(await manager.updateGoal("child", { title: "Changed", spec: "private body" })).toBe(true);
		const firstRevision = store.get("child")!.updatedAt;
		expect(firstRevision).toBe(501);
		expect(await manager.updateGoal("child", { title: "Changed", spec: "private body" })).toBe(true);
		expect(store.get("child")!.updatedAt).toBe(firstRevision);
		expect(await manager.updateGoal("child", { state: "complete" })).toBe(true);
		expect(await manager.updateGoal("child", { state: "complete" })).toBe(true);

		expect(facts.map(fact => fact.name)).toEqual(["goalUpdated", "goalUpdated", "goalCompleted"]);
		expect(facts[0]).toMatchObject({
			revision: 501,
			payload: { goalId: "child", state: "todo", changedFields: ["spec", "title"] },
		});
		expect(JSON.stringify(facts)).not.toContain("private body");
		expect(facts[1].revision).toBe(502);
		expect(facts[2]).toEqual({
			name: "goalCompleted",
			revision: 502,
			payload: { goalId: "child", parentGoalId: "parent" },
		});
	});

	it("omits internal setup metadata while the real dispatcher accepts the committed update", async () => {
		const { store } = fixture("public-projection");
		await store.putStrict(goal("goal-1"));
		const { notifications, dispatcher } = captureDispatchedGoals(store);

		await store.transitionSetupStrict("goal-1", "retrying", { branch: "private-checkout-branch" });
		await store.updateStrict("goal-1", {
			title: "Public title",
			metadata: { "example.enabled": true },
			setupStatus: "ready",
		});

		expect(notifications.map(notification => notification.payload)).toEqual([
			{ goalId: "goal-1", state: "todo", changedFields: [] },
			{ goalId: "goal-1", state: "todo", changedFields: ["metadata", "title"] },
		]);
		expect(JSON.stringify(notifications)).not.toContain("setupStatus");
		expect(JSON.stringify(notifications)).not.toContain("private-checkout-branch");
		expect(dispatcher.getDiagnostics().filter(row => row.code === "invalid_payload")).toEqual([]);
	});

	it("keeps completion distinct from archive and suppresses duplicate archive publication", async () => {
		const { memfs, stateDir, store, manager } = fixture("archive");
		await store.putStrict(goal("goal-1"));
		const facts: GoalStoreNotification[] = [];
		let legacyArchives = 0;
		store.onHostNotification = fact => { facts.push(fact); };
		store.onGoalArchived = () => { legacyArchives++; };

		await manager.updateGoal("goal-1", { state: "complete" });
		await store.archiveStrict("goal-1");
		const archivedRevision = store.get("goal-1")!.updatedAt;
		await store.archiveStrict("goal-1");

		expect(facts.map(fact => fact.name)).toEqual(["goalUpdated", "goalCompleted", "goalArchived"]);
		expect(facts[2]).toEqual({ name: "goalArchived", revision: archivedRevision, payload: { goalId: "goal-1" } });
		expect(store.get("goal-1")?.archivedAt).toBe(archivedRevision);
		expect(durableGoal(memfs, stateDir, "goal-1")?.updatedAt).toBe(archivedRevision);
		expect(legacyArchives).toBe(1);
	});

	it("isolates host consumer failures after commit and emits nothing for a failed strict commit", async () => {
		const { memfs, stateDir, store, manager } = fixture("failures");
		await store.putStrict(goal("goal-1"));
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		store.onHostNotification = () => { throw new Error("consumer failed"); };
		expect(await manager.updateGoal("goal-1", { title: "Committed" })).toBe(true);
		expect(durableGoal(memfs, stateDir, "goal-1")?.title).toBe("Committed");
		expect(warning).toHaveBeenCalledWith(expect.stringContaining("non-fatal"));

		const delivered: GoalStoreNotification[] = [];
		store.onHostNotification = fact => { delivered.push(fact); };
		const originalRename = memfs.promises.rename.bind(memfs.promises);
		(memfs.promises as typeof memfs.promises & { rename: typeof originalRename }).rename = async (from, to) => {
			if (String(to).endsWith("goals.json")) throw new Error("injected goal publication failure");
			return originalRename(from, to);
		};
		await expect(manager.updateGoal("goal-1", { title: "Rejected" })).rejects.toThrow(/injected goal publication failure/);
		expect(delivered).toEqual([]);
		expect(store.get("goal-1")?.title).toBe("Committed");
	});
});
