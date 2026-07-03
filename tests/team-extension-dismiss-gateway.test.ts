import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import teamExtension from "../defaults/tools/team/extension.ts";
import agentExtension from "../defaults/tools/agent/extension.ts";
import { __clearCredsCacheForTesting } from "../defaults/tools/_shared/gateway.ts";
import { __clearCredsCacheForTesting as __clearAgentCredsCacheForTesting } from "../defaults/tools/agent/gateway.js";

type RegisteredTool = {
	name: string;
	execute: (toolCallId: string, params: any) => Promise<{ content: Array<{ type: string; text: string }>; details?: any; isError?: boolean }>;
};

const savedEnv: Record<string, string | undefined> = {};
let stateRoot = "";
let originalFetch: typeof fetch;

function setEnv(name: string, value: string | undefined): void {
	if (!(name in savedEnv)) savedEnv[name] = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function writeGatewayState(token: string, baseUrl = "https://gateway.test"): void {
	const stateDir = path.join(stateRoot, "state");
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(path.join(stateDir, "token"), token, "utf-8");
	writeFileSync(path.join(stateDir, "gateway-url"), baseUrl, "utf-8");
}

function registerTeamDismiss(): RegisteredTool {
	const tools = new Map<string, RegisteredTool>();
	teamExtension({ registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } } as any);
	const tool = tools.get("team_dismiss");
	assert.ok(tool, "team_dismiss should register when session/goal env is present");
	return tool;
}

function registerOwnChildDismiss(): RegisteredTool {
	const tools = new Map<string, RegisteredTool>();
	agentExtension({ registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } } as any);
	const tool = tools.get("team_dismiss");
	assert.ok(tool, "own-child team_dismiss should register for non-goal sessions");
	return tool;
}

describe("team_dismiss extension gateway handling", () => {
	beforeEach(() => {
		stateRoot = mkdtempSync(path.join(tmpdir(), "bobbit-team-dismiss-ext-"));
		writeGatewayState("old-token");
		setEnv("BOBBIT_DIR", stateRoot);
		setEnv("BOBBIT_SESSION_ID", "lead-session");
		setEnv("BOBBIT_GOAL_ID", "goal-1");
		setEnv("BOBBIT_SESSION_SECRET", "lead-secret");
		setEnv("BOBBIT_TOKEN", undefined);
		setEnv("BOBBIT_GATEWAY_URL", undefined);
		__clearCredsCacheForTesting();
		__clearAgentCredsCacheForTesting();
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		__clearCredsCacheForTesting();
		__clearAgentCredsCacheForTesting();
		for (const [name, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		for (const name of Object.keys(savedEnv)) delete savedEnv[name];
		rmSync(stateRoot, { recursive: true, force: true });
		stateRoot = "";
	});

	it("refreshes gateway credentials on 401 before returning a detailed dismiss result", async () => {
		const tool = registerTeamDismiss();
		writeGatewayState("new-token");

		const authHeaders: string[] = [];
		const success = { ok: true, status: "dismissed", sessionId: "child-1", message: "Team agent child-1 dismissed.", retryable: false };
		globalThis.fetch = (async (_url: any, init: any) => {
			authHeaders.push(init?.headers?.Authorization);
			if (authHeaders.length === 1) {
				return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
			}
			return new Response(JSON.stringify(success), { status: 200 });
		}) as typeof fetch;

		const result = await tool.execute("call-1", { session_id: "child-1" });

		assert.deepEqual(authHeaders, ["Bearer old-token", "Bearer new-token"]);
		assert.equal(result.isError, false);
		assert.deepEqual(result.details, success);
		assert.match(result.content[0].text, /team_dismiss dismissed for child-1/);
	});

	it("marks non-structured non-2xx dismiss responses as failed tool results", async () => {
		const tool = registerTeamDismiss();
		globalThis.fetch = (async () => new Response(JSON.stringify({ error: "upstream exploded" }), { status: 500 })) as typeof fetch;

		const result = await tool.execute("call-2", { session_id: "child-2" });

		assert.equal(result.isError, true);
		assert.equal(result.details.status, "failed");
		assert.equal(result.details.sessionId, "child-2");
		assert.equal(result.details.retryable, true);
		assert.equal(result.details.httpStatus, 500);
		assert.match(result.content[0].text, /team_dismiss failed for child-2/);
		assert.match(result.content[0].text, /upstream exploded/);
	});

	it("marks own-child non-structured non-2xx dismiss responses as failed tool results", async () => {
		setEnv("BOBBIT_GOAL_ID", undefined);
		setEnv("BOBBIT_SESSION_ID", "parent-session");
		setEnv("BOBBIT_SESSION_SECRET", "parent-secret");
		const tool = registerOwnChildDismiss();
		globalThis.fetch = (async (_url: any, init: any) => {
			assert.equal(init?.headers?.Authorization, "Bearer old-token");
			assert.equal(init?.headers?.["X-Bobbit-Session-Secret"], "parent-secret");
			return new Response(JSON.stringify({ error: "gateway unavailable" }), { status: 500 });
		}) as typeof fetch;

		const result = await tool.execute("call-3", { session_id: "child-3" });

		assert.equal(result.isError, true);
		assert.equal(result.details.status, "failed");
		assert.equal(result.details.sessionId, "child-3");
		assert.equal(result.details.retryable, true);
		assert.equal(result.details.httpStatus, 500);
		assert.match(result.content[0].text, /team_dismiss failed for child-3/);
		assert.match(result.content[0].text, /gateway unavailable/);
	});
});
