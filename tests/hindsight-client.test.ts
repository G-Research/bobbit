/**
 * Unit tests for the Hindsight REST client (EP G2 / external mode).
 *
 * Drives the client against the deterministic in-process stub
 * (tests/e2e/hindsight-stub.mjs) plus a couple of bespoke servers for the
 * transport-error branches (timeout / http-500 / network). Pins the contract in
 * docs/design/hindsight-pack-external.md §3 + §9.1.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { createClient, HindsightError } from "../market-packs/hindsight/src/hindsight-client.ts";
import {
	CONFIG_DEFAULTS,
	buildOutcomeDigest,
	currentQueryTimestamp,
	mentalModelId,
	mentalModelTags,
	observationScopesForProject,
	resolveConfig,
} from "../market-packs/hindsight/src/shared.ts";
// @ts-expect-error — .mjs stub has no type declarations; shape documented in the file.
import { startHindsightStub } from "./e2e/hindsight-stub.mjs";

interface Stub {
	url: string;
	calls: Array<{
		method: string;
		path: string;
		bank?: string;
		namespace?: string;
		body: any;
		headers: Record<string, string>;
	}>;
	setHealthy(ok: boolean): void;
	seedMemories(bank: string, mem: Array<{ text: string; id?: string; score?: number; tags?: string[] }>): void;
	retained(bank?: string): Array<{ content: string; tags: string[]; async: boolean; document_id?: string; update_mode?: string; timestamp?: string; observation_scopes?: string[][]; entities?: Array<{ text: string; type?: string }>; metadata?: Record<string, string> }>;
	seedMentalModel(bank: string, model: { id: string; content?: string; name?: string; tags?: string[] }): void;
	mentalModels(bank: string): Array<{ id: string; content?: string; name?: string }>;
	seedDirective(bank: string, directive: { id: string; name: string; content: string }): void;
	directives(bank: string): Array<{ id: string; name?: string; content?: string }>;
	operations(bank: string): Array<{ id: string; status?: string; type?: string }>;
	bankConfig(bank: string): Record<string, string> | null;
	close(): Promise<void>;
}

describe("hindsight-client — round-trips against the stub", () => {
	let stub: Stub;

	before(async () => {
		stub = (await startHindsightStub({})) as Stub;
	});
	after(async () => {
		await stub.close();
	});
	beforeEach(() => {
		stub.calls.length = 0;
	});

	it("health() returns ok:true when healthy, ok:false when not", async () => {
		const client = createClient({ baseUrl: stub.url });
		stub.setHealthy(true);
		assert.deepEqual(await client.health(), { ok: true });
		stub.setHealthy(false);
		assert.deepEqual(await client.health(), { ok: false });
		stub.setHealthy(true);
		const call = stub.calls.find((c) => c.path === "/health");
		assert.equal(call?.method, "GET");
	});

	it("ensureBank() PUTs the bank with an empty body", async () => {
		const client = createClient({ baseUrl: stub.url });
		await client.ensureBank("bobbit");
		const call = stub.calls.at(-1)!;
		assert.equal(call.method, "PUT");
		assert.equal(call.path, "/v1/default/banks/bobbit");
		assert.equal(call.bank, "bobbit");
		assert.deepEqual(call.body, {});
	});

	it("recall() maps results → memories and posts query/tags/tags_match", async () => {
		const client = createClient({ baseUrl: stub.url });
		stub.seedMemories("bobbit", [
			{ text: "alpha", id: "m1", score: 0.9, tags: ["project:p1"] },
			{ text: "beta", id: "m2", tags: ["project:p2"] },
		]);
		const out = await client.recall("bobbit", "what did we do", {
			maxTokens: 800,
			tags: { project: "p1" },
			tagsMatch: "any",
		});
		assert.deepEqual(out.memories, [{ text: "alpha", id: "m1", score: 0.9 }]);
		const call = stub.calls.at(-1)!;
		assert.equal(call.method, "POST");
		assert.equal(call.path, "/v1/default/banks/bobbit/memories/recall");
		assert.equal(call.body.query, "what did we do");
		assert.equal(call.body.max_tokens, 800);
		assert.deepEqual(call.body.tags, ["project:p1"]);
		assert.equal(call.body.tags_match, "any");
	});

	it("recall() omits tags/tags_token when no tags supplied and defaults are absent", async () => {
		const client = createClient({ baseUrl: stub.url });
		stub.seedMemories("bobbit", [{ text: "gamma", id: "m3" }]);
		await client.recall("bobbit", "q");
		const call = stub.calls.at(-1)!;
		assert.equal("tags" in call.body, false);
		assert.equal("tags_match" in call.body, false);
		assert.equal("max_tokens" in call.body, false);
		assert.equal("types" in call.body, false);
	});

	it("recall() forwards a `types` fact-type filter (observation bias) when provided", async () => {
		const client = createClient({ baseUrl: stub.url });
		stub.seedMemories("bobbit", [{ text: "obs", id: "o1" }]);
		await client.recall("bobbit", "q", { types: ["observation", "world", "experience"] });
		const call = stub.calls.at(-1)!;
		assert.deepEqual(call.body.types, ["observation", "world", "experience"]);
		// An empty types array is omitted (upstream default applies).
		await client.recall("bobbit", "q", { types: [] });
		assert.equal("types" in stub.calls.at(-1)!.body, false);
	});

	it("recall() forwards budget/query_timestamp/include only when explicitly provided, keeping chunks off by default", async () => {
		const client = createClient({ baseUrl: stub.url });
		await client.recall("bobbit", "q");
		assert.equal("include" in stub.calls.at(-1)!.body, false);
		assert.equal(stub.calls.at(-1)!.body.include?.chunks, undefined);

		await client.recall("bobbit", "q2", {
			budget: "mid",
			queryTimestamp: "2026-06-21T00:00:00.000Z",
			include: { entities: {}, source_facts: {}, chunks: null },
			trace: true,
		});
		const call = stub.calls.at(-1)!;
		assert.equal(call.body.budget, "mid");
		assert.equal(call.body.query_timestamp, "2026-06-21T00:00:00.000Z");
		assert.deepEqual(call.body.include, { entities: {}, source_facts: {}, chunks: null });
		assert.equal(call.body.trace, true);
	});

	it("updateBankConfig() PATCHes …/config with a snake_case mission updates body", async () => {
		const client = createClient({ baseUrl: stub.url });
		await client.updateBankConfig("bobbit", {
			retain_mission: "capture durable knowledge",
			observations_mission: "consolidate stable facts",
			reflect_mission: "ground answers in decisions",
		});
		const call = stub.calls.at(-1)!;
		assert.equal(call.method, "PATCH");
		assert.equal(call.path, "/v1/default/banks/bobbit/config");
		assert.deepEqual(call.body.updates, {
			retain_mission: "capture durable knowledge",
			observations_mission: "consolidate stable facts",
			reflect_mission: "ground answers in decisions",
		});
		assert.deepEqual(stub.bankConfig("bobbit"), {
			retain_mission: "capture durable knowledge",
			observations_mission: "consolidate stable facts",
			reflect_mission: "ground answers in decisions",
		});
	});

	it("retain() sends item-level tags and async = !sync", async () => {
		const client = createClient({ baseUrl: stub.url });
		await client.retain("bobbit", "remember this", {
			tags: { project: "p1", kind: "turn" },
			sync: false,
		});
		const recAsync = stub.retained("bobbit").at(-1)!;
		assert.equal(recAsync.content, "remember this");
		assert.deepEqual(recAsync.tags.sort(), ["kind:turn", "project:p1"]);
		assert.equal(recAsync.async, true);

		await client.retain("bobbit", "compacted span", { sync: true });
		const recSync = stub.retained("bobbit").at(-1)!;
		assert.equal(recSync.async, false);

		await client.retain("bobbit", "no opts");
		const recDefault = stub.retained("bobbit").at(-1)!;
		assert.equal(recDefault.async, true);

		const call = stub.calls.findLast((c) => c.path === "/v1/default/banks/bobbit/memories")!;
		assert.equal(call.method, "POST");
	});

	it("retain() forwards advanced item fields and replace-by-document_id semantics", async () => {
		const client = createClient({ baseUrl: stub.url });
		const opts = {
			tags: { project: "p1", kind: "outcome" },
			documentId: "outcome:g1",
			updateMode: "replace" as const,
			timestamp: "2026-06-21T01:02:03.000Z",
			observationScopes: [["project:p1"]],
			entities: [{ text: "src/app.ts", type: "file" }],
			metadata: { branch: "goal/test" },
		};
		await client.retain("bobbit", "first", opts);
		await client.retain("bobbit", "second", opts);
		const retained = stub.retained("bobbit").filter((r) => r.document_id === "outcome:g1");
		assert.equal(retained.length, 1, "replace mode keeps one retained item per document_id");
		assert.equal(retained[0].content, "second");
		assert.equal(retained[0].document_id, "outcome:g1");
		assert.equal(retained[0].update_mode, "replace");
		assert.equal(retained[0].timestamp, "2026-06-21T01:02:03.000Z");
		assert.deepEqual(retained[0].observation_scopes, [["project:p1"]]);
		assert.deepEqual(retained[0].entities, [{ text: "src/app.ts", type: "file" }]);
		assert.deepEqual(retained[0].metadata, { branch: "goal/test" });
		const call = stub.calls.findLast((c) => c.path === "/v1/default/banks/bobbit/memories")!;
		assert.deepEqual(call.body.items[0].document_id, "outcome:g1");
		assert.deepEqual(call.body.items[0].observation_scopes, [["project:p1"]]);
	});

	it("reflect() posts query and returns text", async () => {
		const client = createClient({ baseUrl: stub.url });
		const out = await client.reflect("bobbit", "summarise the project");
		assert.equal(out.text, "Reflection on: summarise the project");
		const call = stub.calls.at(-1)!;
		assert.equal(call.method, "POST");
		assert.equal(call.path, "/v1/default/banks/bobbit/reflect");
		assert.equal(call.body.query, "summarise the project");
		// No tags ⇒ no tag filter sent (reflect over the whole bank).
		assert.equal(call.body.tags, undefined);
		assert.equal(call.body.tags_match, undefined);
	});

	it("reflect() forwards a scoped tag filter when provided", async () => {
		const client = createClient({ baseUrl: stub.url });
		await client.reflect("bobbit", "what did we decide", { tags: { project: "p1" } });
		const call = stub.calls.at(-1)!;
		assert.equal(call.path, "/v1/default/banks/bobbit/reflect");
		assert.deepEqual(call.body.tags, ["project:p1"]);
		assert.equal(call.body.tags_match, "any");
	});

	it("reflect() forwards structured options and surfaces structured_output", async () => {
		const client = createClient({ baseUrl: stub.url });
		const schema = { type: "object", properties: { decisions: { type: "array" } } };
		const out = await client.reflect("bobbit", "json please", {
			responseSchema: schema,
			factTypes: ["observation"],
			budget: "high",
			maxTokens: 300,
			excludeMentalModels: true,
		});
		assert.deepEqual(out.structuredOutput, { ok: true, schema });
		const call = stub.calls.at(-1)!;
		assert.deepEqual(call.body.response_schema, schema);
		assert.deepEqual(call.body.fact_types, ["observation"]);
		assert.equal(call.body.budget, "high");
		assert.equal(call.body.max_tokens, 300);
		assert.equal(call.body.exclude_mental_models, true);
	});

	it("listBanks() maps bank items → bank ids", async () => {
		const client = createClient({ baseUrl: stub.url });
		await client.ensureBank("bobbit");
		await client.ensureBank("other");
		const out = await client.listBanks();
		assert.ok(out.banks.includes("bobbit"));
		assert.ok(out.banks.includes("other"));
		const call = stub.calls.at(-1)!;
		assert.equal(call.method, "GET");
		assert.equal(call.path, "/v1/default/banks");
	});

	it("recall() with tags_match=all filters to memories having every tag", async () => {
		const client = createClient({ baseUrl: stub.url });
		stub.seedMemories("scoped", [
			{ text: "both", id: "a", tags: ["project:p1", "kind:turn"] },
			{ text: "one", id: "b", tags: ["project:p1"] },
		]);
		const out = await client.recall("scoped", "q", {
			tags: { project: "p1", kind: "turn" },
			tagsMatch: "all",
		});
		assert.deepEqual(
			out.memories.map((m) => m.id),
			["a"],
		);
	});

	it("project recall (tags_match=any) returns project-tagged PLUS untagged/global, excluding other projects", async () => {
		// The shared tag-scoped bank: a project recall must surface this project's
		// memories AND untagged/global ones, while never leaking another project's.
		const client = createClient({ baseUrl: stub.url });
		stub.seedMemories("shared", [
			{ text: "mine", id: "p1", tags: ["project:proj-1"] },
			{ text: "global", id: "g" }, // untagged / global
			{ text: "theirs", id: "p2", tags: ["project:proj-2"] },
		]);
		const out = await client.recall("shared", "q", {
			tags: { project: "proj-1" },
			tagsMatch: "any",
		});
		assert.deepEqual(
			out.memories.map((m) => m.id).sort(),
			["g", "p1"],
			"project-tagged + untagged returned; other-project excluded",
		);
	});

	it("project recall narrowed by an extra tag (all_strict) excludes untagged/global AND other projects", async () => {
		// This is the wire-level proof that an optional `tags` filter NARROWS a project
		// recall instead of broadening it: recallTagFilter(project, pid, _, {goal}) maps
		// to { project:pid, goal:g } + tags_match all_strict, which must return ONLY the
		// current project's memory carrying that extra tag.
		const client = createClient({ baseUrl: stub.url });
		stub.seedMemories("narrow", [
			{ text: "mine+goal", id: "a", tags: ["project:proj-1", "goal:g"] },
			{ text: "mine-no-goal", id: "b", tags: ["project:proj-1"] },
			{ text: "other+goal", id: "c", tags: ["project:proj-2", "goal:g"] },
			{ text: "global+goal", id: "d", tags: ["goal:g"] },
			{ text: "global-untagged", id: "e" },
		]);
		const out = await client.recall("narrow", "q", {
			tags: { project: "proj-1", goal: "g" },
			tagsMatch: "all_strict",
		});
		assert.deepEqual(
			out.memories.map((m) => m.id).sort(),
			["a"],
			"only the current project's memory with the extra tag; other-project, global-tagged, and untagged all excluded",
		);
	});

	it("tags_match=any_strict excludes untagged/global (the variant we deliberately avoid)", async () => {
		const client = createClient({ baseUrl: stub.url });
		stub.seedMemories("strict", [
			{ text: "mine", id: "p1", tags: ["project:proj-1"] },
			{ text: "global", id: "g" },
		]);
		const out = await client.recall("strict", "q", {
			tags: { project: "proj-1" },
			tagsMatch: "any_strict",
		});
		assert.deepEqual(
			out.memories.map((m) => m.id),
			["p1"],
			"any_strict drops untagged/global — why the pack uses plain 'any'",
		);
	});

	it("mental model methods use exact paths and ensureMentalModel handles create/get races", async () => {
		const client = createClient({ baseUrl: stub.url });
		assert.equal(await client.getMentalModel("bobbit", "bobbit-p1"), null);
		const ensured = await client.ensureMentalModel("bobbit", {
			id: "bobbit-p1",
			name: "Project p1",
			sourceQuery: "current state",
			tags: ["project:p1", "bobbit", "kind:mental-model"],
			maxTokens: 1000,
			trigger: { fact_types: ["observation"], exclude_mental_models: true },
		});
		assert.equal(ensured.created, true);
		assert.equal(ensured.model?.id, "bobbit-p1");
		assert.ok(ensured.operationId);
		assert.equal(stub.calls.find((c) => c.method === "POST" && c.path === "/v1/default/banks/bobbit/mental-models")?.body.source_query, "current state");

		const raced = await client.ensureMentalModel("bobbit", {
			id: "bobbit-p1",
			name: "Project p1",
			sourceQuery: "current state",
		});
		assert.equal(raced.created, false);
		assert.equal(raced.model?.id, "bobbit-p1");

		await client.updateMentalModel("bobbit", "bobbit-p1", { sourceQuery: "updated", maxTokens: 900 });
		assert.equal(stub.calls.at(-1)!.body.source_query, "updated");
		assert.equal(stub.calls.at(-1)!.body.max_tokens, 900);
		const refresh = await client.refreshMentalModel("bobbit", "bobbit-p1");
		assert.ok(refresh.operationId);
		assert.deepEqual((await client.listMentalModels("bobbit")).items.map((m) => m.id), ["bobbit-p1"]);
		assert.deepEqual((await client.getMentalModelHistory("bobbit", "bobbit-p1")).history.length, 1);
	});

	it("directives, llm health, operations, and curation methods map to v0.8.3 paths", async () => {
		const client = createClient({ baseUrl: stub.url });
		const directive = await client.createDirective("bobbit", {
			name: "bobbit-coding-agent-recall",
			content: "Prefer durable facts.",
			priority: 50,
			isActive: true,
			tags: ["bobbit"],
		});
		assert.equal(stub.calls.at(-1)!.path, "/v1/default/banks/bobbit/directives");
		assert.equal(stub.calls.at(-1)!.body.is_active, true);
		await client.updateDirective("bobbit", directive.id, { content: "Updated", isActive: false });
		assert.equal(stub.calls.at(-1)!.path, `/v1/default/banks/bobbit/directives/${directive.id}`);
		assert.equal(stub.calls.at(-1)!.body.is_active, false);
		assert.equal((await client.listDirectives("bobbit")).items.length, 1);
		assert.equal((await client.llmHealth("bobbit")).retain?.ok, true);
		assert.equal(stub.calls.at(-1)!.path, "/v1/default/banks/bobbit/health/llm");

		const ops = await client.listOperations("bobbit");
		assert.ok(Array.isArray(ops.items));
		if (ops.items[0]) await client.retryOperation("bobbit", ops.items[0].id);
		stub.seedMemories("bobbit", [{ id: "stale", text: "old decision", tags: ["project:p1"] }]);
		await client.invalidateMemory("bobbit", "stale", "superseded");
		const recall = await client.recall("bobbit", "old", { tags: { project: "p1" } });
		assert.equal(recall.memories.find((m) => m.id === "stale"), undefined);
		assert.deepEqual((await client.getMemoryHistory("bobbit", "stale")).history[0], { id: "stale", state: "invalidated" });
		await client.deleteMemoryObservations("bobbit", "stale");
		assert.equal(stub.calls.at(-1)!.path, "/v1/default/banks/bobbit/memories/stale/observations");
	});
});

describe("hindsight shared foundations", () => {
	it("defaults keep directives disabled and enable v2 memory mechanics knobs", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.mentalModelEnabled, true);
		assert.equal(cfg.mentalModelMaxTokens, 1000);
		assert.equal(cfg.recallQueryTimestampEnabled, true);
		assert.equal(cfg.directivesEnabled, false);
		assert.equal(cfg.directiveApplyMode, "disabled");
		assert.equal(cfg.retainQueueHealthGate, true);
		assert.equal(cfg.retainQueueDrainMaxPerHook, 1);
		assert.deepEqual(CONFIG_DEFAULTS.recallTypes, ["observation", "world", "experience"]);
	});

	it("mental model, observation scope, timestamp, and outcome helpers produce stable API-ready values", () => {
		assert.equal(mentalModelId("My Repo/Project"), "bobbit-my-repo-project");
		assert.deepEqual(mentalModelTags("p1"), ["project:p1", "bobbit", "kind:mental-model"]);
		assert.deepEqual(observationScopesForProject("p1"), [["project:p1"]]);
		assert.equal(currentQueryTimestamp(false), undefined);
		assert.match(currentQueryTimestamp(true, new Date("2026-06-21T00:00:00.000Z")) ?? "", /^2026-06-21T00:00:00\.000Z$/);
		const outcome = buildOutcomeDigest({
			projectId: "p1",
			goalId: "g1",
			pr: 123,
			branch: "goal/test",
			content: "Shipped the feature.",
			files: ["src/app.ts"],
			components: ["hindsight"],
			timestamp: "2026-06-21T01:02:03.000Z",
		});
		assert.equal(outcome.documentId, "outcome:g1");
		assert.equal(outcome.tags.kind, "outcome");
		assert.equal(outcome.tags.project, "p1");
		assert.equal(outcome.tags.pr, "123");
		assert.deepEqual(outcome.observationScopes, [["project:p1"]]);
		assert.deepEqual(outcome.entities, [
			{ text: "src/app.ts", type: "file" },
			{ text: "hindsight", type: "component" },
		]);
	});
});

describe("hindsight-client — auth header", () => {
	let stub: Stub;
	before(async () => {
		stub = (await startHindsightStub({})) as Stub;
	});
	after(async () => {
		await stub.close();
	});
	beforeEach(() => {
		stub.calls.length = 0;
	});

	it("sends Authorization: Bearer only when apiKey is set", async () => {
		const withKey = createClient({ baseUrl: stub.url, apiKey: "secret-123" });
		await withKey.ensureBank("bobbit");
		const authedCall = stub.calls.at(-1)!;
		assert.equal(authedCall.headers["authorization"], "Bearer secret-123");

		stub.calls.length = 0;
		const noKey = createClient({ baseUrl: stub.url });
		await noKey.ensureBank("bobbit");
		const plainCall = stub.calls.at(-1)!;
		assert.equal("authorization" in plainCall.headers, false);
	});
});

describe("hindsight-client — namespace path building", () => {
	let stub: Stub;
	before(async () => {
		stub = (await startHindsightStub({})) as Stub;
	});
	after(async () => {
		await stub.close();
	});
	beforeEach(() => {
		stub.calls.length = 0;
	});

	it("defaults the namespace to 'default'", async () => {
		const client = createClient({ baseUrl: stub.url });
		await client.ensureBank("bobbit");
		assert.equal(stub.calls.at(-1)!.path, "/v1/default/banks/bobbit");
	});

	it("uses a custom namespace and URL-encodes bank ids", async () => {
		const client = createClient({ baseUrl: stub.url, namespace: "team-a" });
		await client.ensureBank("bank/with space");
		const call = stub.calls.at(-1)!;
		assert.equal(call.namespace, "team-a");
		assert.equal(call.path, "/v1/team-a/banks/bank%2Fwith%20space");
		assert.equal(call.bank, "bank/with space");
	});

	it("trims a trailing slash from baseUrl", async () => {
		const client = createClient({ baseUrl: `${stub.url}/` });
		await client.ensureBank("bobbit");
		assert.equal(stub.calls.at(-1)!.path, "/v1/default/banks/bobbit");
	});
});

describe("hindsight-client — transport errors", () => {
	it("throws HindsightError{kind:http,status} on non-2xx", async () => {
		const server = http.createServer((_req, res) => {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ detail: "boom" }));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		const port = (server.address() as AddressInfo).port;
		const client = createClient({ baseUrl: `http://127.0.0.1:${port}` });
		try {
			await assert.rejects(client.recall("bobbit", "q"), (err: unknown) => {
				assert.ok(err instanceof HindsightError);
				assert.equal(err.kind, "http");
				assert.equal(err.status, 500);
				return true;
			});
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	});

	it("ensureMentalModel() maps a 409 duplicate/create race to a follow-up GET", async () => {
		let getCount = 0;
		const server = http.createServer((req, res) => {
			const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
			if (req.method === "GET" && path.endsWith("/mental-models/bobbit-p1")) {
				getCount++;
				if (getCount === 1) {
					res.writeHead(404, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ detail: "not found" }));
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ id: "bobbit-p1", content: "ready" }));
				return;
			}
			if (req.method === "POST" && path.endsWith("/mental-models")) {
				res.writeHead(409, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ detail: "duplicate" }));
				return;
			}
			res.writeHead(500).end();
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		const port = (server.address() as AddressInfo).port;
		const client = createClient({ baseUrl: `http://127.0.0.1:${port}` });
		try {
			const out = await client.ensureMentalModel("bobbit", { id: "bobbit-p1", name: "Project", sourceQuery: "state" });
			assert.equal(out.created, false);
			assert.equal(out.model?.content, "ready");
			assert.equal(getCount, 2);
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	});

	it("surfaces the upstream `detail` body in the HTTP error message (e.g. 400 'Query too long')", async () => {
		// The provider/route soft-skip keys on the message carrying the upstream detail,
		// so the client MUST append it to the HindsightError message for 4xx/5xx.
		const server = http.createServer((_req, res) => {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ detail: "Query too long: 620 tokens exceeds maximum of 500 tokens" }));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		const port = (server.address() as AddressInfo).port;
		const client = createClient({ baseUrl: `http://127.0.0.1:${port}` });
		try {
			await assert.rejects(client.recall("bobbit", "q"), (err: unknown) => {
				assert.ok(err instanceof HindsightError);
				assert.equal(err.kind, "http");
				assert.equal(err.status, 400);
				assert.match(err.message, /Query too long: 620 tokens exceeds maximum of 500/);
				return true;
			});
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	});

	it("throws HindsightError{kind:timeout} within budget on a slow server", async () => {
		const server = http.createServer((_req, _res) => {
			// Never respond — let the client's AbortController fire.
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		const port = (server.address() as AddressInfo).port;
		const timeoutMs = 150;
		const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs });
		const start = Date.now();
		try {
			await assert.rejects(client.recall("bobbit", "q"), (err: unknown) => {
				assert.ok(err instanceof HindsightError);
				assert.equal(err.kind, "timeout");
				return true;
			});
			const elapsed = Date.now() - start;
			assert.ok(elapsed < timeoutMs + 400, `timeout fired within budget (elapsed=${elapsed}ms)`);
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
			// Drop any lingering keep-alive sockets so the server closes promptly.
			server.closeAllConnections?.();
		}
	});

	it("throws HindsightError{kind:network} when the connection is refused", async () => {
		// Bind then immediately release a port so the address is reachable-but-closed.
		const probe = http.createServer();
		await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
		const port = (probe.address() as AddressInfo).port;
		await new Promise<void>((r) => probe.close(() => r()));
		const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 1000 });
		await assert.rejects(client.recall("bobbit", "q"), (err: unknown) => {
			assert.ok(err instanceof HindsightError);
			assert.equal(err.kind, "network");
			return true;
		});
	});

	it("health() returns ok:false instead of throwing on a refused connection", async () => {
		const probe = http.createServer();
		await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
		const port = (probe.address() as AddressInfo).port;
		await new Promise<void>((r) => probe.close(() => r()));
		const client = createClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 1000 });
		assert.deepEqual(await client.health(), { ok: false });
	});
});
