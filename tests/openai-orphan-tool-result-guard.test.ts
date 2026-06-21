import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	dropOrphanFunctionCallOutputsFromPayload,
	generateOpenAiOrphanToolResultExtension,
	OPENAI_ORPHAN_TOOL_RESULT_STATE_SUBDIR,
	resetOpenAiOrphanToolResultExtensionCache,
	writeOpenAiOrphanToolResultExtension,
} from "../src/server/agent/openai-orphan-tool-result-extension.ts";

describe("dropOrphanFunctionCallOutputsFromPayload", () => {
	it("keeps a matching function_call and function_call_output unchanged", () => {
		const payload = {
			model: "codex-test",
			input: [
				{ type: "message", role: "user", content: "hi" },
				{ type: "function_call", call_id: "call-ok", name: "read", arguments: "{}" },
				{ type: "function_call_output", call_id: "call-ok", output: "done" },
			],
		};

		const result = dropOrphanFunctionCallOutputsFromPayload(payload);

		assert.equal(result.changed, false);
		assert.equal(result.dropped, 0);
		assert.equal(result.payload, payload);
	});

	it("drops a payload-leading orphan function_call_output", () => {
		const payload = {
			input: [
				{ type: "function_call_output", call_id: "missing", output: "late" },
				{ type: "message", role: "user", content: "continue" },
			],
		};

		const result = dropOrphanFunctionCallOutputsFromPayload(payload);

		assert.equal(result.changed, true);
		assert.equal(result.dropped, 1);
		assert.deepEqual(result.payload, {
			input: [{ type: "message", role: "user", content: "continue" }],
		});
	});

	it("preserves order and valid pairs while dropping only orphan outputs", () => {
		const validCall = { type: "function_call", call_id: "valid", name: "bash", arguments: "{}" };
		const validOutput = { type: "function_call_output", call_id: "valid", output: "ok" };
		const laterCall = { type: "function_call", call_id: "later", name: "read", arguments: "{}" };
		const payload = {
			metadata: { keep: true },
			input: [
				{ type: "message", role: "user", content: "start" },
				{ type: "function_call_output", call_id: "missing-a", output: "drop-a" },
				validCall,
				validOutput,
				{ type: "function_call_output", call_id: "later", output: "drop-before-call" },
				laterCall,
				{ type: "function_call_output", call_id: "later", output: "keep-after-call" },
				{ type: "message", role: "user", content: "end" },
			],
		};

		const result = dropOrphanFunctionCallOutputsFromPayload(payload);

		assert.equal(result.changed, true);
		assert.equal(result.dropped, 2);
		assert.deepEqual(result.payload, {
			metadata: { keep: true },
			input: [
				{ type: "message", role: "user", content: "start" },
				validCall,
				validOutput,
				laterCall,
				{ type: "function_call_output", call_id: "later", output: "keep-after-call" },
				{ type: "message", role: "user", content: "end" },
			],
		});
	});

	it("no-ops for non-Responses and non-OpenAI-shaped payloads", () => {
		const nonObject = "not a payload";
		const noInput = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
		const nonArrayInput = { input: { type: "message" } };
		const noOutputs = { input: [{ type: "function_call", call_id: "call-1" }] };

		for (const payload of [nonObject, noInput, nonArrayInput, noOutputs]) {
			const result = dropOrphanFunctionCallOutputsFromPayload(payload);
			assert.equal(result.changed, false);
			assert.equal(result.dropped, 0);
			assert.equal(result.payload, payload);
		}
	});

	it("counts dropped diagnostics without exposing raw output content", () => {
		const secretOutput = "SECRET_TOOL_OUTPUT_SHOULD_NOT_BE_LOGGED";
		const payload = {
			input: [
				{ type: "function_call_output", call_id: "missing-a", output: secretOutput },
				{ type: "function_call_output", output: "missing call id" },
			],
		};

		const result = dropOrphanFunctionCallOutputsFromPayload(payload);

		assert.equal(result.dropped, 2);
		assert.equal(result.changed, true);
		assert.equal(JSON.stringify({ dropped: result.dropped }), "{\"dropped\":2}");
		assert.ok(!JSON.stringify({ dropped: result.dropped }).includes(secretOutput));
	});
});

describe("generateOpenAiOrphanToolResultExtension", () => {
	const previousBobbitDir = process.env.BOBBIT_DIR;
	const tempDirs: string[] = [];

	afterEach(() => {
		resetOpenAiOrphanToolResultExtensionCache();
		if (previousBobbitDir === undefined) delete process.env.BOBBIT_DIR;
		else process.env.BOBBIT_DIR = previousBobbitDir;
		for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it("registers the before_provider_request hook and logs only a bounded count", () => {
		const source = generateOpenAiOrphanToolResultExtension();

		assert.ok(source.includes('pi.on("before_provider_request"'));
		assert.ok(source.includes("event && event.payload"));
		assert.ok(source.includes("[bobbit-openai-orphan-guard] Dropped "));
		assert.ok(!source.includes("output:"), "generated log path must not include raw tool output");
	});

	it("writes the guard under a dedicated read-only sandbox mount subdir, not writable tool-guard", () => {
		const bobbitDir = fs.mkdtempSync(path.join(os.tmpdir(), "openai-orphan-guard-"));
		tempDirs.push(bobbitDir);
		process.env.BOBBIT_DIR = bobbitDir;
		resetOpenAiOrphanToolResultExtensionCache();

		const extensionPath = writeOpenAiOrphanToolResultExtension();

		assert.ok(extensionPath, "expected extension path");
		assert.ok(fs.existsSync(extensionPath), "expected extension file to be written");
		assert.ok(
			extensionPath!.includes(path.join("state", OPENAI_ORPHAN_TOOL_RESULT_STATE_SUBDIR)),
			`expected dedicated state subdir path, got ${extensionPath}`,
		);
		assert.ok(
			!extensionPath!.includes(path.join("state", "tool-guard")),
			`OpenAI provider guard must not be written under writable tool-guard, got ${extensionPath}`,
		);
	});
});
