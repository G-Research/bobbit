/**
 * Unit tests for the action-endpoint authorization guard
 * (src/server/extension-host/action-guard.ts) — design
 * docs/design/extension-host.md §4b steps 1–6 / §5 controls i, ii, iii, iii-b.
 *
 * Pinned invariants:
 *   - Missing x-bobbit-session-id header → 403 (allowlist-bypass fix, §5 i).
 *   - body.sessionId !== header → 403 BEFORE any allowedTools/toolUseId check (§5 iii-b).
 *   - Unknown session → 403; :tool ∉ allowedTools → 403.
 *   - :action ∉ declared actions.names → 404.
 *   - Forged/absent toolUseId → 409; valid toolUseId of a DIFFERENT tool or in a
 *     DIFFERENT session → 409 (verifyToolUse is bound to the HEADER session, §5 iii).
 *   - transcriptHasToolUse matches id + tool name across Anthropic + pi shapes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	authorizeActionRequest,
	transcriptHasToolUse,
	type ActionGuardInput,
	type ActionGuardSession,
} from "../src/server/extension-host/action-guard.ts";

const SID = "sess-1";

function baseInput(over: Partial<ActionGuardInput> = {}): ActionGuardInput {
	return {
		tool: "sample_action",
		action: "retry",
		headerSessionId: SID,
		bodySessionId: SID,
		toolUseId: "tu-1",
		resolveSession: (id: string): ActionGuardSession | undefined =>
			id === SID ? { allowedTools: ["sample_action"] } : undefined,
		actionNames: ["retry"],
		verifyToolUse: (sid: string, tu: string, tool: string) =>
			sid === SID && tu === "tu-1" && tool === "sample_action",
		...over,
	};
}

describe("authorizeActionRequest — happy path", () => {
	it("passes a valid request and returns the header-bound session id", async () => {
		const r = await authorizeActionRequest(baseInput());
		assert.deepEqual(r, { ok: true, sessionId: SID });
	});

	it("allows the tool when the session has no allowlist (unrestricted)", async () => {
		const r = await authorizeActionRequest(baseInput({ resolveSession: () => ({ allowedTools: undefined }) }));
		assert.equal(r.ok, true);
	});
});

describe("authorizeActionRequest — identity + allowlist (§5 i / iii-b)", () => {
	it("missing x-bobbit-session-id header → 403", async () => {
		const r = await authorizeActionRequest(baseInput({ headerSessionId: undefined }));
		assert.deepEqual(r, { ok: false, status: 403, error: "Missing x-bobbit-session-id header" });
	});

	it("body.sessionId mismatching the header → 403 (checked before allowedTools/toolUseId)", async () => {
		// Even with an allowed tool + valid toolUseId, a mismatch fails fast.
		const r = await authorizeActionRequest(baseInput({ bodySessionId: "other-session" }));
		assert.equal(r.ok, false);
		assert.equal((r as { status: number }).status, 403);
	});

	it("non-string body.sessionId → 403", async () => {
		const r = await authorizeActionRequest(baseInput({ bodySessionId: undefined }));
		assert.equal((r as { status: number }).status, 403);
	});

	it("unknown session → 403", async () => {
		const r = await authorizeActionRequest(baseInput({ resolveSession: () => undefined }));
		assert.equal((r as { status: number }).status, 403);
	});

	it(":tool ∉ session.allowedTools → 403 (the curl-bypass gate)", async () => {
		const r = await authorizeActionRequest(baseInput({ resolveSession: () => ({ allowedTools: ["something_else"] }) }));
		assert.equal((r as { status: number }).status, 403);
	});
});

describe("authorizeActionRequest — action allowlist + toolUseId (§5 ii / iii)", () => {
	it(":action ∉ declared actions.names → 404", async () => {
		const r = await authorizeActionRequest(baseInput({ action: "not-declared" }));
		assert.equal((r as { status: number }).status, 404);
	});

	it("absent toolUseId → 409", async () => {
		const r = await authorizeActionRequest(baseInput({ toolUseId: undefined }));
		assert.equal((r as { status: number }).status, 409);
	});

	it("forged toolUseId not present in the transcript → 409", async () => {
		const r = await authorizeActionRequest(baseInput({ verifyToolUse: () => false }));
		assert.equal((r as { status: number }).status, 409);
	});

	it("valid toolUseId but belonging to a DIFFERENT tool → 409", async () => {
		// verifyToolUse is asked for (SID, tu-1, sample_action); a transcript whose
		// tu-1 was a call of a different tool yields false → 409.
		const r = await authorizeActionRequest(baseInput({
			verifyToolUse: (_sid, _tu, tool) => tool === "OTHER_TOOL",
		}));
		assert.equal((r as { status: number }).status, 409);
	});

	it("toolUseId verified ONLY against the header-bound session (cross-session forgery → 409)", async () => {
		// A toolUseId that exists in some OTHER session must not authorize: the
		// guard binds verifyToolUse to the header session id.
		const r = await authorizeActionRequest(baseInput({
			verifyToolUse: (sid) => sid === "other-session",
		}));
		assert.equal((r as { status: number }).status, 409);
	});
});

describe("transcriptHasToolUse", () => {
	const line = (obj: unknown) => JSON.stringify(obj);

	it("matches an Anthropic tool_use block by id + name", () => {
		const jsonl = [
			line({ type: "message", message: { role: "assistant", content: [
				{ type: "text", text: "hi" },
				{ type: "tool_use", id: "tu-1", name: "sample_action", input: {} },
			] } }),
		].join("\n");
		assert.equal(transcriptHasToolUse(jsonl, "tu-1", "sample_action"), true);
		assert.equal(transcriptHasToolUse(jsonl, "tu-1", "other_tool"), false, "name must match");
		assert.equal(transcriptHasToolUse(jsonl, "tu-2", "sample_action"), false, "id must match");
	});

	it("matches a pi-coding-agent toolCallId/toolName shape", () => {
		const jsonl = line({ type: "message", message: { role: "assistant", content: [
			{ toolCallId: "tu-9", toolName: "sample_action" },
		] } });
		assert.equal(transcriptHasToolUse(jsonl, "tu-9", "sample_action"), true);
	});

	it("is case-insensitive on the tool name and tolerant of junk lines", () => {
		const jsonl = [
			"not json",
			line({ type: "message", message: { role: "assistant", content: [
				{ type: "tool_use", id: "tu-1", name: "Sample_Action" },
			] } }),
			"",
		].join("\n");
		assert.equal(transcriptHasToolUse(jsonl, "tu-1", "sample_action"), true);
	});

	it("returns false for empty/null content", () => {
		assert.equal(transcriptHasToolUse(null, "tu-1", "t"), false);
		assert.equal(transcriptHasToolUse("", "tu-1", "t"), false);
		assert.equal(transcriptHasToolUse(line({ type: "message", message: { role: "user", content: "hello" } }), "tu-1", "t"), false);
	});
});
