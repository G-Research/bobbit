import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveServerInitialModelTuple } from "../../../src/server/server.js";

const SERVER_SOURCE = readFileSync(new URL("../../../src/server/server.ts", import.meta.url), "utf8");

describe("server Pi 0.82 exact tuple inheritance", () => {
	it("prefers durable effective thinking, falls back to the live mirror, and leaves final clamping to SessionManager", () => {
		expect(resolveServerInitialModelTuple({
			modelProvider: "anthropic",
			modelId: "claude-opus-5",
			effectiveThinkingLevel: "xhigh",
		}, {
			spawnPinnedThinkingLevel: "low",
		})).toEqual({
			initialModel: "anthropic/claude-opus-5",
			initialThinkingLevel: "xhigh",
		});

		expect(resolveServerInitialModelTuple({
			modelProvider: "openai",
			modelId: "gpt-4.1-mini",
			effectiveThinkingLevel: "xhigh",
		})).toEqual({
			initialModel: "openai/gpt-4.1-mini",
			initialThinkingLevel: "xhigh",
		});

		expect(resolveServerInitialModelTuple({
			modelProvider: "local-reasoner",
			modelId: "reasoner-v1",
			effectiveThinkingLevel: "high",
		})).toEqual({
			initialModel: "local-reasoner/reasoner-v1",
			initialThinkingLevel: "high",
		});

		expect(resolveServerInitialModelTuple({
			modelProvider: "aigw",
			modelId: "kimi-coding/claude-opus-5",
		}, {
			spawnPinnedThinkingLevel: "high",
		})).toEqual({
			initialModel: "aigw/kimi-coding/claude-opus-5",
			initialThinkingLevel: "high",
		});
	});

	it("uses the shared tuple resolver at orchestration, fork, and continue server boundaries", () => {
		const uses = SERVER_SOURCE.match(/resolveServerInitialModelTuple\(/g) ?? [];
		expect(uses.length).toBeGreaterThanOrEqual(4);
		expect(SERVER_SOURCE).toMatch(/resolveSessionThinking:[\s\S]{0,500}resolveServerInitialModelTuple/);

		const forkStart = SERVER_SOURCE.indexOf("// POST /api/sessions/:id/fork");
		const continueStart = SERVER_SOURCE.indexOf("// POST /api/sessions/:archivedId/continue", forkStart);
		const forkSource = SERVER_SOURCE.slice(forkStart, continueStart);
		const continueSource = SERVER_SOURCE.slice(continueStart);
		expect(forkSource).toContain("resolveServerInitialModelTuple(ps, source)");
		expect(continueSource).toContain("resolveServerInitialModelTuple(ps)");
	});

	it("normalizes legacy AIGW spellings before the server-owned current-catalog comparison", () => {
		const start = SERVER_SOURCE.indexOf("const requireCurrentSessionModel = async");
		const end = SERVER_SOURCE.indexOf("// Roles/tools resolution", start);
		const helper = SERVER_SOURCE.slice(start, end);
		expect(helper).toMatch(/const normalizedModel = normalizeAigwModelString\(modelString\)/);
		expect(helper.indexOf("normalizeAigwModelString(modelString)")).toBeLessThan(helper.indexOf(".indexOf(\"/\")"));
		expect(helper).toContain("normalizedModel.slice(slash + 1)");
	});
});
