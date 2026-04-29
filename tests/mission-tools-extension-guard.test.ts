/**
 * Unit tests for the role-guards on the mission and proposal tool extensions.
 *
 * Bug B regression: reviewer sub-sessions (spec-auditor, architect,
 * code-reviewer) for mission-gate verification carry BOBBIT_MISSION_ID so the
 * gateway can correlate their work back to the mission, but they must NOT be
 * able to mutate mission state via mission_* tools or file proposals via
 * propose_* tools. The extensions guard registration on BOBBIT_SESSION_ROLE.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const missionExtBaseUrl = new URL("../defaults/tools/mission/extension.ts", import.meta.url).href;
const proposalsExtBaseUrl = new URL("../defaults/tools/proposals/extension.ts", import.meta.url).href;

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
	// Re-import each time so module-level guards re-evaluate against current
	// process.env. The TS loader caches by URL; appending a unique query
	// string busts the import cache. We use the base URL directly (no
	// pathToFileURL) so tsx's loader resolves it the same way as in
	// browser-screenshot-no-bloat.test.ts.
	const url = baseUrl + `?t=${Date.now()}-${Math.random()}`;
	return await import(url);
}

const ENV_KEYS = ["BOBBIT_SESSION_ID", "BOBBIT_MISSION_ID", "BOBBIT_SESSION_ROLE"] as const;

let savedEnv: Record<string, string | undefined>;

function snapshotEnv() {
	savedEnv = {} as Record<string, string | undefined>;
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}

function restoreEnv() {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
}

describe("mission/extension role guard", () => {
	beforeEach(() => {
		snapshotEnv();
		// Make sure REST credentials are present so the extension doesn't bail
		// before the role check (it tries to read state files otherwise).
		process.env.BOBBIT_TOKEN = "test-token";
		process.env.BOBBIT_GATEWAY_URL = "https://localhost:0";
	});
	afterEach(restoreEnv);

	it("does NOT register mission_* tools when role is a reviewer (e.g. spec-auditor)", async () => {
		process.env.BOBBIT_SESSION_ID = "session-1";
		process.env.BOBBIT_MISSION_ID = "mission-1";
		process.env.BOBBIT_SESSION_ROLE = "spec-auditor";

		const mod = await importFresh(missionExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		assert.equal(tools.length, 0, `expected no mission tools registered for spec-auditor, got: ${tools.map(t => t.name).join(",")}`);
	});

	it("does NOT register mission_* tools for architect or code-reviewer roles", async () => {
		for (const role of ["architect", "code-reviewer", "reviewer", "qa-tester"]) {
			process.env.BOBBIT_SESSION_ID = "session-1";
			process.env.BOBBIT_MISSION_ID = "mission-1";
			process.env.BOBBIT_SESSION_ROLE = role;
			const mod = await importFresh(missionExtBaseUrl);
			const { pi, tools } = makeMockPi();
			mod.default(pi);
			assert.equal(tools.length, 0, `expected no mission tools for role=${role}, got: ${tools.map(t => t.name).join(",")}`);
		}
	});

	it("does NOT register mission_* tools when role env var is unset", async () => {
		process.env.BOBBIT_SESSION_ID = "session-1";
		process.env.BOBBIT_MISSION_ID = "mission-1";
		delete process.env.BOBBIT_SESSION_ROLE;
		const mod = await importFresh(missionExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		assert.equal(tools.length, 0, "unset role must not register mission tools");
	});

	it("registers all 6 mission_* tools when role is commander", async () => {
		process.env.BOBBIT_SESSION_ID = "session-1";
		process.env.BOBBIT_MISSION_ID = "mission-1";
		process.env.BOBBIT_SESSION_ROLE = "commander";
		const mod = await importFresh(missionExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		const names = tools.map(t => t.name).sort();
		assert.deepEqual(names, [
			"mission_goal_spawn",
			"mission_goal_status",
			"mission_merge_child",
			"mission_plan_propose",
			"mission_signal",
			"mission_status",
		]);
	});

	it("does NOT register when missionId is missing even for commander", async () => {
		process.env.BOBBIT_SESSION_ID = "session-1";
		delete process.env.BOBBIT_MISSION_ID;
		process.env.BOBBIT_SESSION_ROLE = "commander";
		const mod = await importFresh(missionExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		assert.equal(tools.length, 0);
	});
});

describe("proposals/extension role guard", () => {
	beforeEach(snapshotEnv);
	afterEach(restoreEnv);

	it("does NOT register propose_* tools for reviewer roles", async () => {
		for (const role of ["spec-auditor", "architect", "code-reviewer", "reviewer", "qa-tester", "test-engineer", "coder", "team-lead"]) {
			process.env.BOBBIT_SESSION_ROLE = role;
			const mod = await importFresh(proposalsExtBaseUrl);
			const { pi, tools } = makeMockPi();
			mod.default(pi);
			assert.equal(tools.length, 0, `expected no propose_* tools for role=${role}, got: ${tools.map(t => t.name).join(",")}`);
		}
	});

	it("registers propose_* tools when role is commander", async () => {
		process.env.BOBBIT_SESSION_ROLE = "commander";
		const mod = await importFresh(proposalsExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		assert.ok(tools.length >= 8, `expected proposal tools for commander, got ${tools.length}`);
		const names = tools.map(t => t.name);
		assert.ok(names.includes("propose_goal"));
		assert.ok(names.includes("propose_mission"));
	});

	it("registers propose_* tools when role is unset (assistant-type catch-all)", async () => {
		delete process.env.BOBBIT_SESSION_ROLE;
		const mod = await importFresh(proposalsExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		assert.ok(tools.length >= 8, `expected proposal tools for unset role, got ${tools.length}`);
	});

	it("registers propose_* tools when role starts with 'assistant'", async () => {
		process.env.BOBBIT_SESSION_ROLE = "assistant";
		const mod = await importFresh(proposalsExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		assert.ok(tools.length >= 8);
	});

	it("registers propose_* tools when role is 'general'", async () => {
		process.env.BOBBIT_SESSION_ROLE = "general";
		const mod = await importFresh(proposalsExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		assert.ok(tools.length >= 8);
	});
});
