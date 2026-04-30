/**
 * Regression test for the `mission_plan_propose` tool argument shape.
 *
 * The Anthropic SDK has been observed to wrap nested object arguments as
 * JSON-encoded strings when the tool schema declares the field as
 * `Type.Any()`. The Commander would then see the call rejected with a
 * useless "Plan must have goals[] and dependencies[]" error.
 *
 * The fix is two-fold:
 *   (A) Express the MissionPlan shape as a structured TypeBox schema in
 *       defaults/tools/mission/extension.ts so the model sees the field
 *       structure and emits a real object literal.
 *   (B) Defensively JSON.parse() string-encoded plans on the server (tool
 *       handler) before forwarding to the gateway, so a future SDK
 *       regression doesn't blow up the Commander again.
 *
 * This file covers (A) the schema is a structured Type.Object, and (B) the
 * handler tolerates both string-encoded and object-literal plans, and emits
 * a clear error for malformed JSON strings.
 *
 * mission_signal's `metadata` arg gets the same defensive parse — covered at
 * the bottom of the file.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const missionExtBaseUrl = new URL("../defaults/tools/mission/extension.ts", import.meta.url).href;

interface RegisteredTool {
	name: string;
	parameters: any;
	execute: (toolUseId: string, params: any) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

function makeMockPi() {
	const tools: RegisteredTool[] = [];
	const pi = {
		registerTool(def: RegisteredTool) {
			tools.push(def);
		},
	};
	return { pi, tools };
}

async function importFresh(baseUrl: string) {
	const url = baseUrl + `?t=${Date.now()}-${Math.random()}`;
	return await import(url);
}

const ENV_KEYS = [
	"BOBBIT_SESSION_ID",
	"BOBBIT_MISSION_ID",
	"BOBBIT_SESSION_ROLE",
	"BOBBIT_TOKEN",
	"BOBBIT_GATEWAY_URL",
] as const;

let savedEnv: Record<string, string | undefined>;
let origFetch: typeof fetch;

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

function setCommanderEnv() {
	process.env.BOBBIT_SESSION_ID = "session-1";
	process.env.BOBBIT_MISSION_ID = "mission-1";
	process.env.BOBBIT_SESSION_ROLE = "commander";
	process.env.BOBBIT_TOKEN = "test-token";
	process.env.BOBBIT_GATEWAY_URL = "https://localhost:0";
}

interface CapturedRequest {
	method: string;
	url: string;
	body: any;
}

function mockFetchCapture(): { captured: CapturedRequest[]; restore: () => void } {
	const captured: CapturedRequest[] = [];
	origFetch = globalThis.fetch;
	globalThis.fetch = (async (input: any, init?: any) => {
		const url = typeof input === "string" ? input : input.url;
		const method = init?.method ?? "GET";
		let body: any = undefined;
		if (init?.body) {
			try { body = JSON.parse(init.body); } catch { body = init.body; }
		}
		captured.push({ method, url: String(url), body });
		return new Response(JSON.stringify({ ok: true, version: 1 }), { status: 200 });
	}) as any;
	return {
		captured,
		restore() { globalThis.fetch = origFetch; },
	};
}

const validPlan = {
	goals: [
		{ planId: "01HZA0000000000000000A", title: "First", spec: "do A" },
		{ planId: "01HZA0000000000000000B", title: "Second", spec: "do B" },
	],
	dependencies: [
		{ from: "01HZA0000000000000000A", to: "01HZA0000000000000000B" },
	],
	rationale: "Two-step decomposition",
	estimatedConcurrency: 1,
	version: 1,
};

describe("mission_plan_propose: structured TypeBox schema (Option A)", () => {
	beforeEach(() => { snapshotEnv(); setCommanderEnv(); });
	afterEach(restoreEnv);

	it("declares `plan` as a Type.Object with goals/dependencies/rationale/estimatedConcurrency/version (NOT Type.Any)", async () => {
		const mod = await importFresh(missionExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		const tool = tools.find(t => t.name === "mission_plan_propose");
		assert.ok(tool, "mission_plan_propose must be registered");
		const planSchema = tool!.parameters?.properties?.plan;
		assert.ok(planSchema, "parameters.plan schema must be present");
		// Must be an object schema, not Any/unknown.
		assert.equal(planSchema.type, "object", `plan schema must be type=object, got ${JSON.stringify(planSchema.type)}`);
		assert.ok(planSchema.properties, "plan schema must declare properties");
		// Required top-level fields per MissionPlan.
		for (const field of ["goals", "dependencies", "rationale", "estimatedConcurrency", "version"]) {
			assert.ok(
				planSchema.properties[field],
				`plan schema must declare ${field} as a property`,
			);
		}
		// goals/dependencies must be arrays of objects.
		assert.equal(planSchema.properties.goals.type, "array");
		assert.equal(planSchema.properties.goals.items.type, "object");
		assert.equal(planSchema.properties.dependencies.type, "array");
		assert.equal(planSchema.properties.dependencies.items.type, "object");
		// PlannedGoal item must declare planId/title/spec.
		const goalProps = planSchema.properties.goals.items.properties;
		for (const f of ["planId", "title", "spec"]) {
			assert.ok(goalProps[f], `PlannedGoal must declare ${f}`);
			assert.equal(goalProps[f].type, "string");
		}
		// PlanEdge must declare from/to.
		const edgeProps = planSchema.properties.dependencies.items.properties;
		for (const f of ["from", "to"]) {
			assert.ok(edgeProps[f], `PlanEdge must declare ${f}`);
			assert.equal(edgeProps[f].type, "string");
		}
	});
});

describe("mission_plan_propose: defensive JSON-string parsing (Option B)", () => {
	beforeEach(() => { snapshotEnv(); setCommanderEnv(); });
	afterEach(() => { restoreEnv(); if (origFetch) globalThis.fetch = origFetch; });

	it("forwards an OBJECT plan as-is to PATCH /api/missions/:id/plan", async () => {
		const mod = await importFresh(missionExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		const tool = tools.find(t => t.name === "mission_plan_propose")!;
		const { captured, restore } = mockFetchCapture();
		try {
			const result = await tool.execute("tu-1", { plan: validPlan });
			assert.ok(!result.isError, `expected ok, got: ${JSON.stringify(result)}`);
			assert.equal(captured.length, 1);
			assert.equal(captured[0].method, "PATCH");
			assert.match(captured[0].url, /\/api\/missions\/mission-1\/plan$/);
			assert.deepEqual(captured[0].body.plan, validPlan);
		} finally { restore(); }
	});

	it("parses a JSON-STRING plan, then forwards it as a structured object", async () => {
		// This is the exact regression: the SDK serialised the plan arg as a
		// JSON-encoded string. Before the fix, validatePlan() rejected with
		// "Plan must have goals[] and dependencies[]". After the fix, the
		// handler parses the string transparently.
		const mod = await importFresh(missionExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		const tool = tools.find(t => t.name === "mission_plan_propose")!;
		const { captured, restore } = mockFetchCapture();
		try {
			const result = await tool.execute("tu-1", { plan: JSON.stringify(validPlan) });
			assert.ok(!result.isError, `expected ok, got: ${result.content[0].text}`);
			assert.equal(captured.length, 1, "fetch should have fired exactly once");
			// Body's `plan` must be a real object, not a string.
			assert.equal(typeof captured[0].body.plan, "object");
			assert.deepEqual(captured[0].body.plan, validPlan);
		} finally { restore(); }
	});

	it("returns a clear error (not a network call) when plan is a malformed JSON string", async () => {
		const mod = await importFresh(missionExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		const tool = tools.find(t => t.name === "mission_plan_propose")!;
		const { captured, restore } = mockFetchCapture();
		try {
			const result = await tool.execute("tu-1", { plan: "{not valid json" });
			assert.ok(result.isError, "expected isError=true for malformed JSON string");
			assert.match(result.content[0].text, /malformed JSON string/i);
			assert.equal(captured.length, 0, "must not call the gateway with malformed input");
		} finally { restore(); }
	});

	it("forwards replan_reason alongside a string-encoded plan", async () => {
		const mod = await importFresh(missionExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		const tool = tools.find(t => t.name === "mission_plan_propose")!;
		const { captured, restore } = mockFetchCapture();
		try {
			const result = await tool.execute("tu-1", {
				plan: JSON.stringify(validPlan),
				replan_reason: "scope reduction",
			});
			assert.ok(!result.isError);
			assert.equal(captured.length, 1);
			assert.equal(captured[0].body.replan_reason, "scope reduction");
			assert.deepEqual(captured[0].body.plan, validPlan);
		} finally { restore(); }
	});
});

describe("mission_signal: defensive JSON-string metadata parsing", () => {
	beforeEach(() => { snapshotEnv(); setCommanderEnv(); });
	afterEach(() => { restoreEnv(); if (origFetch) globalThis.fetch = origFetch; });

	it("forwards an OBJECT metadata as-is", async () => {
		const mod = await importFresh(missionExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		const tool = tools.find(t => t.name === "mission_signal")!;
		const { captured, restore } = mockFetchCapture();
		try {
			const result = await tool.execute("tu-1", {
				gate_id: "charter",
				content: "## Charter\n\nfoo",
				metadata: { reviewer: "spec-auditor" },
			});
			assert.ok(!result.isError, `expected ok, got: ${result.content[0].text}`);
			assert.equal(captured.length, 1);
			assert.deepEqual(captured[0].body.metadata, { reviewer: "spec-auditor" });
		} finally { restore(); }
	});

	it("parses a JSON-STRING metadata transparently", async () => {
		const mod = await importFresh(missionExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		const tool = tools.find(t => t.name === "mission_signal")!;
		const { captured, restore } = mockFetchCapture();
		try {
			const result = await tool.execute("tu-1", {
				gate_id: "charter",
				metadata: JSON.stringify({ reviewer: "spec-auditor" }),
			} as any);
			assert.ok(!result.isError, `expected ok, got: ${result.content[0].text}`);
			assert.equal(captured.length, 1);
			assert.equal(typeof captured[0].body.metadata, "object");
			assert.deepEqual(captured[0].body.metadata, { reviewer: "spec-auditor" });
		} finally { restore(); }
	});

	it("returns a clear error for malformed JSON-string metadata", async () => {
		const mod = await importFresh(missionExtBaseUrl);
		const { pi, tools } = makeMockPi();
		mod.default(pi);
		const tool = tools.find(t => t.name === "mission_signal")!;
		const { captured, restore } = mockFetchCapture();
		try {
			const result = await tool.execute("tu-1", {
				gate_id: "charter",
				metadata: "{not valid",
			} as any);
			assert.ok(result.isError, "expected isError=true for malformed JSON metadata");
			assert.match(result.content[0].text, /malformed JSON string/i);
			assert.equal(captured.length, 0);
		} finally { restore(); }
	});
});
