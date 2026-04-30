/**
 * Unit tests for the registration guard in defaults/tools/tasks/extension.ts.
 *
 * The tasks extension exposes verification_result + gate_* + task_* tools to
 * the agent process. It must register on either:
 *   - goal-owned sessions  (BOBBIT_GOAL_ID set)
 *   - mission-owned sessions (BOBBIT_MISSION_ID set, no BOBBIT_GOAL_ID)
 *
 * Mission-gate reviewer sub-sessions (spec-auditor, architect, code-reviewer)
 * carry only BOBBIT_MISSION_ID. Without this guard fix they would fail to
 * register verification_result and the gate would hang in `running` forever.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const tasksExtBaseUrl = new URL("../defaults/tools/tasks/extension.ts", import.meta.url).href;

interface RegisteredTool {
	name: string;
}

function makeMockPi() {
	const tools: RegisteredTool[] = [];
	const pi = {
		registerTool(def: RegisteredTool & Record<string, unknown>) {
			tools.push({ name: def.name });
		},
	};
	return { pi, tools };
}

async function importFresh(baseUrl: string) {
	// Bust the loader cache so the module's process.env reads are re-evaluated.
	const url = baseUrl + `?t=${Date.now()}-${Math.random()}`;
	return await import(url);
}

const ENV_KEYS = [
	"BOBBIT_SESSION_ID",
	"BOBBIT_GOAL_ID",
	"BOBBIT_MISSION_ID",
	"BOBBIT_TOKEN",
	"BOBBIT_GATEWAY_URL",
] as const;

let savedEnv: Record<string, string | undefined>;

function snapshotEnv() {
	savedEnv = {} as Record<string, string | undefined>;
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}

function restoreEnv() {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else savedEnv[k] !== undefined && (process.env[k] = savedEnv[k]!);
	}
}

describe("tasks/extension owner-kind guard", () => {
	beforeEach(() => {
		snapshotEnv();
		// Provide gateway credentials so the extension doesn't bail out before
		// the owner-kind branch is exercised.
		process.env.BOBBIT_TOKEN = "test-token";
		process.env.BOBBIT_GATEWAY_URL = "https://localhost:0";
	});
	afterEach(restoreEnv);

	it("registers no tools when neither goalId nor missionId is set", async () => {
		process.env.BOBBIT_SESSION_ID = "session-1";
		delete process.env.BOBBIT_GOAL_ID;
		delete process.env.BOBBIT_MISSION_ID;

		const mod = await importFresh(tasksExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		assert.equal(tools.length, 0, "no tools should be registered without an owner");
	});

	it("registers no tools when sessionId is unset", async () => {
		delete process.env.BOBBIT_SESSION_ID;
		process.env.BOBBIT_GOAL_ID = "goal-1";

		const mod = await importFresh(tasksExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		assert.equal(tools.length, 0, "missing sessionId disables registration");
	});

	it("registers all 8 tools (task_* + gate_* + verification_result) for goal sessions", async () => {
		process.env.BOBBIT_SESSION_ID = "session-1";
		process.env.BOBBIT_GOAL_ID = "goal-1";
		delete process.env.BOBBIT_MISSION_ID;

		const mod = await importFresh(tasksExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		const names = tools.map(t => t.name).sort();
		assert.deepEqual(names, [
			"gate_inspect",
			"gate_list",
			"gate_signal",
			"gate_status",
			"task_create",
			"task_list",
			"task_update",
			"verification_result",
		]);
	});

	it("registers verification_result + gate_list/status/signal (no task_*, no gate_inspect) for mission-only sessions", async () => {
		process.env.BOBBIT_SESSION_ID = "session-1";
		delete process.env.BOBBIT_GOAL_ID;
		process.env.BOBBIT_MISSION_ID = "mission-1";

		const mod = await importFresh(tasksExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		const names = tools.map(t => t.name).sort();
		// Mission-owned sessions do NOT get task_* (no mission tasks) nor
		// gate_inspect (mission inspect endpoint not implemented). They DO get
		// verification_result so reviewers can report back to the harness.
		assert.deepEqual(names, [
			"gate_list",
			"gate_signal",
			"gate_status",
			"verification_result",
		]);
	});

	it("prefers goal endpoints when both goalId and missionId are set (goal wins)", async () => {
		process.env.BOBBIT_SESSION_ID = "session-1";
		process.env.BOBBIT_GOAL_ID = "goal-1";
		process.env.BOBBIT_MISSION_ID = "mission-1";

		const mod = await importFresh(tasksExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		// Goal-priority — full toolset (8 tools) is registered.
		assert.equal(tools.length, 8);
		const names = tools.map(t => t.name);
		assert.ok(names.includes("task_create"), "task_create must be registered when goalId is present");
		assert.ok(names.includes("gate_inspect"), "gate_inspect must be registered when goalId is present");
		assert.ok(names.includes("verification_result"));
	});
});
