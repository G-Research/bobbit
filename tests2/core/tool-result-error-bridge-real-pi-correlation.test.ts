import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, it } from "vitest";

import {
	cleanupRealPiRoots,
	ExtensionRunner,
	generateToolResultErrorBridgeExtension,
	loadExtensions,
	makeRealPiRoot,
} from "./tool-result-error-bridge-real-pi-fixture.js";

afterEach(cleanupRealPiRoots);

describe("tool result correlation through Pi's real extension runner", () => {
	it("retains only fixed-bounded digests for many oversized provider call IDs", async () => {
		const root = makeRealPiRoot("bobbit-real-pi-result-call-map-");
		const boundaryPath = path.join(root, "boundary.ts");
		fs.writeFileSync(boundaryPath, generateToolResultErrorBridgeExtension(), "utf8");
		const loaded = await loadExtensions([boundaryPath], root);
		assert.deepEqual(loaded.errors, []);
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, {} as never, {} as never);
		const diagnosticsSymbol = Symbol.for("bobbit.tool-result.read-session-call-map-diagnostics.v1");
		let lastNormalizedId = "";

		for (let index = 0; index < 16; index++) {
			const prefix = `${index}:`;
			const providerId = prefix + "x".repeat(2 * 1024 * 1024 - prefix.length);
			const normalized = await runner.emitMessageEnd({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{
						type: "toolCall",
						id: providerId,
						name: "read_session",
						arguments: { session_id: `target-${index}` },
					}],
				},
			} as never) as any;
			lastNormalizedId = normalized.content[0].id;
			assert.match(lastNormalizedId, /^brs1:[0-9a-f]{40}$/);
			assert.notEqual(lastNormalizedId, providerId);
		}

		const envelope = {
			total: 1,
			returned: 1,
			offsetStart: 0,
			offsetEnd: 0,
			messages: [{ index: 0, role: "assistant", text: "correlated" }],
		};
		const correlated = await runner.emitToolResult({
			type: "tool_result",
			toolCallId: lastNormalizedId,
			content: [{ type: "text", text: JSON.stringify(envelope) }],
			isError: false,
		} as never) as any;
		assert.equal(JSON.parse(correlated.content[0].text).messages[0].text, "correlated",
			"the normalized ID must still resolve the correct read_session parameters");

		for (let index = 0; index < 300; index++) {
			await runner.emitMessageEnd({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{
						type: "toolCall",
						id: `small-${index}`,
						name: "read_session",
						arguments: { session_id: `target-${index}` },
					}],
				},
			} as never);
		}

		const inspect = (runner as any)[diagnosticsSymbol];
		assert.equal(typeof inspect, "function");
		const diagnostics = inspect.call(runner);
		assert.deepEqual(
			{
				entries: diagnostics.entries,
				maxEntries: diagnostics.maxEntries,
				correlationKeyUnits: diagnostics.correlationKeyUnits,
				maxKeyUnits: diagnostics.maxKeyUnits,
			},
			{ entries: 256, maxEntries: 256, correlationKeyUnits: 45, maxKeyUnits: 45 },
		);
		assert.ok(diagnostics.maxValueStringUnits <= 128);
		assert.ok(diagnostics.totalRetainedStringUnits <= 256 * (45 + 128 + 64 + 64),
			"all retained map keys and string values must have a fixed aggregate bound");
	});
});
