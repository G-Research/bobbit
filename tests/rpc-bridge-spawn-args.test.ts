/**
 * Unit test: RpcBridge agent arg construction.
 *
 * Verifies that initialModel/initialThinkingLevel options are translated into
 * `--model <provider>/<modelId>` and `--thinking <level>` CLI flags, ordered
 * before caller-supplied args, so pi-coding-agent boots straight into the
 * configured model and never emits the redundant initial `model_change` event
 * with its hardcoded default.
 *
 * Run with:
 *   npx tsx --test --test-force-exit tests/rpc-bridge-spawn-args.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAgentArgs } from "../src/server/agent/rpc-bridge.ts";

describe("buildAgentArgs", () => {
	it("includes --model and --thinking when initialModel/initialThinkingLevel are set", () => {
		const args = buildAgentArgs({
			initialModel: "anthropic/claude-3-5-sonnet",
			initialThinkingLevel: "high",
		});
		assert.deepEqual(args, [
			"--mode", "rpc",
			"--model", "anthropic/claude-3-5-sonnet",
			"--thinking", "high",
		]);
	});

	it("places --model before caller-supplied args (so caller-supplied overrides win)", () => {
		const args = buildAgentArgs({
			initialModel: "anthropic/claude-3-5-sonnet",
			args: ["--tools", "read,write", "--extension", "/foo.ts"],
		});
		const idxModel = args.indexOf("--model");
		const idxTools = args.indexOf("--tools");
		const idxExt = args.indexOf("--extension");
		assert.ok(idxModel >= 0);
		assert.ok(idxModel < idxTools, "--model must come before caller --tools");
		assert.ok(idxModel < idxExt, "--model must come before caller --extension");
	});

	it("places --system-prompt before --model (system-prompt is pi-internal, model is post-system)", () => {
		const args = buildAgentArgs({
			systemPromptPath: "/tmp/p.md",
			initialModel: "openai/gpt-4o",
		});
		const idxSys = args.indexOf("--system-prompt");
		const idxModel = args.indexOf("--model");
		assert.ok(idxSys >= 0 && idxModel >= 0);
		assert.ok(idxSys < idxModel);
	});

	it("omits --model when initialModel is missing", () => {
		const args = buildAgentArgs({});
		assert.ok(!args.includes("--model"));
		assert.ok(!args.includes("--thinking"));
	});

	it("ignores malformed initialModel (no slash, leading slash, trailing slash)", () => {
		for (const bad of ["no-slash-here", "/leading", "trailing/", "/", ""]) {
			const args = buildAgentArgs({ initialModel: bad });
			assert.ok(!args.includes("--model"), `should ignore "${bad}", got: ${args.join(" ")}`);
		}
	});

	it("ignores invalid thinking levels", () => {
		for (const bad of ["bogus", "MEDIUM", "max", ""]) {
			const args = buildAgentArgs({ initialThinkingLevel: bad });
			assert.ok(!args.includes("--thinking"), `should ignore "${bad}", got: ${args.join(" ")}`);
		}
	});

	it("accepts all five valid thinking levels", () => {
		for (const level of ["off", "minimal", "low", "medium", "high"]) {
			const args = buildAgentArgs({ initialThinkingLevel: level });
			const idx = args.indexOf("--thinking");
			assert.ok(idx >= 0);
			assert.equal(args[idx + 1], level);
		}
	});
});
