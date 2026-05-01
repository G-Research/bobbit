/**
 * Bug 2 — bash_bg.wait toolResult duplicates after snapshot replay.
 *
 * Reproduces the prototype scenario `08-stream-burst-transient-bug` at the
 * reducer boundary. See tests/notes/bug2-investigation.md for the full
 * investigation.
 *
 * Action sequence (representative of the bg-3 cycle in scenario 08):
 *   1. live-event: assistant `message_end` carrying the wait toolCall.
 *      `RemoteAgent.handleAgentEvent` stamps a `synth:tc:<toolCallId>` id
 *      via `computeStreamingMessageId` because the upstream `msg.id` is
 *      missing (mock-agent-core.mjs::_handleRealBgWait emits id-less
 *      assistant messages — same pattern real LLMs use).
 *   2. live-event: bash_bg toolResult `message_end` with NO id at all.
 *   3. snapshot replay: triggered in production by nav-stress →
 *      `requestMessages` → server replay; the server has assigned its own
 *      ids to BOTH the assistant and the toolResult.
 *
 * On master the snapshot survivor filter (`message-reducer.ts:118-128`)
 * drops live rows ONLY when their string id is present in the snapshot.
 * The id-less live toolResult row from step 2 passes through, and the
 * snapshot then adds its own id'd copy → two toolResult rows for the
 * same `toolCallId`.
 *
 * On master: `count === 2` (BUG).
 * After fix: `count === 1`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reduce, initialState } from "../src/app/message-reducer.ts";

const TC_ID = "tc-bg3";
const SYNTH_ID = `synth:tc:${TC_ID}`;

function makeAssistantWaitMsg(id: string | undefined): any {
	const msg: any = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: TC_ID,
				name: "bash_bg",
				arguments: { action: "wait", id: "bg-3", name: "long task" },
				input: { action: "wait", id: "bg-3", name: "long task" },
			},
		],
	};
	if (id !== undefined) msg.id = id;
	return msg;
}

function makeToolResultMsg(id?: string): any {
	const msg: any = {
		role: "toolResult",
		toolCallId: TC_ID,
		toolName: "bash_bg",
		isError: false,
		content: [{ type: "text", text: "bg-3 done" }],
	};
	if (id !== undefined) msg.id = id;
	return msg;
}

function countToolResultsForToolCall(messages: any[], toolCallId: string): number {
	return messages.filter((m) => m.role === "toolResult" && m.toolCallId === toolCallId).length;
}

function countAssistantToolCalls(messages: any[], toolCallId: string): number {
	return messages.filter(
		(m) =>
			m.role === "assistant" &&
			Array.isArray(m.content) &&
			m.content.some((c: any) => c?.type === "toolCall" && c.id === toolCallId),
	).length;
}

describe("Bug 2: bash_bg.wait toolResult duplicates after snapshot replay (scenario 08, bg-3)", () => {
	it("id-less live toolResult survives snapshot merge \u2192 duplicate (REPRO)", () => {
		let s = initialState();

		// 1. Live: assistant wait toolCall, synth-id'd at remote-agent.
		s = reduce(s, {
			type: "live-event",
			frame: { type: "message_end", message: makeAssistantWaitMsg(SYNTH_ID) },
			seq: 100,
		});

		// 2. Live: id-less toolResult (matches mock-agent-core::_handleRealBgWait).
		s = reduce(s, {
			type: "live-event",
			frame: { type: "message_end", message: makeToolResultMsg(/* no id */) },
			seq: 101,
		});

		// Sanity: both rows landed.
		assert.equal(s.messages.length, 2, "two live rows after the bg-3 cycle");

		// 3. Snapshot replay (nav-away / nav-back). Server has its own ids.
		const serverAssistMsg = makeAssistantWaitMsg("server-assist-bg3");
		const serverToolResultMsg = makeToolResultMsg("server-tr-bg3");
		s = reduce(s, {
			type: "snapshot",
			messages: [serverAssistMsg, serverToolResultMsg],
		});

		const trCount = countToolResultsForToolCall(s.messages, TC_ID);
		const assistCount = countAssistantToolCalls(s.messages, TC_ID);

		// On master the live id-less toolResult survives the snapshot filter
		// AND the snapshot row is added on top \u2192 trCount === 2.
		assert.equal(
			trCount,
			1,
			`toolResult for ${TC_ID} must appear exactly once after snapshot merge ` +
				`(got ${trCount}; messages=${JSON.stringify(s.messages.map((m) => ({ id: m.id, role: m.role, toolCallId: (m as any).toolCallId })))})`,
		);

		// Symmetric assertion for the assistant wait toolCall row. The live
		// row was stamped with the synthetic id; the snapshot row carries the
		// server's real id. Same hazard \u2192 both survive on master.
		assert.equal(
			assistCount,
			1,
			`assistant wait toolCall for ${TC_ID} must appear exactly once after snapshot merge (got ${assistCount})`,
		);

		// Total transcript size: at most one assistant + one toolResult per cycle.
		assert.equal(
			s.messages.length,
			2,
			`messages.length after snapshot must be 2 (got ${s.messages.length}; one cycle = 1 assistant + 1 toolResult)`,
		);
	});

	it("control: when the live toolResult HAS the same string id as the snapshot, no duplicate", () => {
		// Pin the reducer's id-equality short-circuit. This case PASSES on
		// master \u2014 it isolates the bug to the id-less branch.
		let s = initialState();
		s = reduce(s, {
			type: "live-event",
			frame: { type: "message_end", message: makeAssistantWaitMsg("server-assist-bg3") },
			seq: 100,
		});
		s = reduce(s, {
			type: "live-event",
			frame: { type: "message_end", message: makeToolResultMsg("server-tr-bg3") },
			seq: 101,
		});
		s = reduce(s, {
			type: "snapshot",
			messages: [makeAssistantWaitMsg("server-assist-bg3"), makeToolResultMsg("server-tr-bg3")],
		});

		assert.equal(countToolResultsForToolCall(s.messages, TC_ID), 1);
		assert.equal(countAssistantToolCalls(s.messages, TC_ID), 1);
		assert.equal(s.messages.length, 2);
	});

	it("multi-cycle (cycles 1..3): every toolResult must appear exactly once after final snapshot", () => {
		// Closer to the prototype's STREAM_BURST:3 shape. Three full cycles
		// of (assistant wait + id-less toolResult) interleaved with text
		// chunks; final snapshot replay carries server-id'd copies. On
		// master the bg-3 cycle's id-less rows duplicate; this assertion
		// fails with `count = 2` for at least one of bg-1/bg-2/bg-3.
		let s = initialState();
		const cycleIds = ["bg-1", "bg-2", "bg-3"];
		const tcIds = cycleIds.map((c) => `tc-${c}`);

		let seq = 100;
		for (let i = 0; i < cycleIds.length; i++) {
			const tcid = tcIds[i];
			const assist: any = {
				role: "assistant",
				id: `synth:tc:${tcid}`,
				content: [{ type: "toolCall", id: tcid, name: "bash_bg", input: { action: "wait", id: cycleIds[i] } }],
			};
			const tr: any = {
				role: "toolResult",
				toolCallId: tcid,
				toolName: "bash_bg",
				isError: false,
				content: [{ type: "text", text: `${cycleIds[i]} done` }],
			};
			s = reduce(s, { type: "live-event", frame: { type: "message_end", message: assist }, seq: seq++ });
			s = reduce(s, { type: "live-event", frame: { type: "message_end", message: tr }, seq: seq++ });
		}

		// Server snapshot: every row has a server-assigned id.
		const snapshot = tcIds.flatMap((tcid, i) => {
			const assist: any = {
				role: "assistant",
				id: `srv-a-${tcid}`,
				content: [{ type: "toolCall", id: tcid, name: "bash_bg", input: { action: "wait", id: cycleIds[i] } }],
			};
			const tr: any = {
				role: "toolResult",
				id: `srv-tr-${tcid}`,
				toolCallId: tcid,
				toolName: "bash_bg",
				isError: false,
				content: [{ type: "text", text: `${cycleIds[i]} done` }],
			};
			return [assist, tr];
		});
		s = reduce(s, { type: "snapshot", messages: snapshot });

		for (const tcid of tcIds) {
			assert.equal(
				countToolResultsForToolCall(s.messages, tcid),
				1,
				`toolResult for ${tcid} must appear exactly once after snapshot (the bg-3 cycle is the canonical fail in scenario 08)`,
			);
			assert.equal(
				countAssistantToolCalls(s.messages, tcid),
				1,
				`assistant wait toolCall for ${tcid} must appear exactly once after snapshot`,
			);
		}

		// 3 cycles \u00d7 (1 assistant + 1 toolResult) = 6 rows total.
		assert.equal(
			s.messages.length,
			6,
			`messages.length must be 6 after 3 cycles + snapshot (got ${s.messages.length})`,
		);
	});
});
