/**
 * Unit tests for the `Children` tool group extension —
 * `defaults/tools/children/extension.ts`.
 *
 * Covers (per design doc §5):
 *   - Each registered tool fans out to the correct REST URL + HTTP method.
 *   - `BOBBIT_GOAL_ID` is interpolated into the URL path.
 *   - 4xx response bodies (e.g. 409 mutation classification) surface as a
 *     tool error containing the response JSON verbatim.
 *   - Network errors surface gracefully without throwing.
 *   - Missing `BOBBIT_GOAL_ID` causes the extension to no-op (no tools
 *     registered).
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

const GOAL_ID = "goal-123";

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
	// Re-import each time so the env-driven top-level read happens fresh.
	// `?cache-bust=` query forces Node's loader to bypass the ESM cache.
	const mod = await import(`../defaults/tools/children/extension.ts?bust=${Date.now()}-${Math.random()}`);
	const pi = makePi();
	mod.default(pi);
	return pi;
}

describe("Children tool extension — registration", () => {
	it("registers all Children tools when BOBBIT_GOAL_ID is present", async () => {
		await loadExtensionWithGoalId(GOAL_ID);
		const names = registered.map(t => t.name).sort();
		// `goal_plan_propose` and `goal_plan_status` were added in Phase 3.3;
		// see tests/tool-extension-plan.test.ts for their dedicated coverage.
		assert.deepEqual(names, [
			"goal_merge_child",
			"goal_pause",
			"goal_plan_propose",
			"goal_plan_status",
			"goal_resume",
			"goal_spawn_child",
		]);
	});

	it("registers no tools when BOBBIT_GOAL_ID is missing", async () => {
		await loadExtensionWithGoalId(undefined);
		assert.equal(registered.length, 0, "expected no tools when BOBBIT_GOAL_ID is unset");
	});
});

describe("Children tool extension — URL fan-out", () => {
	beforeEach(async () => {
		await loadExtensionWithGoalId(GOAL_ID);
	});

	it("goal_spawn_child POSTs to /api/goals/:id/spawn-child with JSON body", async () => {
		const tool = getTool("goal_spawn_child");
		const res = await tool.execute("call-1", {
			title: "Sub feature",
			spec: "## Covers\n- Acceptance criterion 1",
			planId: "plan-abc",
		});
		assert.equal(res.isError, undefined);
		assert.equal(fetchCalls.length, 1);
		const { url, init } = fetchCalls[0];
		assert.match(url, /\/api\/goals\/goal-123\/spawn-child$/);
		assert.equal(init.method, "POST");
		assert.equal(init.headers["Content-Type"], "application/json");
		assert.equal(init.headers["Authorization"], "Bearer test-token");
		const body = JSON.parse(init.body);
		assert.equal(body.title, "Sub feature");
		assert.equal(body.planId, "plan-abc");
		assert.match(body.spec, /Acceptance criterion 1/);
	});

	it("goal_merge_child POSTs to /api/goals/:parent/integrate-child/:child", async () => {
		const tool = getTool("goal_merge_child");
		const res = await tool.execute("call-2", { childGoalId: "child-9" });
		assert.equal(res.isError, undefined);
		assert.equal(fetchCalls.length, 1);
		const { url, init } = fetchCalls[0];
		assert.match(url, /\/api\/goals\/goal-123\/integrate-child\/child-9$/);
		assert.equal(init.method, "POST");
	});

	it("goal_merge_child URL-encodes a child goal id with special chars", async () => {
		const tool = getTool("goal_merge_child");
		await tool.execute("call-2b", { childGoalId: "child/with space" });
		const { url } = fetchCalls[0];
		assert.match(url, /\/integrate-child\/child%2Fwith%20space$/);
	});

	it("goal_pause POSTs to /api/goals/:id/pause", async () => {
		const tool = getTool("goal_pause");
		const res = await tool.execute("call-3", {});
		assert.equal(res.isError, undefined);
		assert.equal(fetchCalls.length, 1);
		assert.match(fetchCalls[0].url, /\/api\/goals\/goal-123\/pause$/);
		assert.equal(fetchCalls[0].init.method, "POST");
	});

	it("goal_resume POSTs to /api/goals/:id/resume", async () => {
		const tool = getTool("goal_resume");
		const res = await tool.execute("call-4", {});
		assert.equal(res.isError, undefined);
		assert.equal(fetchCalls.length, 1);
		assert.match(fetchCalls[0].url, /\/api\/goals\/goal-123\/resume$/);
		assert.equal(fetchCalls[0].init.method, "POST");
	});
});

describe("Children tool extension — error handling", () => {
	beforeEach(async () => {
		await loadExtensionWithGoalId(GOAL_ID);
	});

	it("4xx response surfaces as tool error containing the body verbatim", async () => {
		nextResponse = async () => new Response(JSON.stringify({
			error: "mutation-rejected",
			classification: "criteria-drop",
			droppedCriteria: ["Tests must pass"],
			summary: "would drop acceptance criterion",
		}), { status: 409 });
		const tool = getTool("goal_spawn_child");
		const res = await tool.execute("call-5", { title: "x", spec: "y" });
		assert.equal(res.isError, true);
		const text = res.content[0].text;
		assert.match(text, /goal_spawn_child failed \(HTTP 409\)/);
		assert.match(text, /criteria-drop/);
		assert.match(text, /Tests must pass/);
		assert.match(text, /would drop acceptance criterion/);
	});

	it("4xx with non-JSON body still surfaces as error", async () => {
		nextResponse = async () => new Response("Not Found", { status: 404 });
		const tool = getTool("goal_pause");
		const res = await tool.execute("call-6", {});
		assert.equal(res.isError, true);
		assert.match(res.content[0].text, /goal_pause failed \(HTTP 404\)/);
		assert.match(res.content[0].text, /Not Found/);
	});

	it("network error surfaces as tool error without throwing", async () => {
		nextResponse = async () => { throw new Error("ECONNREFUSED 127.0.0.1:1"); };
		const tool = getTool("goal_resume");
		const res = await tool.execute("call-7", {});
		assert.equal(res.isError, true);
		assert.match(res.content[0].text, /goal_resume network error/);
		assert.match(res.content[0].text, /ECONNREFUSED/);
	});

	it("successful response is returned as JSON-stringified content", async () => {
		nextResponse = async () => new Response(JSON.stringify({
			childGoalId: "child-1",
			planId: "plan-1",
			alreadySpawned: false,
		}), { status: 201 });
		const tool = getTool("goal_spawn_child");
		const res = await tool.execute("call-8", { title: "t", spec: "s" });
		assert.equal(res.isError, undefined);
		const parsed = JSON.parse(res.content[0].text);
		assert.equal(parsed.childGoalId, "child-1");
		assert.equal(parsed.alreadySpawned, false);
	});
});
