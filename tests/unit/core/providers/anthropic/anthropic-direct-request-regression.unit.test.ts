import { guardProcessEnv } from "../../../../../tests/support/helpers/unit/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Models } from "@earendil-works/pi-ai";
import { afterEach, describe, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { resetAgentDirStateForTests } from "../../../../../src/server/bobbit-dir.js";
import { oauthStatus, refreshOAuthToken } from "../../../../../src/server/auth/oauth.js";
import { generateRoleNames } from "../../../../../src/server/agent/name-generator.js";
import {
	createAnthropicDirectHeaders,
	PI_ANTHROPIC_DIRECT_REQUEST_IDENTITY,
} from "../../../../../src/server/agent/anthropic-direct-request.js";
import { generateGoalSummaryTitle, generateSessionTitle } from "../../../../../src/server/agent/title-generator.js";

let agentDir: string | undefined;
const generatedRoleFiles = new Set<string>();

function useAuth(auth: unknown): void {
	agentDir = mkdtempSync(path.join(tmpdir(), "bobbit-anthropic-direct-"));
	process.env.BOBBIT_AGENT_DIR = agentDir;
	resetAgentDirStateForTests();
	writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: auth }));
}

function response(status: number, body: unknown): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function titleResponse(title = "OAuth Titles"): Response {
	return response(200, { content: [{ type: "text", text: `<title>${title}</title>` }] });
}

function captureConsole(methods: Array<"error" | "warn">): { lines: string[]; restore: () => void } {
	const originals = new Map(methods.map((method) => [method, console[method]]));
	const lines: string[] = [];
	for (const method of methods) {
		(console as any)[method] = (...args: unknown[]) => lines.push(args.map(String).join(" "));
	}
	return {
		lines,
		restore: () => originals.forEach((original, method) => { (console as any)[method] = original; }),
	};
}

function uniqueRole(): string {
	const name = `anthropic-direct-${process.pid}-${Date.now()}-${generatedRoleFiles.size}`;
	generatedRoleFiles.add(path.join(process.cwd(), "data", "team-names", `${name}.json`));
	return name;
}

afterEach(() => {
	if (agentDir) rmSync(agentDir, { recursive: true, force: true });
	agentDir = undefined;
	for (const file of generatedRoleFiles) rmSync(file, { force: true });
	generatedRoleFiles.clear();
	resetAgentDirStateForTests();
});

describe("direct Anthropic request regressions", () => {
	it("captures a controlled identity factor matrix while retaining Pi's fixed default and model-specific mock outcomes", async () => {
		// These are test-only factor inputs: the helper owns no OAuth scopes or
		// credentials, and the blank access value cannot authenticate anywhere.
		const factors = [
			{
				provenance: "mock current Pi credential provenance",
				scopeProfile: "current Pi-maintained scope profile",
				identity: PI_ANTHROPIC_DIRECT_REQUEST_IDENTITY,
			},
			{
				provenance: "mock legacy credential provenance",
				scopeProfile: "synthetic legacy reduced-scope profile",
				identity: {
					beta: "mock-legacy-beta",
					userAgent: "mock-legacy-agent",
					app: "mock-legacy-app",
				},
			},
		] as const;
		const outcomes = new Map([
			["claude-opus-5", 404],
			["claude-sonnet-5", 429],
			["claude-opus-4-6", 401],
		]);
		type Factor = typeof factors[number];
		const captured: Array<{
			factor: Pick<Factor, "provenance" | "scopeProfile">;
			url: string;
			headers: Record<string, string>;
			model: string;
		}> = [];
		const mockFetch = async (factor: Factor, input: RequestInfo | URL, init: RequestInit): Promise<Response> => {
			const request = new Request(input, init);
			const body = JSON.parse(await request.text()) as { model: string };
			captured.push({
				factor: { provenance: factor.provenance, scopeProfile: factor.scopeProfile },
				url: request.url,
				headers: Object.fromEntries(request.headers),
				model: body.model,
			});
			return response(outcomes.get(body.model) ?? 500, { type: "mock_outcome" });
		};
		const oauth = { type: "oauth" as const, access: "" };

		// Production callers omit the identity seam. Capture the actual Request
		// shape rather than merely comparing the plain object returned by the helper.
		const fixedDefault = await mockFetch(factors[0], "https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: createAnthropicDirectHeaders(oauth),
			body: JSON.stringify({ model: "claude-opus-5" }),
		});
		assert.equal(fixedDefault.status, 404);
		assert.deepEqual(captured[0], {
			factor: {
				provenance: "mock current Pi credential provenance",
				scopeProfile: "current Pi-maintained scope profile",
			},
			url: "https://api.anthropic.com/v1/messages",
			headers: {
				"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
				"anthropic-version": "2023-06-01",
				authorization: "Bearer",
				"content-type": "application/json",
				"user-agent": "claude-cli/2.1.75",
				"x-app": "cli",
			},
			model: "claude-opus-5",
		}, "production callers omit the test seam and retain Pi's exact default identity");

		for (const factor of factors) {
			for (const [model, expectedStatus] of outcomes) {
				const result = await mockFetch(factor, "https://api.anthropic.com/v1/messages", {
					method: "POST",
					headers: createAnthropicDirectHeaders(oauth, factor.identity),
					body: JSON.stringify({ model }),
				});
				assert.equal(result.status, expectedStatus, `${factor.provenance} / ${factor.scopeProfile} must preserve ${model}'s mocked result`);
			}

			const apiKeyHeaders = createAnthropicDirectHeaders({ type: "api-key", access: "" }, factor.identity);
			assert.deepEqual(apiKeyHeaders, {
				"Content-Type": "application/json",
				"anthropic-version": "2023-06-01",
				"x-api-key": "",
			}, "API-key requests must never receive a mocked OAuth identity");
		}

		const factorCaptures = captured.slice(1);
		assert.equal(new Set(factorCaptures.map((request) => request.headers["anthropic-beta"])).size, factors.length);
		assert.equal(new Set(factorCaptures.map((request) => request.headers["user-agent"])).size, factors.length);
		assert.equal(new Set(factorCaptures.map((request) => request.headers["x-app"])).size, factors.length);
		assert.deepEqual(
			factorCaptures.map(({ factor, model }) => ({ factor, model })),
			factors.flatMap((factor) => [...outcomes.keys()].map((model) => ({
				factor: { provenance: factor.provenance, scopeProfile: factor.scopeProfile },
				model,
			}))),
			"each synthetic provenance and scope factor must be threaded into the mocked request capture",
		);
	});

	it("keeps role-name API-key selection and exact API-key request identity", async () => {
		useAuth({ type: "api-key", key: "test-api-key" });
		const requests: Array<{ headers: Record<string, string>; body: any }> = [];
		const names = Array.from({ length: 50 }, (_, index) => `Name ${index}`);
		await generateRoleNames(uniqueRole(), "Test role", (async (_url, init) => {
			requests.push({ headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(String(init?.body)) });
			return response(200, { content: [{ type: "text", text: JSON.stringify(names) }] });
		}) as typeof fetch);

		assert.equal(requests.length, 1);
		assert.deepEqual(requests[0]!.headers, {
			"Content-Type": "application/json",
			"anthropic-version": "2023-06-01",
			"x-api-key": "test-api-key",
		});
		assert.equal(requests[0]!.body.model, "claude-haiku-4-5-20251001");
		assert.equal(requests[0]!.body.system.includes("Claude Code"), false);
	});

	it("refreshes role-name OAuth through Pi, preserves its identity, and rejects only a 401", async () => {
		const access = randomUUID();
		useAuth({ type: "oauth", access, refresh: randomUUID(), expires: Date.now() + 60_000 });
		const requests: Record<string, string>[] = [];
		let refreshes = 0;
		await generateRoleNames(
			uniqueRole(),
			"OAuth role",
			(async (_url, init) => {
				requests.push(init?.headers as Record<string, string>);
				return response(401, "unauthorized");
			}) as typeof fetch,
			async () => {
				refreshes++;
				return access;
			},
		);

		assert.equal(refreshes, 1, "role-name generation must resolve OAuth through Pi once");
		assert.deepEqual(requests, [{
			"Content-Type": "application/json",
			"anthropic-version": "2023-06-01",
			Authorization: `Bearer ${access}`,
			"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
			"user-agent": "claude-cli/2.1.75",
			"x-app": "cli",
		}]);
		assert.deepEqual(oauthStatus("anthropic"), {
			authenticated: false,
			stored: true,
			rejected: true,
			refreshable: false,
			provider: "anthropic",
		});
	});

	it("keeps role-name OAuth authenticated after a model or resource 403", async () => {
		const access = randomUUID();
		useAuth({ type: "oauth", access, refresh: randomUUID(), expires: Date.now() + 60_000 });
		await generateRoleNames(
			uniqueRole(),
			"Forbidden role",
			(async () => response(403, "model access denied")) as typeof fetch,
			async () => access,
		);
		assert.equal(oauthStatus("anthropic").authenticated, true);
	});

	it("uses Pi-compatible OAuth identity and treats rejected credentials as definitive", async () => {
		useAuth({ type: "oauth", access: "stored-access-must-not-be-used", refresh: "refresh-metadata", expires: Date.now() + 60_000 });
		const requests: Array<{ headers: Record<string, string>; body: any }> = [];
		const resolvedTokens = ["resolved-initial", "resolved-goal"];
		const fetchImpl = (async (_url: any, init?: RequestInit) => {
			requests.push({ headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(String(init?.body)) });
			return requests.length === 1 ? response(401, "ignored upstream body") : titleResponse("Goal Summary");
		}) as typeof fetch;
		const options = {
			namingModel: "anthropic/claude-opus-5",
			availableModels: [],
			fetchImpl,
			anthropicOAuthTokenResolver: async () => resolvedTokens.shift() ?? null,
		};

		assert.equal(await generateSessionTitle([{ role: "user", content: "Rejected credential" }], options), null);
		assert.equal(await generateGoalSummaryTitle("Summarize the OAuth goal", options), "Goal Summary");
		assert.equal(requests.length, 2, "a rejected credential must not trigger a second request");
		assert.deepEqual(requests.map((request) => request.body.model), ["claude-opus-5", "claude-opus-5"]);
		assert.deepEqual(requests.map((request) => request.headers), [
			{
				"Content-Type": "application/json",
				"anthropic-version": "2023-06-01",
				Authorization: "Bearer resolved-initial",
				"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
				"user-agent": "claude-cli/2.1.75",
				"x-app": "cli",
			},
			{
				"Content-Type": "application/json",
				"anthropic-version": "2023-06-01",
				Authorization: "Bearer resolved-goal",
				"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
				"user-agent": "claude-cli/2.1.75",
				"x-app": "cli",
			},
		]);
	});

	it("does not authenticate incomplete OAuth rows and persists direct OAuth rejection", async () => {
		useAuth({ type: "oauth", access: randomUUID(), expires: Date.now() + 60_000 });
		const partialStatus = oauthStatus("anthropic");
		assert.equal(partialStatus.authenticated, false);
		assert.equal(partialStatus.stored, true);
		assert.equal(partialStatus.refreshable, false);
		assert.equal(Number.isFinite(partialStatus.expires), true);
		assert.equal(partialStatus.provider, "anthropic");

		const access = randomUUID();
		writeFileSync(path.join(agentDir!, "auth.json"), JSON.stringify({
			anthropic: { type: "oauth", access, refresh: randomUUID(), expires: Date.now() + 60_000 },
		}));
		let requests = 0;
		const result = await generateSessionTitle([{ role: "user", content: "Persist rejected state" }], {
			namingModel: "anthropic/claude-opus-5",
			availableModels: [],
			fetchImpl: (async () => {
				requests++;
				return response(401, "unauthorized");
			}) as typeof fetch,
			anthropicOAuthTokenResolver: async () => access,
		});

		assert.equal(result, null);
		assert.equal(requests, 1);
		assert.deepEqual(oauthStatus("anthropic"), {
			authenticated: false,
			stored: true,
			rejected: true,
			refreshable: false,
			provider: "anthropic",
		});
	});

	it("keeps an OAuth credential on a transient Pi response body containing terminal-looking numerals", async () => {
		const access = randomUUID();
		useAuth({ type: "oauth", access, refresh: randomUUID(), expires: Date.now() - 60_000 });
		const originalFetch = globalThis.fetch;
		let requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			return response(500, "retry after 401 milliseconds; HTTP request failed. status=401; url=https://platform.claude.com/v1/oauth/token; body=ignored");
		}) as typeof fetch;
		try {
			assert.equal(await refreshOAuthToken(), null);
			assert.equal(requests, 1);
			const status = oauthStatus("anthropic");
			assert.equal(status.authenticated, false, "a transient refresh failure does not validate an expired credential");
			assert.equal(status.stored, true);
			assert.equal(status.refreshable, true);
			assert.equal(status.provider, "anthropic");
			assert.equal(typeof status.expires, "number");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not relabel post-OAuth API-key resolution as Claude Code OAuth", async () => {
		const originalOAuth = { type: "oauth", access: randomUUID(), refresh: randomUUID(), expires: Date.now() + 60_000 };
		useAuth(originalOAuth);
		const races: Array<{
			name: string;
			replaceCredential: unknown;
			resolved?: { source: string; apiKey: string };
		}> = [
			{ name: "logout", replaceCredential: {} },
			{
				name: "stored API key",
				replaceCredential: { anthropic: { type: "api_key", key: "replacement-api-key" } },
				resolved: { source: "stored credential", apiKey: "replacement-api-key" },
			},
			{
				name: "ambient API key",
				replaceCredential: {},
				resolved: { source: "ANTHROPIC_API_KEY", apiKey: "ambient-api-key" },
			},
		];

		for (const race of races) {
			writeFileSync(path.join(agentDir!, "auth.json"), JSON.stringify({ anthropic: originalOAuth }));
			let requests = 0;
			const result = await generateSessionTitle([{ role: "user", content: race.name }], {
				namingModel: "anthropic/claude-sonnet-5",
				availableModels: [],
				fetchImpl: (async () => {
					requests++;
					return titleResponse();
				}) as typeof fetch,
				anthropicOAuthTokenResolver: () => refreshOAuthToken(undefined, {
					getAuth: async () => {
						writeFileSync(path.join(agentDir!, "auth.json"), JSON.stringify(race.replaceCredential));
						return race.resolved ? { auth: { apiKey: race.resolved.apiKey }, source: race.resolved.source } : undefined;
					},
				} as Pick<Models, "getAuth">),
			});
			assert.equal(result, null, `${race.name} must not produce a direct request`);
			assert.equal(requests, 0, `${race.name} must not send an API key with OAuth headers`);
		}
	});

	it("keeps title API-key requests isolated from Claude Code OAuth headers", async () => {
		useAuth({ type: "api_key", key: "title-api-key" });
		const headers: Record<string, string>[] = [];
		const fetchImpl = (async (_url: any, init?: RequestInit) => {
			headers.push(init?.headers as Record<string, string>);
			return titleResponse();
		}) as typeof fetch;
		const options = { namingModel: "anthropic/claude-sonnet-5", availableModels: [], fetchImpl };

		assert.equal(await generateSessionTitle([{ role: "user", content: "API key session" }], options), "OAuth Titles");
		assert.equal(await generateGoalSummaryTitle("API key goal", options), "OAuth Titles");
		assert.deepEqual(headers, [
			{ "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "title-api-key" },
			{ "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "title-api-key" },
		]);
	});

	it("classifies role-name 429 responses from the HTTP status, not model-not-found body text", async () => {
		useAuth({ type: "api-key", key: "role-test-key" });
		const captured = captureConsole(["error"]);
		try {
			await generateRoleNames(uniqueRole(), "misleading provider body", (async () =>
				response(429, "model_not_found")
			) as typeof fetch);

			assert.equal(captured.lines.length, 1);
			assert.match(captured.lines[0]!, /rate_or_spend_limit \(429\)/);
			assert.doesNotMatch(captured.lines[0]!, /model_not_found/);
		} finally {
			captured.restore();
		}
	});

	it("distinguishes and redacts title and role-name upstream failures", async () => {
		const sentinel = `sensitive-${"x".repeat(48)}`;
		const expected = new Map<number, RegExp>([
			[404, /model(?: not |_)found/i],
			[401, /authentication/i],
			[403, /authentication/i],
			[429, /rate.*spend|rate_or_spend/i],
		]);
		const captured = captureConsole(["error", "warn"]);
		try {
			useAuth({ type: "oauth", access: "stored", refresh: "metadata", expires: Date.now() + 60_000 });
			for (const [status, pattern] of expected) {
				let requestCount = 0;
				const fetchImpl = (async () => {
					requestCount++;
					return response(status, `provider payload ${sentinel}`);
				}) as typeof fetch;
				const options = {
					namingModel: "anthropic/claude-opus-5",
					availableModels: [],
					fetchImpl,
					anthropicOAuthTokenResolver: async () => "resolved-token",
				};
				assert.equal(await generateSessionTitle([{ role: "user", content: `status ${status}` }], options), null);
				assert.equal(await generateGoalSummaryTitle(`status ${status}`, options), null);
				// Role names have no test-only resolver seam; exercise the equivalent
				// direct API-key path without ever placing an OAuth value in fixtures.
				writeFileSync(path.join(agentDir!, "auth.json"), JSON.stringify({ anthropic: { type: "api-key", key: "role-test-key" } }));
				await generateRoleNames(uniqueRole(), `status ${status}`, fetchImpl);
				writeFileSync(path.join(agentDir!, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "stored", refresh: "metadata", expires: Date.now() + 60_000 } }));
				assert.equal(requestCount, 3, `${status} must be reported after one request per direct call`);
				const recent = captured.lines.slice(-4).join("\n");
				assert.match(recent, pattern);
			}
			const output = captured.lines.join("\n");
			assert.equal(output.includes(sentinel), false, "upstream body must never reach title or role-name logs");
		} finally {
			captured.restore();
		}
	});
});
