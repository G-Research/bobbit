import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { resetAgentDirStateForTests } from "../../src/server/bobbit-dir.js";
import { completeModelText, type ModelCompletionDependencies } from "../../src/server/agent/model-completion.js";
import { modelProbeFailure } from "../../src/server/agent/model-probe-result.js";
import type { ApiModel } from "../../src/server/agent/model-registry.js";

let agentDir: string | undefined;

function useAuth(auth: unknown): void {
	agentDir = mkdtempSync(path.join(tmpdir(), "bobbit-anthropic-probe-"));
	process.env.BOBBIT_AGENT_DIR = agentDir;
	resetAgentDirStateForTests();
	writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: auth }));
}

afterEach(() => {
	if (agentDir) rmSync(agentDir, { recursive: true, force: true });
	agentDir = undefined;
	resetAgentDirStateForTests();
});

const anthropicModel: ApiModel = {
	id: "claude-opus-5",
	name: "Claude Opus 5",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	contextWindow: 200_000,
	maxTokens: 8_192,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	authenticated: true,
};

describe("Anthropic model probe regressions", () => {
	it("preserves API-key authentication selection for direct Pi model completions", async () => {
		useAuth({ type: "api-key", key: "test-anthropic-api-key" });
		const calls: any[] = [];
		const dependencies: ModelCompletionDependencies = {
			env: {},
			providerConfigReader: () => undefined,
		};

		const result = await completeModelText(
			anthropicModel,
			undefined,
			{ systemPrompt: "system", userPrompt: "probe", maxTokens: 5, thinkingLevel: "off" },
			async (_model, _context, options) => {
				calls.push(options);
				return { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop" } as any;
			},
			dependencies,
		);

		assert.equal(result, "OK");
		assert.deepEqual(calls, [{ maxTokens: 5, timeoutMs: 30_000, maxRetries: 0, cacheRetention: "none", apiKey: "test-anthropic-api-key" }]);
	});

	it("keeps model-not-found, authentication, and rate-limit probe outcomes distinct and redacted", () => {
		const sentinel = `upstream-secret-${"z".repeat(48)}`;
		const cases: Array<{ status: 401 | 403 | 404 | 429; code: string }> = [
			{ status: 404, code: "model_not_found" },
			{ status: 401, code: "authentication_failed" },
			{ status: 403, code: "authentication_failed" },
			{ status: 429, code: "rate_limited" },
		];

		for (const { status, code } of cases) {
			const error: Error & { response?: { status: number } } = Object.assign(
				new Error(`Anthropic HTTP ${status}: Authorization: Bearer ${sentinel}`),
				{ response: { status } },
			);
			const result = modelProbeFailure(error, { modelResolved: "claude-opus-5", latencyMs: 12 });
			assert.deepEqual({ status: result.status, code: result.code }, { status, code });
			assert.equal(result.ok, false);
			assert.equal(result.modelResolved, "claude-opus-5");
			assert.equal(result.error.includes(sentinel), false, `HTTP ${status} must redact provider payload secrets`);
			assert.match(result.error, /<redacted-token>/);
		}
	});

	it("recognizes Pi status fields and status-only messages without forwarding their raw provider payload", () => {
		const nested = Object.assign(new Error("opaque failure"), { cause: { statusCode: 429 } });
		assert.deepEqual(modelProbeFailure(nested), {
			ok: false,
			error: "opaque failure",
			status: 429,
			code: "rate_limited",
		});

		const statusOnly = new Error("request rejected: HTTP 404");
		assert.deepEqual({ status: modelProbeFailure(statusOnly).status, code: modelProbeFailure(statusOnly).code }, {
			status: 404,
			code: "model_not_found",
		});
	});
});
