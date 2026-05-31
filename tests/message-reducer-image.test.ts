/**
 * WP1 / RC2 — image rendering from authoritative content (live path).
 *
 * Pins that a server-authoritative `role:"user"` echo carrying `{type:"image"}`
 * content blocks is enriched into a `user-with-attachments` row on the LIVE
 * path (not just on snapshots), so the tile renders without the racy
 * `_pendingAttachments` slot — and that concurrent image prompts never
 * cross-attach (S1) or double-attach. RED on master (live path never enriched).
 * See docs/design/comms-stack/02-analysis.md (S1/S6/S18) and 03 §WP1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	reduce,
	initialState,
	enrichUserMessage,
	type Action,
	type ReducerState,
} from "../src/app/message-reducer.ts";

function liveMessageEnd(seq: number, message: any): Action {
	return { type: "live-event", frame: { type: "message_end", message }, seq, ts: 0 };
}
function applyAll(actions: Action[]): ReducerState {
	let s = initialState();
	for (const a of actions) s = reduce(s, a);
	return s;
}
const imgBlock = (data: string, mimeType = "image/png") => ({ type: "image", data, mimeType });
const userImageEcho = (id: string, text: string, data: string, mimeType = "image/png") => ({
	id,
	role: "user",
	content: [{ type: "text", text }, imgBlock(data, mimeType)],
	timestamp: 0,
});
const optimisticImage = (id: string, text: string, data: string) => ({
	type: "optimistic-prompt" as const,
	message: {
		id,
		role: "user-with-attachments",
		content: [{ type: "text", text }],
		attachments: [
			{ id: "opt", type: "image", fileName: "x.png", mimeType: "image/png", size: 1, content: data, preview: data },
		],
		timestamp: 0,
	},
});

test("live user echo with image blocks → single user-with-attachments row, tile from content", () => {
	const s = applyAll([liveMessageEnd(1, userImageEcho("srv1", "hi", "AAA", "image/jpeg"))]);
	assert.equal(s.messages.length, 1);
	const row = s.messages[0] as any;
	assert.equal(row.role, "user-with-attachments", "live echo must be enriched (was role:'user' on master)");
	assert.equal(row.attachments[0].content, "AAA");
	assert.equal(row.attachments[0].mimeType, "image/jpeg", "preserves the block's own mimeType");
});

test("two concurrent optimistic + two image echoes → exactly 2 rows, each its OWN image (no cross-attach)", () => {
	const s = applyAll([
		optimisticImage("optimistic_1", "first", "AAA"),
		optimisticImage("optimistic_2", "second", "BBB"),
		liveMessageEnd(1, userImageEcho("srv1", "first", "AAA")),
		liveMessageEnd(2, userImageEcho("srv2", "second", "BBB")),
	]);
	assert.equal(s.messages.length, 2, "optimistic rows reconciled away by text; no duplicates");
	const byText: Record<string, string> = {};
	for (const m of s.messages as any[]) {
		const text = m.content.find((c: any) => c.type === "text")?.text;
		byText[text] = m.attachments?.[0]?.content;
	}
	assert.equal(byText["first"], "AAA", "first prompt keeps its own image");
	assert.equal(byText["second"], "BBB", "second prompt keeps its own image (not cross-attached)");
});

test("assistant live message with an image block is NOT enriched (role!=='user' short-circuit)", () => {
	const asst = {
		id: "a1",
		role: "assistant",
		content: [{ type: "text", text: "see this" }, imgBlock("ZZZ")],
		timestamp: 0,
	};
	const s = applyAll([liveMessageEnd(1, asst)]);
	assert.equal(s.messages[0].role, "assistant");
	assert.ok(!(s.messages[0] as any).attachments, "assistant rows are never converted to user-with-attachments");
});

test("enrichUserMessage: pure — user+image enriched; assistant & user-without-image unchanged", () => {
	const enrichedUser = enrichUserMessage(userImageEcho("u", "hi", "AAA"));
	assert.equal(enrichedUser.role, "user-with-attachments");
	const plainUser = { role: "user", content: [{ type: "text", text: "no image" }] };
	assert.equal(enrichUserMessage(plainUser), plainUser, "no-image user row passes through by reference");
	const asst = { role: "assistant", content: [imgBlock("ZZZ")] };
	assert.equal(enrichUserMessage(asst), asst, "assistant row passes through by reference");
});
