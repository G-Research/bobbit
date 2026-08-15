import { guardProcessEnv } from "./helpers/env-guard.js";
import { enableTsWorkerResolver } from "./helpers/enable-ts-worker.js";
guardProcessEnv();
enableTsWorkerResolver();

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { RouteDispatcher, type RouteHandlerCtx } from "../../src/server/extension-host/route-dispatcher.ts";
import { makeTmpDir } from "../../tests/helpers/tmp.ts";
import { GRAPH_QUERY_CAPS, GraphQueryService } from "../../market-packs/code-intelligence/src/graph-query.ts";
import { __setGraphRuntimeForTests, routes } from "../../market-packs/code-intelligence/src/routes.ts";
import extension from "../../market-packs/code-intelligence/tools/graph/extension.ts";

const context = { projectId: "route-test" };

function installRuntime(query: (request: Record<string, unknown>) => unknown | Promise<unknown>): void {
	__setGraphRuntimeForTests(() => ({
		query: async (_context: unknown, request: Record<string, unknown>) => query(request),
		status: async (_context: unknown, request: Record<string, unknown>) => query({ ...request, op: "status" }),
		config: async () => ({ ok: true }),
		rebuild: async () => ({ accepted: false, reason: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8", status: {} as never }),
	} as never));
}

function declaredStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		state: "current", aggregate: { state: "current", label: "Current" },
		components: [{
			component: { name: "api", repo: "." }, state: "fresh", revision: "head-a",
			revisions: { baseRef: "main", baseRev: "base-a", headRev: "head-a" },
			roots: [{ tier: "code", path: "src" }], counts: { nodes: 2, edges: 1, bytes: 100 }, timing: { buildMs: 12 }, languages: [],
		}],
		languages: [{
			languageId: "typescript", label: "TypeScript", structuralSearch: "available",
			lsp: { state: "disabled", actions: ["definition"], requirements: [], missing: [], reason: "Explicit enablement is required." },
			evidence: { fileCount: 2, matchedGlobs: ["**/*.ts"], rootMarkers: ["tsconfig.json"] },
		}],
		runtime: "host", noCrossRepoEdges: true, warning: "v1 has no cross-repo edges", warnings: [], guidance: [],
		lifecycle: { automaticProcessing: "unavailable", pending: "EP-8", message: "Automatic lifecycle processing is unavailable." },
		...overrides,
	};
}

function declaredConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		readOnly: true, storage: "host-only", defaultTiers: ["code"], docsOptIn: "graph_query.includeDocs",
		lifecycle: { automaticProcessing: "unavailable", pending: "EP-8", message: "Automatic lifecycle processing is unavailable." },
		manualRebuild: { routeOnly: true, available: false, reason: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8" },
		noCrossRepoEdges: true, warning: "v1 has no cross-repo edges",
		...overrides,
	};
}

afterEach(() => __setGraphRuntimeForTests());

describe("graph routes — host boundary caps and errors", () => {
	it("clamps hostile values to GRAPH_QUERY_CAPS and forwards valid maxima unchanged", async () => {
		const seen: Record<string, unknown>[] = [];
		installRuntime(request => { seen.push(request); return { ok: true }; });

		const hostile = await routes.status(context, {
			body: {
				op: "affected", symbol: "service", maxResults: 999_999, maxDepth: 999_999, maxPaths: 999_999,
				components: Array.from({ length: GRAPH_QUERY_CAPS.components + 3 }, (_, index) => `component-${index}`),
			},
		});
		const valid = await routes.status(context, { body: { op: "affected", symbol: "service", maxResults: GRAPH_QUERY_CAPS.results, maxDepth: GRAPH_QUERY_CAPS.depth } });

		assert.deepEqual(hostile, { ok: true });
		assert.deepEqual(valid, { ok: true });
		assert.equal(seen.length, 2);
		assert.deepEqual(seen[0].components, Array.from({ length: GRAPH_QUERY_CAPS.components }, (_, index) => `component-${index}`));
		assert.equal(seen[0].maxResults, GRAPH_QUERY_CAPS.results);
		assert.equal(seen[0].maxDepth, GRAPH_QUERY_CAPS.depth);
		assert.equal("maxPaths" in seen[0], false);
		assert.equal(seen[1].maxResults, GRAPH_QUERY_CAPS.results);
		assert.equal(seen[1].maxDepth, GRAPH_QUERY_CAPS.depth);
	});

	it("passes only the bounded declared status projection from the runtime", async () => {
		installRuntime(request => request.op === "status" ? { ...declaredStatus(), hostRoot: "/private/graph-store" } : { ok: true });
		const response = await routes.status(context, { body: {} });
		assert.deepEqual(response, { ok: false, error: "GRAPH_STATUS_DECLARATION_INVALID" });
		assert.doesNotMatch(JSON.stringify(response), /private|graph-store/);

		installRuntime(request => request.op === "status" ? { ...declaredStatus(), ignoredByRoute: "not published" } : { ok: true });
		const bounded = await routes.status(context, { body: {} }) as Record<string, unknown>;
		assert.equal(bounded.state, "current");
		assert.deepEqual(bounded.runtime, "host");
		assert.equal("ignoredByRoute" in bounded, false);
		assert.deepEqual((bounded.components as Array<Record<string, unknown>>)[0].roots, [{ tier: "code", path: "src" }]);
	});

	it("rejects unknown declared states and raw configuration paths", async () => {
		installRuntime(request => request.op === "status" ? declaredStatus({ state: "unknown-future-state" }) : { ok: true });
		assert.deepEqual(await routes.status(context, { body: {} }), { ok: false, error: "GRAPH_STATUS_DECLARATION_INVALID" });

		__setGraphRuntimeForTests(() => ({
			query: async () => ({ ok: true }), status: async () => declaredStatus(), config: async () => declaredConfig({ hostRoot: "/private/graph-store" }),
			rebuild: async () => ({ accepted: false, reason: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8", status: {} as never }),
		} as never));
		const config = await routes.config(context, { method: "GET" });
		assert.deepEqual(config, { ok: false, error: "GRAPH_CONFIG_DECLARATION_INVALID" });
		assert.doesNotMatch(JSON.stringify(config), /private|graph-store/);
	});

	it("always declares no cross-repository edges while warning only on fan-out", async () => {
		const query = new GraphQueryService({ list: () => [{
			component: { name: "api", repo: "." }, revisions: { baseRef: "main", baseRev: "a", headRev: "b" }, state: "fresh",
			graph: { nodes: [], edges: [] },
		}] });
		const response = await query.status({ components: ["api"] });
		assert.equal(response.noCrossRepoEdges, true);
		assert.equal(response.warning, undefined);
	});

	it("returns a fixed path-free public error when the host runtime throws", async () => {
		installRuntime(() => { throw new Error("/private/graph-store/candidate/meta.json"); });
		const response = await routes.status(context, { body: { op: "query", query: "graph" } });
		assert.deepEqual(response, { ok: false, error: "GRAPH_RUNTIME_UNAVAILABLE" });
		assert.doesNotMatch(JSON.stringify(response), /private|graph-store|candidate/);
	});

	it("carries verified scope through the real route worker and fails closed for missing or spoofed scope", async () => {
		const originalBobbitDir = process.env.BOBBIT_DIR;
		const hostRoot = makeTmpDir("graph-real-route-");
		process.env.BOBBIT_DIR = hostRoot;
		const modulePath = path.resolve(process.cwd(), "market-packs/code-intelligence/lib/routes.mjs");
		const packRoot = path.resolve(process.cwd(), "market-packs/code-intelligence");
		const dispatcher = new RouteDispatcher({ rate: null });
		const verified: RouteHandlerCtx = {
			host: {} as RouteHandlerCtx["host"], sessionId: "route-session", toolUseId: "", tool: "code-intelligence",
			projectId: "project-a", goalId: "goal-a", branch: "goal/a", worktreeId: "/worktrees/a", worktreePath: "/worktrees/a", workingDir: "/worktrees/a",
			scopeContext: { project: { id: "project-a" }, goal: { id: "goal-a" }, component: { name: "api", repo: "." } },
		};
		try {
			const config = await dispatcher.dispatch(modulePath, packRoot, "config", verified, { method: "GET" }) as Record<string, unknown>;
			assert.equal(config.storage, "host-only");
			assert.equal(config.noCrossRepoEdges, true);
			const status = await dispatcher.dispatch(modulePath, packRoot, "status", verified, { method: "GET" }) as Record<string, unknown>;
			assert.ok(Array.isArray(status.components), "real status route returns its declared components envelope");

			const missingScope = await dispatcher.dispatch(modulePath, packRoot, "config", { ...verified, scopeContext: undefined }, { method: "GET" });
			assert.deepEqual(missingScope, { ok: false, error: "GRAPH_CONTEXT_PROJECT_REQUIRED" });

			// A caller cannot cross-project spoof a scope snapshot: project A never falls
			// back to a matching graph cache/store for project B.
			const crossProjectScope = await dispatcher.dispatch(modulePath, packRoot, "config", {
				...verified, scopeContext: { project: { id: "project-b" }, goal: { id: "goal-a" }, component: { name: "api", repo: "." } },
			}, { method: "GET" });
			assert.deepEqual(crossProjectScope, { ok: false, error: "GRAPH_CONTEXT_PROJECT_REQUIRED" });
		} finally {
			if (originalBobbitDir === undefined) delete process.env.BOBBIT_DIR; else process.env.BOBBIT_DIR = originalBobbitDir;
			fs.rmSync(hostRoot, { recursive: true, force: true });
		}
	});

	it("publishes only service-supported TypeBox limits and marks JSON route failures as tool errors", async () => {
		const originalFetch = globalThis.fetch;
		const originalSession = process.env.BOBBIT_SESSION_ID;
		const originalUrl = process.env.BOBBIT_GATEWAY_URL;
		const originalToken = process.env.BOBBIT_TOKEN;
		try {
			process.env.BOBBIT_SESSION_ID = "session";
			process.env.BOBBIT_GATEWAY_URL = "http://gateway.test";
			process.env.BOBBIT_TOKEN = "token";
			globalThis.fetch = (async (url: string | URL) => new Response(JSON.stringify(String(url).endsWith("/surface-token") ? { token: "surface" } : { ok: false, error: "GRAPH_RUNTIME_UNAVAILABLE" }), { status: 200 })) as typeof fetch;
			const registered: any[] = [];
			extension({ registerTool: (tool: unknown) => registered.push(tool) } as any);

			const byName = new Map(registered.map(tool => [tool.name, tool]));
			for (const tool of registered) {
				const properties = tool.parameters.properties as Record<string, { maximum?: number }>;
				if (properties.maxResults) assert.equal(properties.maxResults.maximum, GRAPH_QUERY_CAPS.results);
				if (properties.maxDepth) assert.equal(properties.maxDepth.maximum, GRAPH_QUERY_CAPS.depth);
				assert.ok(tool.description.includes("Read-only"));
				assert.ok(tool.promptSnippet.length <= 160, `${tool.name} prompt snippet must remain bounded`);
				assert.match(tool.promptSnippet, /breadth leads only; stale\/base-fallback results cannot establish current impact/);
				assert.ok(tool.promptGuidelines.includes("Before a finding or approval, use read on every cited source and caller."));
			}
			assert.equal("maxPaths" in byName.get("graph_path").parameters.properties, false);

			const result = await byName.get("graph_query").execute("call", { query: "graph" });
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /GRAPH_RUNTIME_UNAVAILABLE/);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalSession === undefined) delete process.env.BOBBIT_SESSION_ID; else process.env.BOBBIT_SESSION_ID = originalSession;
			if (originalUrl === undefined) delete process.env.BOBBIT_GATEWAY_URL; else process.env.BOBBIT_GATEWAY_URL = originalUrl;
			if (originalToken === undefined) delete process.env.BOBBIT_TOKEN; else process.env.BOBBIT_TOKEN = originalToken;
		}
	});
});
