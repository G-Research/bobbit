/**
 * CON-01 regression tests: gate-store / team-store / task-store / inbox-store
 * now route save() through the shared atomic-json helper (tmp write -> fsync
 * -> rename, .bak rotation) instead of a truncating fs.writeFileSync, and
 * load() falls back to the newest parseable .bak instead of silently
 * starting empty.
 *
 * Each store below is exercised the same way session-store-atomic-write.test.ts
 * exercises SessionStore:
 *   (a) a second save() rotates a .bak.1 containing the prior payload, and no
 *       stray .tmp is left behind;
 *   (b) a corrupt primary + a valid .bak recovers from the backup instead of
 *       starting empty;
 *   (c) a corrupt primary with no backup on disk starts empty (unchanged
 *       pre-existing behavior).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";

const tmpRoot = makeTmpDir("durable-store-atomic-");

afterEach(() => {
	for (const entry of fs.readdirSync(tmpRoot)) {
		fs.rmSync(path.join(tmpRoot, entry), { recursive: true, force: true });
	}
});

function freshStateDir(label: string): string {
	return fs.mkdtempSync(path.join(tmpRoot, `${label}-`));
}

describe("GateStore atomic write + backup recovery", () => {
	it("rotates .bak.1 on the second save and leaves no stray .tmp", async () => {
		const { GateStore } = await import("../src/server/agent/gate-store.ts");
		const stateDir = freshStateDir("gate");
		const storeFile = path.join(stateDir, "gates.json");

		const store = new GateStore(stateDir);
		store.initGatesForGoal("g1", ["gate-a"]);
		store.initGatesForGoal("g2", ["gate-b"]); // second save -> .bak.1 should hold the g1-only snapshot

		assert.ok(fs.existsSync(storeFile));
		assert.ok(!fs.existsSync(`${storeFile}.tmp`), "no stray .tmp after a successful save");
		assert.ok(fs.existsSync(`${storeFile}.bak.1`), ".bak.1 created on the second save");

		const bak = JSON.parse(fs.readFileSync(`${storeFile}.bak.1`, "utf-8"));
		assert.equal(bak.length, 1);
		assert.equal(bak[0].goalId, "g1");
	});

	it("recovers from .bak.1 when gates.json is corrupt", async () => {
		const { GateStore } = await import("../src/server/agent/gate-store.ts");
		const stateDir = freshStateDir("gate-recover");
		const storeFile = path.join(stateDir, "gates.json");

		const store1 = new GateStore(stateDir);
		store1.initGatesForGoal("g1", ["gate-a"]);
		store1.initGatesForGoal("g2", ["gate-b"]);

		fs.writeFileSync(storeFile, "{ not valid json", "utf-8");

		const store2 = new GateStore(stateDir);
		const g1Gates = store2.getGatesForGoal("g1");
		assert.equal(g1Gates.length, 1, "recovered g1's gate from .bak.1 instead of starting empty");
	});

	it("starts empty when the primary is corrupt and no backup exists", async () => {
		const { GateStore } = await import("../src/server/agent/gate-store.ts");
		const stateDir = freshStateDir("gate-nobak");
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "gates.json"), "{ not valid json", "utf-8");

		const store = new GateStore(stateDir);
		assert.deepEqual(store.getGatesForGoal("anything"), []);
	});
});

describe("TeamStore atomic write + backup recovery", () => {
	it("rotates .bak.1 on the second save", async () => {
		const { TeamStore } = await import("../src/server/agent/team-store.ts");
		const stateDir = freshStateDir("team");
		const storeFile = path.join(stateDir, "team-state.json");

		const store = new TeamStore(stateDir);
		store.put({ goalId: "g1", teamLeadSessionId: null, agents: [], maxConcurrent: 1 });
		store.put({ goalId: "g2", teamLeadSessionId: null, agents: [], maxConcurrent: 1 });

		assert.ok(!fs.existsSync(`${storeFile}.tmp`));
		assert.ok(fs.existsSync(`${storeFile}.bak.1`));
		const bak = JSON.parse(fs.readFileSync(`${storeFile}.bak.1`, "utf-8"));
		assert.equal(bak.length, 1);
		assert.equal(bak[0].goalId, "g1");
	});

	it("recovers from .bak.1 when team-state.json is corrupt", async () => {
		const { TeamStore } = await import("../src/server/agent/team-store.ts");
		const stateDir = freshStateDir("team-recover");
		const storeFile = path.join(stateDir, "team-state.json");

		const store1 = new TeamStore(stateDir);
		store1.put({ goalId: "g1", teamLeadSessionId: null, agents: [], maxConcurrent: 1 });
		store1.put({ goalId: "g2", teamLeadSessionId: null, agents: [], maxConcurrent: 1 });

		fs.writeFileSync(storeFile, "{ not valid json", "utf-8");

		const store2 = new TeamStore(stateDir);
		assert.ok(store2.get("g1"), "recovered g1's team entry from .bak.1 instead of starting empty");
	});

	it("starts empty when the primary is corrupt and no backup exists", async () => {
		const { TeamStore } = await import("../src/server/agent/team-store.ts");
		const stateDir = freshStateDir("team-nobak");
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "team-state.json"), "{ not valid json", "utf-8");

		const store = new TeamStore(stateDir);
		assert.deepEqual(store.getAll(), []);
	});
});

describe("TaskStore atomic write + backup recovery", () => {
	function makeTask(id: string, goalId: string) {
		return {
			id,
			goalId,
			title: `Task ${id}`,
			type: "generic",
			state: "todo" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
	}

	it("rotates .bak.1 on the second save", async () => {
		const { TaskStore } = await import("../src/server/agent/task-store.ts");
		const stateDir = freshStateDir("task");
		const storeFile = path.join(stateDir, "tasks.json");

		const store = new TaskStore(stateDir);
		store.put(makeTask("t1", "g1"));
		store.put(makeTask("t2", "g1"));

		assert.ok(!fs.existsSync(`${storeFile}.tmp`));
		assert.ok(fs.existsSync(`${storeFile}.bak.1`));
		const bak = JSON.parse(fs.readFileSync(`${storeFile}.bak.1`, "utf-8"));
		assert.equal(bak.length, 1);
		assert.equal(bak[0].id, "t1");
	});

	it("recovers from .bak.1 when tasks.json is corrupt", async () => {
		const { TaskStore } = await import("../src/server/agent/task-store.ts");
		const stateDir = freshStateDir("task-recover");
		const storeFile = path.join(stateDir, "tasks.json");

		const store1 = new TaskStore(stateDir);
		store1.put(makeTask("t1", "g1"));
		store1.put(makeTask("t2", "g1"));

		fs.writeFileSync(storeFile, "{ not valid json", "utf-8");

		const store2 = new TaskStore(stateDir);
		assert.ok(store2.get("t1"), "recovered t1 from .bak.1 instead of starting empty");
	});

	it("starts empty when the primary is corrupt and no backup exists", async () => {
		const { TaskStore } = await import("../src/server/agent/task-store.ts");
		const stateDir = freshStateDir("task-nobak");
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "tasks.json"), "{ not valid json", "utf-8");

		const store = new TaskStore(stateDir);
		assert.deepEqual(store.getAll(), []);
	});
});

describe("InboxStore atomic write + backup recovery", () => {
	function makeEntry(id: string, staffId: string) {
		return {
			id,
			staffId,
			source: { type: "manual_api" as const },
			title: "t",
			prompt: "p",
			state: "pending" as const,
			createdAt: Date.now(),
		};
	}

	it("rotates .bak.1 on the second save for a given staff", async () => {
		const { InboxStore } = await import("../src/server/agent/inbox-store.ts");
		const stateDir = freshStateDir("inbox");
		const storeFile = path.join(stateDir, "inbox", "s1.json");

		const store = new InboxStore(stateDir);
		store.put(makeEntry("e1", "s1"));
		store.put(makeEntry("e2", "s1"));

		assert.ok(!fs.existsSync(`${storeFile}.tmp`));
		assert.ok(fs.existsSync(`${storeFile}.bak.1`));
		const bak = JSON.parse(fs.readFileSync(`${storeFile}.bak.1`, "utf-8"));
		assert.equal(bak.entries.length, 1);
		assert.equal(bak.entries[0].id, "e1");
	});

	it("recovers from .bak.1 when a staff's inbox file is corrupt", async () => {
		const { InboxStore } = await import("../src/server/agent/inbox-store.ts");
		const stateDir = freshStateDir("inbox-recover");
		const storeFile = path.join(stateDir, "inbox", "s1.json");

		const store1 = new InboxStore(stateDir);
		store1.put(makeEntry("e1", "s1"));
		store1.put(makeEntry("e2", "s1"));

		fs.writeFileSync(storeFile, "{ not valid json", "utf-8");

		const store2 = new InboxStore(stateDir);
		assert.ok(store2.get("s1", "e1"), "recovered e1 from .bak.1 instead of starting empty");
	});

	it("starts empty when the primary is corrupt and no backup exists", async () => {
		const { InboxStore } = await import("../src/server/agent/inbox-store.ts");
		const stateDir = freshStateDir("inbox-nobak");
		fs.mkdirSync(path.join(stateDir, "inbox"), { recursive: true });
		fs.writeFileSync(path.join(stateDir, "inbox", "s1.json"), "{ not valid json", "utf-8");

		const store = new InboxStore(stateDir);
		assert.deepEqual(store.list("s1"), []);
	});
});
