/**
 * Unit tests for the `goal_plan_propose` and `goal_plan_status` tools added
 * to the `Children` group in Phase 3.3 — see
 * `defaults/tools/children/extension.ts` and design doc §5.2 / §5.3.
 *
 * Covers:
 *   - `goal_plan_propose` PATCHes /api/goals/:id/plan with the full body.
 *   - `goal_plan_status`  GETs   /api/goals/:id/plan?gateId=<id>.
 *   - Default `gateId = "execution"` when caller omits it.
 *   - 4xx / 5xx response bodies surface verbatim — including the structured
 *     409 freeze rejections (`mutation-rejected`, `stale-plan`, `replan-cap`).
 *   - Network errors do not throw.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

type RegisteredTool = {
	name: string;
	parameters: unknown;
	execute: (toolCallId: string, params: any) => Promise<{
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	}>;
};

const GOAL_ID = "goal-plan-test";

let origFetch: typeof fetch;
let registered: RegisteredTool[];
let fetchCalls: Array<{ url: string; init: any }>;
let nextResponse: () => Promise<Response>;

function makePi() {
	registered = [];
	return {
		registerTool: (t: RegisteredTool) => { registered.push(t); },
	} as any;
}

function getTool(name: string): RegisteredTool {
	const t = registered.find(r => r.name === name);
	if (!t) throw new Error(`tool not registered: ${name}`);
	return t;
}

before(() => {
	origFetch = globalThis.fetch;
	process.env.BOBBIT_GATEWAY_URL = "http://127.0.0.1:1/";
	process.env.BOBBIT_TOKEN = "test-token";
	globalThis.fetch = (async (url: any, init: any) => {
		fetchCalls.push({ url: String(url), init });
		return await nextResponse();
	}) as any;
});

after(() => {
	globalThis.fetch = origFetch;
	delete process.env.BOBBIT_GATEWAY_URL;
	delete process.env.BOBBIT_TOKEN;
	delete process.env.BOBBIT_GOAL_ID;
});

beforeEach(() => {
	fetchCalls = [];
	nextResponse = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
});

async function loadExtensionWithGoalId(goalId: string | undefined) {
	if (goalId === undefined) {
		delete process.env.BOBBIT_GOAL_ID;
	} else {
		process.env.BOBBIT_GOAL_ID = goalId;
	}
	const mod = await import(`../defaults/tools/children/extension.ts?bust=${Date.now()}-${Math.random()}`);
	const pi = makePi();
	mod.default(pi);
	return pi;
}

describe("Children tool extension — goal_plan_* registration", () => {
	it("registers all Children tools when BOBBIT_GOAL_ID is present", async () => {
		await loadExtensionWithGoalId(GOAL_ID);
		const names = registered.map(t => t.name).sort();
		assert.deepEqual(names, [
			"goal_decide_mutation",
			"goal_merge_child",
			"goal_pause",
			"goal_plan_propose",
			"goal_plan_status",
			"goal_resume",
			"goal_set_policy",
			"goal_spawn_child",
		]);
	});

	it("registers no Plan tools when BOBBIT_GOAL_ID is missing", async () => {
		await loadExtensionWithGoalId(undefined);
		assert.equal(registered.length, 0);
	});
});

describe("goal_plan_propose — URL fan-out", () => {
	beforeEach(async () => {
		await loadExtensionWithGoalId(GOAL_ID);
	});

	it("PATCHes /api/goals/:id/plan with the full body", async () => {
		const tool = getTool("goal_plan_propose");
		const planSteps = [
			{ type: "subgoal", phase: 1, subgoal: { title: "A", spec: "spec A", planId: "p1" } },
			{ type: "subgoal", phase: 1, subgoal: { title: "B", spec: "spec B", planId: "p2" } },
			{ type: "subgoal", phase: 2, subgoal: { title: "C", spec: "spec C", planId: "p3" } },
		];
		const res = await tool.execute("call-1", {
			planSteps,
			gateId: "execution",
			replanReason: "split B/C",
			expectedReplanCount: 0,
		});
		assert.equal(res.isError, undefined);
		assert.equal(fetchCalls.length, 1);
		const { url, init } = fetchCalls[0];
		assert.match(url, /\/api\/goals\/goal-plan-test\/plan$/);
		assert.equal(init.method, "PATCH");
		assert.equal(init.headers["Content-Type"], "application/json");
		assert.equal(init.headers["Authorization"], "Bearer test-token");
		const body = JSON.parse(init.body);
		assert.deepEqual(body.planSteps, planSteps);
		assert.equal(body.gateId, "execution");
		assert.equal(body.replanReason, "split B/C");
		assert.equal(body.expectedReplanCount, 0);
	});

	it("PATCHes with only the required planSteps when other fields are omitted", async () => {
		const tool = getTool("goal_plan_propose");
		await tool.execute("call-2", { planSteps: [] });
		assert.equal(fetchCalls.length, 1);
		const body = JSON.parse(fetchCalls[0].init.body);
		assert.deepEqual(body.planSteps, []);
		assert.equal(body.gateId, undefined);
		assert.equal(body.replanReason, undefined);
		assert.equal(body.expectedReplanCount, undefined);
	});
});

describe("goal_plan_status — URL fan-out", () => {
	beforeEach(async () => {
		await loadExtensionWithGoalId(GOAL_ID);
	});

	it("GETs /api/goals/:id/plan?gateId=execution by default", async () => {
		const tool = getTool("goal_plan_status");
		const res = await tool.execute("call-3", {});
		assert.equal(res.isError, undefined);
		assert.equal(fetchCalls.length, 1);
		const { url, init } = fetchCalls[0];
		assert.match(url, /\/api\/goals\/goal-plan-test\/plan\?gateId=execution$/);
		assert.equal(init.method, "GET");
		assert.equal(init.body, undefined);
		// GET requests should not carry a Content-Type header.
		assert.equal(init.headers["Content-Type"], undefined);
		assert.equal(init.headers["Authorization"], "Bearer test-token");
	});

	it("URL-encodes a custom gateId", async () => {
		const tool = getTool("goal_plan_status");
		await tool.execute("call-4", { gateId: "phase 2/cleanup" });
		assert.equal(fetchCalls.length, 1);
		assert.match(fetchCalls[0].url, /\/plan\?gateId=phase%202%2Fcleanup$/);
	});

	it("returns the JSON-stringified response body on success", async () => {
		nextResponse = async () => new Response(JSON.stringify({
			gateId: "execution",
			frozen: true,
			replanCount: 2,
			planSteps: [
				{
					planId: "p1",
					title: "Sub A",
					spec: "spec A",
					phase: 1,
					dependsOnPlanIds: [],
					child: { goalId: "child-1", state: "in-progress" },
				},
			],
		}), { status: 200 });
		const tool = getTool("goal_plan_status");
		const res = await tool.execute("call-5", {});
		assert.equal(res.isError, undefined);
		const parsed = JSON.parse(res.content[0].text);
		assert.equal(parsed.frozen, true);
		assert.equal(parsed.replanCount, 2);
		assert.equal(parsed.planSteps[0].child.state, "in-progress");
	});
});

describe("goal_plan_propose — error handling", () => {
	beforeEach(async () => {
		await loadExtensionWithGoalId(GOAL_ID);
	});

	it("409 mutation-rejected (criteria-drop) surfaces structured fields verbatim", async () => {
		nextResponse = async () => new Response(JSON.stringify({
			error: "mutation-rejected",
			classification: "criteria-drop",
			droppedCriteria: ["Tests must pass on master"],
			addedNodes: [],
			removedNodes: ["p2"],
			summary: "would drop acceptance criterion #2",
			requiresApproval: false,
		}), { status: 409 });
		const tool = getTool("goal_plan_propose");
		const res = await tool.execute("call-6", { planSteps: [], replanReason: "shrinking" });
		assert.equal(res.isError, true);
		const text = res.content[0].text;
		assert.match(text, /goal_plan_propose failed \(HTTP 409\)/);
		assert.match(text, /"classification": "criteria-drop"/);
		assert.match(text, /Tests must pass on master/);
		assert.match(text, /would drop acceptance criterion #2/);
		assert.match(text, /"removedNodes"/);
	});

	it("409 stale-plan preserves currentReplanCount", async () => {
		nextResponse = async () => new Response(JSON.stringify({
			error: "stale-plan",
			currentReplanCount: 4,
		}), { status: 409 });
		const tool = getTool("goal_plan_propose");
		const res = await tool.execute("call-7", {
			planSteps: [],
			replanReason: "tweak",
			expectedReplanCount: 2,
		});
		assert.equal(res.isError, true);
		const text = res.content[0].text;
		assert.match(text, /goal_plan_propose failed \(HTTP 409\)/);
		assert.match(text, /"error": "stale-plan"/);
		assert.match(text, /"currentReplanCount": 4/);
	});

	it("409 replan-cap preserves replanCount", async () => {
		nextResponse = async () => new Response(JSON.stringify({
			error: "replan-cap",
			replanCount: 6,
		}), { status: 409 });
		const tool = getTool("goal_plan_propose");
		const res = await tool.execute("call-8", { planSteps: [], replanReason: "again" });
		assert.equal(res.isError, true);
		const text = res.content[0].text;
		assert.match(text, /goal_plan_propose failed \(HTTP 409\)/);
		assert.match(text, /"error": "replan-cap"/);
		assert.match(text, /"replanCount": 6/);
	});

	it("400 with non-JSON body still surfaces as error", async () => {
		nextResponse = async () => new Response("Bad gate id", { status: 400 });
		const tool = getTool("goal_plan_propose");
		const res = await tool.execute("call-9", { planSteps: [], gateId: "no-such" });
		assert.equal(res.isError, true);
		assert.match(res.content[0].text, /goal_plan_propose failed \(HTTP 400\)/);
		assert.match(res.content[0].text, /Bad gate id/);
	});

	it("network error surfaces as tool error without throwing", async () => {
		nextResponse = async () => { throw new Error("ECONNREFUSED 127.0.0.1:1"); };
		const tool = getTool("goal_plan_propose");
		const res = await tool.execute("call-10", { planSteps: [] });
		assert.equal(res.isError, true);
		assert.match(res.content[0].text, /goal_plan_propose network error/);
		assert.match(res.content[0].text, /ECONNREFUSED/);
	});
});

describe("goal_plan_status — error handling", () => {
	beforeEach(async () => {
		await loadExtensionWithGoalId(GOAL_ID);
	});

	it("404 unknown gateId surfaces as error containing the body", async () => {
		nextResponse = async () => new Response(JSON.stringify({ error: "unknown-gate" }), { status: 404 });
		const tool = getTool("goal_plan_status");
		const res = await tool.execute("call-11", { gateId: "ghost" });
		assert.equal(res.isError, true);
		assert.match(res.content[0].text, /goal_plan_status failed \(HTTP 404\)/);
		assert.match(res.content[0].text, /unknown-gate/);
	});

	it("network error surfaces as tool error without throwing", async () => {
		nextResponse = async () => { throw new Error("network unreachable"); };
		const tool = getTool("goal_plan_status");
		const res = await tool.execute("call-12", {});
		assert.equal(res.isError, true);
		assert.match(res.content[0].text, /goal_plan_status network error/);
		assert.match(res.content[0].text, /network unreachable/);
	});
});
