/**
 * Unit tests for the SHARED scoped authorization guard
 * (src/server/extension-host/action-guard.ts :: authorizeScopedRequest) —
 * design docs/design/extension-host-phase2.md §2 / Fix B.
 *
 * `authorizeScopedRequest` is the CORE (steps 1–4) that the Phase-2 pack-scoped
 * capabilities (B1 store, B2 session reads, B3 callRoute, C2 postMessage) share:
 *   - Missing x-bobbit-session-id header → 403.
 *   - body.sessionId !== header → 403.
 *   - Unknown session → 403; :tool ∉ allowedTools → 403.
 *   - NO toolUseId required and NO toolUseId-ownership check — panels/entrypoints
 *     have no toolUseId, and the scoped capabilities act on no prior tool call.
 *
 * Pinned invariant: factoring the core out did NOT weaken the action guard —
 * `authorizeActionRequest` still rejects forged/absent toolUseId (ownership).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	authorizeScopedRequest,
	authorizeActionRequest,
	type ScopedGuardInput,
	type ActionGuardInput,
	type ActionGuardSession,
} from "../src/server/extension-host/action-guard.ts";

const SID = "sess-1";

function scopedInput(over: Partial<ScopedGuardInput> = {}): ScopedGuardInput {
	return {
		tool: "sample_action",
		headerSessionId: SID,
		bodySessionId: SID,
		resolveSession: (id: string): ActionGuardSession | undefined =>
			id === SID ? { allowedTools: ["sample_action"] } : undefined,
		...over,
	};
}

describe("authorizeScopedRequest — happy path (no toolUseId required)", () => {
	it("passes with header session + body match + tool ∈ allowedTools", () => {
		const r = authorizeScopedRequest(scopedInput());
		assert.deepEqual(r, { ok: true, sessionId: SID });
	});

	it("passes for a panel/entrypoint that supplies NO toolUseId", () => {
		// ScopedGuardInput has no toolUseId field at all; this compiles + passes,
		// proving panel/entrypoint usability (Fix B).
		const r = authorizeScopedRequest(scopedInput());
		assert.equal(r.ok, true);
	});

	it("allows the tool when the session has no allowlist (unrestricted)", () => {
		const r = authorizeScopedRequest(scopedInput({ resolveSession: () => ({ allowedTools: undefined }) }));
		assert.equal(r.ok, true);
	});

	it("is case-insensitive on the allowedTools match", () => {
		const r = authorizeScopedRequest(scopedInput({ resolveSession: () => ({ allowedTools: ["Sample_Action"] }) }));
		assert.equal(r.ok, true);
	});
});

describe("authorizeScopedRequest — identity + allowlist (§5 i / iii-b)", () => {
	it("missing x-bobbit-session-id header → 403", () => {
		const r = authorizeScopedRequest(scopedInput({ headerSessionId: undefined }));
		assert.deepEqual(r, { ok: false, status: 403, error: "Missing x-bobbit-session-id header" });
	});

	it("body.sessionId mismatching the header → 403", () => {
		const r = authorizeScopedRequest(scopedInput({ bodySessionId: "other-session" }));
		assert.equal(r.ok, false);
		assert.equal((r as { status: number }).status, 403);
	});

	it("non-string body.sessionId → 403", () => {
		const r = authorizeScopedRequest(scopedInput({ bodySessionId: undefined }));
		assert.equal((r as { status: number }).status, 403);
	});

	it("unknown session → 403", () => {
		const r = authorizeScopedRequest(scopedInput({ resolveSession: () => undefined }));
		assert.equal((r as { status: number }).status, 403);
	});

	it(":tool ∉ session.allowedTools → 403 (the curl-bypass gate)", () => {
		const r = authorizeScopedRequest(scopedInput({ resolveSession: () => ({ allowedTools: ["something_else"] }) }));
		assert.equal((r as { status: number }).status, 403);
	});

	it("uses the HEADER-bound session for the allowlist check (a takes priority over the body)", () => {
		// Header and body agree on SID; resolveSession is only ever asked for SID.
		const seen: string[] = [];
		authorizeScopedRequest(scopedInput({
			resolveSession: (id) => { seen.push(id); return { allowedTools: ["sample_action"] }; },
		}));
		assert.deepEqual(seen, [SID]);
	});
});

describe("authorizeActionRequest — ownership NOT weakened by the refactor", () => {
	function actionInput(over: Partial<ActionGuardInput> = {}): ActionGuardInput {
		return {
			tool: "sample_action",
			action: "retry",
			headerSessionId: SID,
			bodySessionId: SID,
			toolUseId: "tu-1",
			resolveSession: (id: string): ActionGuardSession | undefined =>
				id === SID ? { allowedTools: ["sample_action"] } : undefined,
			actionNames: ["retry"],
			verifyToolUse: (sid, tu, tool) => sid === SID && tu === "tu-1" && tool === "sample_action",
			...over,
		};
	}

	it("still passes a fully-valid action request", async () => {
		const r = await authorizeActionRequest(actionInput());
		assert.deepEqual(r, { ok: true, sessionId: SID });
	});

	it("absent toolUseId → 409 (scoped guard allows it; action guard must not)", async () => {
		const r = await authorizeActionRequest(actionInput({ toolUseId: undefined }));
		assert.equal((r as { status: number }).status, 409);
	});

	it("forged toolUseId not present in the transcript → 409", async () => {
		const r = await authorizeActionRequest(actionInput({ verifyToolUse: () => false }));
		assert.equal((r as { status: number }).status, 409);
	});

	it("core rejection (bad session) short-circuits before the ownership check", async () => {
		const r = await authorizeActionRequest(actionInput({ headerSessionId: undefined }));
		assert.deepEqual(r, { ok: false, status: 403, error: "Missing x-bobbit-session-id header" });
	});
});
