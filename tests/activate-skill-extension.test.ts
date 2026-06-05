/**
 * Reproducing test for Defect A of the broken `activate_skill` tool.
 *
 * `defaults/tools/skills/extension.ts` declares its handler as
 * `async execute(input: { name: string; args?: string })` and reads
 * `input.name` / `input.args`. But pi's `ToolDefinition.execute` contract
 * passes arguments as `execute(toolCallId, params, signal, onUpdate, ctx)` —
 * params are the SECOND argument. So `input` is actually the tool-call id
 * string, `input.name` / `input.args` are `undefined`, and the request body
 * sent to the gateway is `{"args":""}` with no `name`. The gateway then
 * rejects with 400 `name is required`.
 *
 * This test exercises the REAL extension `execute()` path using pi's actual
 * calling convention `(toolCallId, params)` and asserts that the captured
 * request body carries both `name` and `args`. It WILL FAIL on the current
 * (buggy) code — that is the reproduction. It passes once the handler reads
 * params from the second argument.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import registerSkillsExtension from "../defaults/tools/skills/extension.ts";

type ExecuteFn = (
	toolCallId: string,
	params: unknown,
	signal?: unknown,
	onUpdate?: unknown,
	ctx?: unknown,
) => Promise<any>;

function makeStubApi(): { api: any; getExecute: () => ExecuteFn } {
	let captured: ExecuteFn | null = null;
	const api = {
		registerTool(config: any) {
			if (config?.name === "activate_skill" && typeof config?.execute === "function") {
				captured = config.execute.bind(config);
			}
		},
	};
	return {
		api,
		getExecute: () => {
			if (!captured) throw new Error("activate_skill execute was not registered");
			return captured;
		},
	};
}

describe("activate_skill extension execute — params reach request body (Defect A)", () => {
	let execute: ExecuteFn;
	const envBackup: Record<string, string | undefined> = {};
	let realFetch: typeof globalThis.fetch;
	let capturedBody: any = null;

	before(() => {
		for (const key of ["BOBBIT_SESSION_ID", "BOBBIT_TOKEN", "BOBBIT_GATEWAY_URL"]) {
			envBackup[key] = process.env[key];
		}
		process.env.BOBBIT_SESSION_ID = "test-session-id";
		process.env.BOBBIT_TOKEN = "test-token";
		process.env.BOBBIT_GATEWAY_URL = "https://gateway.test";

		// Stub global fetch to capture the request body the extension sends.
		realFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: any, init: any) => {
			capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
			return {
				ok: true,
				status: 200,
				async text() {
					return JSON.stringify({ expanded: "BODY", source: "project", filePath: "/x/SKILL.md" });
				},
			} as any;
		}) as any;

		const { api, getExecute } = makeStubApi();
		registerSkillsExtension(api);
		execute = getExecute();
	});

	after(() => {
		globalThis.fetch = realFetch;
		for (const key of ["BOBBIT_SESSION_ID", "BOBBIT_TOKEN", "BOBBIT_GATEWAY_URL"]) {
			if (envBackup[key] === undefined) delete process.env[key];
			else process.env[key] = envBackup[key]!;
		}
	});

	it("sends model-supplied name and args from the SECOND execute argument", async () => {
		capturedBody = null;
		// pi's calling convention: execute(toolCallId, params, ...)
		await execute("toolu_TESTID", { name: "resolve-pr-conflicts", args: "497" });

		assert.ok(capturedBody, "activate_skill should have sent a request body to the gateway");
		assert.equal(
			capturedBody.name,
			"resolve-pr-conflicts",
			`activate_skill request body must carry name from params; got ${JSON.stringify(capturedBody)}`,
		);
		assert.equal(
			capturedBody.args,
			"497",
			`activate_skill request body must carry args from params; got ${JSON.stringify(capturedBody)}`,
		);
	});
});
