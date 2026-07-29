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

describe("tool result idempotency through Pi's real extension runner", () => {
	it("always snapshots an unchanged result after the complete listener chain", async () => {
		const root = makeRealPiRoot("bobbit-real-pi-result-boundary-dedup-");
		const boundaryPath = path.join(root, "boundary.ts");
		const toolPath = path.join(root, "tool.ts");
		fs.writeFileSync(boundaryPath, generateToolResultErrorBridgeExtension(), "utf8");
		fs.writeFileSync(toolPath, `
import { Type } from "typebox";

export default function (pi) {
  pi.registerTool({
    name: "read_session",
    label: "Read session",
    description: "Unchanged boundary fixture",
    parameters: Type.Object({ session_id: Type.String() }),
    async execute(_toolCallId, params) {
      const envelope = {
        total: 1,
        returned: 1,
        offsetStart: 0,
        offsetEnd: 0,
        messages: [{ index: 0, role: "assistant", text: "bounded once" }],
      };
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        details: { session_id: params.session_id, envelope },
      };
    },
  });
}
`, "utf8");
		const loaded = await loadExtensions([boundaryPath, boundaryPath, toolPath], root);
		assert.deepEqual(loaded.errors, []);
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, {} as never, {} as never);
		const registered = runner.getAllRegisteredTools().find((tool) => tool.definition.name === "read_session");
		assert.ok(registered);
		let verboseReads = 0;
		const input = { session_id: "target" } as Record<string, unknown>;
		Object.defineProperty(input, "verbose", {
			get() {
				verboseReads++;
				return false;
			},
		});
		const executed = await registered.definition.execute(
			"call-1",
			input as never,
			undefined,
			undefined as never,
			{} as never,
		);
		assert.equal(verboseReads, 0, "invocation accessors must not execute during handler projection");
		assert.equal(Object.getOwnPropertySymbols(executed.details as object).length, 0,
			"no digest or marker supplied by a mutable result may be trusted");

		const replacement = await runner.emitToolResult({
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "read_session",
			input,
			content: executed.content,
			details: executed.details,
			isError: false,
		});

		assert.ok(replacement, "the final seam must always return its own canonical snapshot");
		assert.equal(verboseReads, 0, "the final seam must remain descriptor-only for invocation policy inputs");
		assert.notEqual(replacement, executed);
		assert.equal(Object.isFrozen(replacement), true);
		assert.equal(Object.isFrozen(replacement.content), true);
		assert.equal(Object.getOwnPropertySymbols(replacement.details as object).length, 0);
	});
});
