/**
 * Unit tests for the `search` tool (defaults/tools/harness/extension.ts) —
 * the read-only agent-facing surface for NAV-doc-knowledge-retrieval / F10.
 *
 * Spins up a real local HTTP server standing in for the gateway's
 * `GET /api/search` route (the extension talks over raw node:http, matching
 * the existing `orient` tool's pattern in this same file — not `fetch`), and
 * asserts:
 *   - the tool forwards q/type/limit/offset/project_id as querystring params
 *   - a successful response is summarized as a compact result count + one
 *     line per hit (path/title + snippet) — never the raw stored text
 *   - the `details` payload carries the full structured results for
 *     programmatic use
 *   - a `{ error }` gateway response surfaces as an isError tool result
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import registerHarnessExtension from "../defaults/tools/harness/extension.ts";

type ExecuteFn = (toolCallId: string, params: unknown) => Promise<any>;

function makeStubApi(): { api: any; getExecute: (name: string) => ExecuteFn } {
	const registered = new Map<string, ExecuteFn>();
	const api = {
		registerTool(config: any) {
			if (typeof config?.execute === "function") registered.set(config.name, config.execute.bind(config));
		},
	};
	return {
		api,
		getExecute: (name: string) => {
			const fn = registered.get(name);
			if (!fn) throw new Error(`${name} was not registered`);
			return fn;
		},
	};
}

function startMockGateway(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer(handler);
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as any).port;
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => new Promise((res) => server.close(() => res())),
			});
		});
	});
}

describe("search tool (harness group)", () => {
	let execute: ExecuteFn;
	let gateway: { url: string; close: () => Promise<void> };
	let lastRequest: { pathname: string; query: URLSearchParams; headers: http.IncomingHttpHeaders } | null = null;
	let responsePayload: unknown = { results: [], total: 0 };
	let responseStatus = 200;
	const envBackup: Record<string, string | undefined> = {};

	before(async () => {
		for (const key of ["BOBBIT_SESSION_ID", "BOBBIT_TOKEN", "BOBBIT_GATEWAY_URL", "BOBBIT_DIR"]) {
			envBackup[key] = process.env[key];
		}
		gateway = await startMockGateway((req, res) => {
			const u = new URL(req.url ?? "/", "http://127.0.0.1");
			lastRequest = { pathname: u.pathname, query: u.searchParams, headers: req.headers };
			res.writeHead(responseStatus, { "Content-Type": "application/json" });
			res.end(JSON.stringify(responsePayload));
		});
		process.env.BOBBIT_SESSION_ID = "caller-session";
		process.env.BOBBIT_TOKEN = "test-token";
		process.env.BOBBIT_GATEWAY_URL = gateway.url;
		delete process.env.BOBBIT_DIR;

		const { api, getExecute } = makeStubApi();
		registerHarnessExtension(api);
		execute = getExecute("search");
	});

	beforeEach(() => {
		lastRequest = null;
		responsePayload = { results: [], total: 0 };
		responseStatus = 200;
	});

	after(async () => {
		await gateway.close();
		for (const key of ["BOBBIT_SESSION_ID", "BOBBIT_TOKEN", "BOBBIT_GATEWAY_URL", "BOBBIT_DIR"]) {
			if (envBackup[key] === undefined) delete process.env[key];
			else process.env[key] = envBackup[key]!;
		}
	});

	it("forwards q/type/limit/offset/project_id to GET /api/search", async () => {
		await execute("toolu_1", { q: "bcrypt cost", type: "files", limit: 5, offset: 10, project_id: "proj-a" });
		assert.ok(lastRequest);
		assert.equal(lastRequest!.pathname, "/api/search");
		assert.equal(lastRequest!.query.get("q"), "bcrypt cost");
		assert.equal(lastRequest!.query.get("type"), "files");
		assert.equal(lastRequest!.query.get("limit"), "5");
		assert.equal(lastRequest!.query.get("offset"), "10");
		assert.equal(lastRequest!.query.get("projectId"), "proj-a");
		assert.equal(lastRequest!.headers.authorization, "Bearer test-token");
	});

	it("omits optional params entirely when not provided", async () => {
		await execute("toolu_2", { q: "just a query" });
		assert.equal(lastRequest!.query.get("q"), "just a query");
		assert.equal(lastRequest!.query.has("type"), false);
		assert.equal(lastRequest!.query.has("limit"), false);
		assert.equal(lastRequest!.query.has("offset"), false);
		assert.equal(lastRequest!.query.has("projectId"), false);
	});

	it("summarizes hits as paths/titles + snippets, never the raw stored text, and carries structured details", async () => {
		const fullDocText = "# Internals\n\n".repeat(200) + "The full body of the document, much longer than any snippet.";
		responsePayload = {
			total: 2,
			results: [
				{
					type: "file",
					id: "file:docs/internals.md",
					title: "docs/internals.md",
					snippet: "…Lexical search over <b>goals</b>, sessions, messages…",
					filePath: "docs/internals.md",
					startLine: 1831,
					endLine: 1840,
					timestamp: 0,
					archived: false,
					score: 3.2,
				},
				{
					type: "goal",
					id: "goal-1",
					title: "Fix search titles",
					snippet: "First goal: <b>Working</b> on the thing",
					timestamp: 0,
					archived: false,
					score: 1.1,
				},
			],
		};

		const result = await execute("toolu_3", { q: "goals" });
		assert.equal(result.isError, undefined);
		const text: string = result.content[0].text;
		assert.match(text, /^2 of 2 result\(s\):/);
		assert.match(text, /\[file] docs\/internals\.md:1831 —/);
		assert.match(text, /\[goal] Fix search titles —/);
		// Highlight tags are stripped for the plain-text summary.
		assert.ok(!text.includes("<b>"));
		assert.ok(!text.includes("</b>"));
		// The full document body must never appear anywhere in the tool result.
		assert.ok(!text.includes(fullDocText));
		assert.ok(!JSON.stringify(result.details).includes(fullDocText));

		assert.equal(result.details.total, 2);
		assert.equal(result.details.results.length, 2);
		assert.equal(result.details.results[0].filePath, "docs/internals.md");
	});

	it("surfaces a structured gateway error as an isError tool result", async () => {
		responsePayload = { error: "search-unavailable" };
		const result = await execute("toolu_4", { q: "x" });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /search-unavailable/);
	});
});
