import assert from "node:assert/strict";

import { afterEach, describe, it } from "vitest";

import {
	bytes,
	cleanupRealPiRoots,
	createLifecycleSession,
	loadRealPiLifecycleBoundaryFixture,
	persistOutcome,
	READ_SESSION_FINAL_RESULT_MAX_BYTES,
	runLifecycle,
	toolOutcome,
} from "./tool-result-error-bridge-real-pi-fixture.js";

afterEach(cleanupRealPiRoots);

describe("post-result listeners through Pi's real extension runner", () => {
	it("reprojects late mutations without evaluating hostile post-chain accessors", async () => {
		const { root, loaded, postChainAccessorCounter } = await loadRealPiLifecycleBoundaryFixture();
		for (const latePhaseAttack of ["return", "mutate", "mutate_throw"] as const) {
			const lateSession = createLifecycleSession(loaded, root, {
				session_id: "target",
				include_tool_results: true,
				limit: 1,
				late_phase_attack: latePhaseAttack,
			});
			const lateEvents = await runLifecycle(lateSession, `late ${latePhaseAttack}`);
			const { emitted: lateEnd, persisted: lateMessage } = toolOutcome(lateEvents);
			const lateStored = persistOutcome(lateSession);
			const stateMessage = lateSession.state.messages.find((message) => message.role === "toolResult") as any;
			assert.ok(stateMessage);
			assert.ok(bytes(lateEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(bytes(lateMessage) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(Buffer.byteLength(lateStored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.deepEqual(stateMessage.content, lateStored.roundTrip.content);
			for (const sentinel of [
				"TOOL_END_PROVIDER_DATA",
				"TOOL_END_PROVIDER_SIGNATURE",
				"TOOL_END_USAGE",
				"MESSAGE_END_PROVIDER_DATA",
				"MESSAGE_END_PROVIDER_SIGNATURE",
				"MESSAGE_END_USAGE",
			]) {
				assert.equal(JSON.stringify(lateEnd.result).includes(sentinel), false);
				assert.equal(JSON.stringify(stateMessage).includes(sentinel), false);
				assert.equal(lateStored.line.includes(sentinel), false);
			}
		}

		for (const accessorAttack of ["tool_return", "tool_in_place", "message_return", "message_in_place"] as const) {
			const accessorSession = createLifecycleSession(loaded, root, {
				session_id: "target",
				include_tool_results: true,
				limit: 1,
				post_chain_accessor_attack: accessorAttack,
			});
			const accessorEvents = await runLifecycle(accessorSession, `post-chain accessor ${accessorAttack}`);
			const { emitted: accessorEnd, persisted: accessorMessage } = toolOutcome(accessorEvents);
			const accessorStored = persistOutcome(accessorSession);
			const stateMessage = accessorSession.state.messages.find((message) => message.role === "toolResult") as any;
			assert.ok(stateMessage, "the bounded result must remain in Agent state");
			assert.ok(accessorSession.state.messages.some((message) =>
				message.role === "assistant" && (message as any).stopReason === "stop"), "the turn must complete");
			assert.ok(bytes(accessorEnd.result) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(bytes(accessorMessage) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(bytes(stateMessage) <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.ok(Buffer.byteLength(accessorStored.line, "utf8") <= READ_SESSION_FINAL_RESULT_MAX_BYTES);
			assert.deepEqual(stateMessage.content, accessorStored.roundTrip.content);
			assert.equal(accessorStored.roundTrip.toolName, "read_session");
		}
		assert.equal(postChainAccessorCounter.installed, 18,
			"each returned and in-place accessor scenario must reach its real Pi listener");
		assert.equal(postChainAccessorCounter.reads, 0,
			"post-chain returned and in-place accessors must never execute outside Pi's listener try/catch");

	});
});
