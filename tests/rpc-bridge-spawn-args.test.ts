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
	it("always includes --no-approve so pi never stalls on the 0.79 project-trust gate", () => {
		// Project-trust must be declined deterministically on EVERY spawn,
		// independent of options. Bobbit injects all config via ~/.bobbit/agent
		// and RPC args; it never loads project-local .pi directories.
		for (const opts of [
			{},
			{ initialModel: "anthropic/claude-opus-4-8" },
			{ initialThinkingLevel: "high" },
			{ systemPromptPath: "/tmp/p.md", initialModel: "openai/gpt-4o", initialThinkingLevel: "xhigh" },
			{ args: ["--tools", "read,write"] },
		]) {
			const args = buildAgentArgs(opts);
			assert.ok(args.includes("--no-approve"), `--no-approve must always be present, got: ${args.join(" ")}`);
			assert.ok(!args.includes("--approve"), "must never pass --approve");
		}
	});

	it("strips a caller-supplied --approve and keeps exactly one non-overridable --no-approve", () => {
		// pi parses trust flags last-wins; a trailing --approve would re-enable
		// project-local .pi loading. It must be stripped, leaving the leading
		// --no-approve as the sole, winning trust decision.
		const args = buildAgentArgs({ args: ["--approve"] });
		assert.ok(!args.includes("--approve"), `--approve must be stripped, got: ${args.join(" ")}`);
		assert.equal(
			args.filter((a) => a === "--no-approve").length,
			1,
			`exactly one --no-approve expected, got: ${args.join(" ")}`,
		);
	});

	it("strips the -a short alias for --approve", () => {
		const args = buildAgentArgs({ args: ["-a"] });
		assert.ok(!args.includes("-a"), `-a must be stripped, got: ${args.join(" ")}`);
		assert.ok(!args.includes("--approve"));
		assert.equal(args.filter((a) => a === "--no-approve").length, 1);
	});

	it("de-duplicates a caller-supplied --no-approve (and -na) to a single leading flag", () => {
		for (const dup of ["--no-approve", "-na"]) {
			const args = buildAgentArgs({ args: [dup] });
			assert.ok(!args.includes("-na"), `-na alias must be dropped, got: ${args.join(" ")}`);
			assert.equal(
				args.filter((a) => a === "--no-approve").length,
				1,
				`exactly one --no-approve expected for dup=${dup}, got: ${args.join(" ")}`,
			);
		}
	});

	it("strips trust flags but preserves --extension and other ordering semantics", () => {
		const args = buildAgentArgs({
			initialModel: "anthropic/claude-3-5-sonnet",
			args: ["--approve", "--extension", "/foo.ts", "-na", "--tools", "read"],
		});
		assert.ok(!args.includes("--approve"), "caller --approve stripped");
		assert.ok(!args.includes("-na"), "caller -na stripped");
		assert.equal(args.filter((a) => a === "--no-approve").length, 1, "single --no-approve");
		// Non-trust args survive untouched, in order, after --model.
		const idxModel = args.indexOf("--model");
		const idxExt = args.indexOf("--extension");
		const idxTools = args.indexOf("--tools");
		assert.ok(idxModel >= 0 && idxExt >= 0 && idxTools >= 0);
		assert.ok(idxModel < idxExt && idxExt < idxTools, `expected --model < --extension < --tools, got: ${args.join(" ")}`);
		assert.equal(args[idxExt + 1], "/foo.ts", "--extension value preserved");
		assert.equal(args[idxTools + 1], "read", "--tools value preserved");
	});

	it("includes --model and --thinking when initialModel/initialThinkingLevel are set", () => {
		const args = buildAgentArgs({
			initialModel: "anthropic/claude-3-5-sonnet",
			initialThinkingLevel: "high",
		});
		assert.deepEqual(args, [
			"--mode", "rpc", "--no-approve",
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

	it("accepts every valid thinking level, including xhigh", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
			const args = buildAgentArgs({ initialThinkingLevel: level });
			const idx = args.indexOf("--thinking");
			assert.ok(idx >= 0);
			assert.equal(args[idx + 1], level);
		}
	});

	it("spawn-pins Claude Opus 4.8 with xhigh thinking without falling back", () => {
		const args = buildAgentArgs({
			initialModel: "anthropic/claude-opus-4-8",
			initialThinkingLevel: "xhigh",
		});

		assert.deepEqual(args, [
			"--mode", "rpc", "--no-approve",
			"--model", "anthropic/claude-opus-4-8",
			"--thinking", "xhigh",
		]);
		assert.ok(!args.includes("anthropic/claude-opus-4-7"), "must not substitute the older Pi default");
		assert.ok(!args.includes("anthropic/claude-opus-4-6"), "must not substitute Bobbit's archived placeholder");
	});
});
