import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { resetAgentDirStateForTests } from "../../src/server/bobbit-dir.js";
import { generateRoleNames } from "../../src/server/agent/name-generator.js";
import { generateGoalSummaryTitle, generateSessionTitle } from "../../src/server/agent/title-generator.js";

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
