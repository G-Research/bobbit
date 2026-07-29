import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, it } from "vitest";

import {
	cleanupRealPiRoots,
	createLifecycleSession,
	generateToolResultErrorBridgeExtension,
	loadExtensions,
	makeRealPiRoot,
	makeSequenceStream,
	runLifecycle,
} from "./tool-result-error-bridge-real-pi-fixture.js";

afterEach(cleanupRealPiRoots);

describe("tool result correlation through Pi's real extension runner", () => {
	it("does not let cached IDs capture an explicitly named non-read tool", async () => {
		const root = makeRealPiRoot("bobbit-real-pi-result-collision-");
		const boundaryPath = path.join(root, "boundary.ts");
		const toolsPath = path.join(root, "tools.ts");
		fs.writeFileSync(boundaryPath, generateToolResultErrorBridgeExtension(), "utf8");
		fs.writeFileSync(toolsPath, `
import { Type } from "typebox";

export default function (pi) {
  pi.registerTool({
    name: "read_session",
    label: "Read session",
    description: "Collision setup",
    parameters: Type.Object({ session_id: Type.String() }),
    async execute() {
      const envelope = {
        total: 1,
        returned: 1,
        offsetStart: 0,
        offsetEnd: 0,
        messages: [{ index: 0, role: "assistant", text: "bounded read" }],
      };
      return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
    },
  });
  pi.registerTool({
    name: "collision_probe",
    label: "Collision probe",
    description: "Must remain ordinary tool output",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: "NON_READ_COLLISION_PASSTHROUGH" }],
        details: { providerMetadata: "NON_READ_COLLISION_DETAILS" },
        usage: { providerMetadata: "NON_READ_COLLISION_USAGE" },
      };
    },
  });
}
`, "utf8");

		const loaded = await loadExtensions([boundaryPath, toolsPath], root);
		assert.deepEqual(loaded.errors, []);
		const collisionId = "shared-provider-call-id";
		const streamFn = makeSequenceStream([
			{ name: "read_session", arguments: { session_id: "target" }, id: collisionId },
			{ name: "collision_probe", arguments: {}, id: collisionId },
		]);
		const session = createLifecycleSession(
			loaded,
			root,
			{ session_id: "target" },
			"read_session",
			collisionId,
			streamFn,
		);
		const events = await runLifecycle(session, "run colliding tools");
		const emitted = events.find((event) =>
			event.type === "tool_execution_end" && event.toolName === "collision_probe");
		assert.ok(emitted);
		assert.equal(emitted.result.content[0].text, "NON_READ_COLLISION_PASSTHROUGH");
		assert.deepEqual(emitted.result.details, { providerMetadata: "NON_READ_COLLISION_DETAILS" });
		assert.deepEqual(emitted.result.usage, { providerMetadata: "NON_READ_COLLISION_USAGE" });

		const stateResult = session.state.messages.find((message) =>
			message.role === "toolResult" && (message as any).toolName === "collision_probe") as any;
		assert.ok(stateResult, "the non-read result must reach AgentSession state");
		assert.equal(stateResult.toolCallId, collisionId);
		assert.equal(stateResult.content[0].text, "NON_READ_COLLISION_PASSTHROUGH");
		assert.deepEqual(stateResult.details, { providerMetadata: "NON_READ_COLLISION_DETAILS" });

		const sessionFile = session.sessionManager.getSessionFile();
		assert.ok(sessionFile);
		const persistedLine = fs.readFileSync(sessionFile, "utf8")
			.split(/\r?\n/)
			.find((line) => line.includes('"toolName":"collision_probe"'));
		assert.ok(persistedLine, "the non-read result must be persisted");
		assert.equal(persistedLine.includes("NON_READ_COLLISION_PASSTHROUGH"), true);
		assert.equal(persistedLine.includes("NON_READ_COLLISION_DETAILS"), true);
	});
});
