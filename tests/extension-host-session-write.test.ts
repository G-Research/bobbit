/**
 * Unit tests for the C2 session-WRITE handler
 * (src/server/extension-host/session-write.ts :: handleSessionPost) — design
 * docs/design/extension-host-phase2.md §8 C2.1.
 *
 * `host.session.postMessage` DRIVES the agent, so it is the highest-risk Host-API
 * addition. Its SEND now rides the TRUSTED session WebSocket (NOT a fetch carrying a
 * capturable secret), so the handler takes a TRUSTED, server-authenticated
 * `sessionId` (resolved by the WS handler from the authenticated connection) rather
 * than a header/body pair plus a per-session secret. These pins prove the remaining
 * server-side controls:
 *   - authorized via authorizeScopedRequest (NOT authorizeActionRequest): a
 *     panel/entrypoint with NO toolUseId is accepted (the input carries no
 *     toolUseId field at all).
 *   - the pack's `tool` ∈ the session's allowedTools (else 403).
 *   - role ∈ {user, system} + non-empty text required.
 *   - pack-only: a non-pack caller is rejected (server-derived packId).
 *   - resumeTurn !== false resumes the agent turn; resumeTurn === false delivers
 *     without resuming.
 *   - the target session is ALWAYS the TRUSTED bound session — there is NO param
 *     for another session, so cross-session posting is impossible.
 *   - EVERY post/resume is audited (success AND failure).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	handleSessionPost,
	formatSessionMessage,
	type SessionPostInput,
	type SessionPostAudit,
} from "../src/server/extension-host/session-write.ts";
import { computeContentHash, type WritePermitBinding } from "../src/server/extension-host/session-write-permit.ts";
import type { ActionGuardSession } from "../src/server/extension-host/action-guard.ts";

const SID = "sess-1";

interface Harness {
	posts: Array<{ sessionId: string; text: string; role: string; resume: boolean }>;
	audits: SessionPostAudit[];
	/** Bindings passed to consumePermit (content-bound permit assertions). */
	permitCalls: Array<{ nonce: string; binding: WritePermitBinding }>;
}

function makeInput(over: Partial<SessionPostInput> = {}): { input: SessionPostInput; h: Harness } {
	const h: Harness = { posts: [], audits: [], permitCalls: [] };
	const input: SessionPostInput = {
		tool: "sample_action",
		// The TRUSTED, server-authenticated WS-bound session (not caller-supplied).
		sessionId: SID,
		role: "user",
		text: "hello agent",
		// A valid server-minted nonce is required; the default spy accepts it once.
		nonce: "permit-nonce-1",
		resolveSession: (id: string): ActionGuardSession | undefined =>
			id === SID ? { allowedTools: ["sample_action"] } : undefined,
		resolvePackIdentity: () => ({ isPack: true, packId: "my-pack" }),
		consumePermit: (nonce, binding) => {
			h.permitCalls.push({ nonce, binding });
			return true;
		},
		post: async (sessionId, text, opts) => { h.posts.push({ sessionId, text, ...opts }); },
		audit: (rec) => { h.audits.push(rec); },
		now: (() => { let t = 1000; return () => (t += 5); })(),
		...over,
	};
	return { input, h };
}

describe("handleSessionPost — happy path (scoped guard, no toolUseId)", () => {
	it("posts into the TRUSTED bound session and resumes by default", async () => {
		const { input, h } = makeInput();
		const r = await handleSessionPost(input);
		assert.deepEqual(r, { ok: true });
		assert.equal(h.posts.length, 1);
		assert.equal(h.posts[0].sessionId, SID);
		assert.equal(h.posts[0].resume, true);
		assert.equal(h.posts[0].role, "user");
	});

	it("succeeds for a panel/entrypoint origin with NO toolUseId (scoped, not action, guard)", async () => {
		// SessionPostInput has no toolUseId field at all — this compiles + passes,
		// proving panel/entrypoint usability (design Fix B / §2a).
		const { input, h } = makeInput();
		const r = await handleSessionPost(input);
		assert.equal(r.ok, true);
		assert.equal(h.posts.length, 1);
	});

	it("resumeTurn === false delivers WITHOUT resuming", async () => {
		const { input, h } = makeInput({ resumeTurn: false });
		await handleSessionPost(input);
		assert.equal(h.posts[0].resume, false);
	});

	it("resumeTurn === true (and undefined) resume", async () => {
		const { input: i1, h: h1 } = makeInput({ resumeTurn: true });
		await handleSessionPost(i1);
		assert.equal(h1.posts[0].resume, true);
		const { input: i2, h: h2 } = makeInput({ resumeTurn: undefined });
		await handleSessionPost(i2);
		assert.equal(h2.posts[0].resume, true);
	});

	it("accepts a system-role post", async () => {
		const { input, h } = makeInput({ role: "system" });
		const r = await handleSessionPost(input);
		assert.equal(r.ok, true);
		assert.equal(h.posts[0].role, "system");
	});
});

describe("handleSessionPost — role-aware delivery (honor PostMessageInput.role)", () => {
	it('"user" is delivered VERBATIM (no framing)', async () => {
		const { input, h } = makeInput({ role: "user", text: "do the thing" });
		await handleSessionPost(input);
		assert.equal(h.posts[0].text, "do the thing");
	});

	it('"system" is delivered as a genuine system directive (framed, NOT raw user text)', async () => {
		const { input, h } = makeInput({ role: "system", text: "context update" });
		const r = await handleSessionPost(input);
		assert.equal(r.ok, true);
		assert.equal(h.posts[0].role, "system");
		// The delivered text is system-framed — it is NOT the raw text (which would
		// be silently delivering "system" as "user").
		assert.notEqual(h.posts[0].text, "context update");
		assert.match(h.posts[0].text, /^<system-reminder>\n/);
		assert.match(h.posts[0].text, /\n<\/system-reminder>$/);
		assert.ok(h.posts[0].text.includes("context update"));
		// The audited role is the ORIGINAL role.
		assert.equal(h.audits[0].role, "system");
	});

	it("formatSessionMessage is the single source of the role framing", () => {
		assert.equal(formatSessionMessage("user", "hi"), "hi");
		assert.equal(formatSessionMessage("system", "hi"), "<system-reminder>\nhi\n</system-reminder>");
	});
});

describe("handleSessionPost — server-minted, one-time, content-bound write permit", () => {
	it("requires a nonce: a missing/empty permit → 403 (NO post, but AUDITED)", async () => {
		for (const nonce of [undefined, "", 42 as unknown]) {
			const { input, h } = makeInput({ nonce });
			const r = await handleSessionPost(input);
			assert.equal((r as { status: number }).status, 403);
			assert.match((r as { error: string }).error, /permit/i);
			assert.equal(h.posts.length, 0);
			// Fix #3: a rejected write is AUDITED (every rejection path emits the sink).
			assert.equal(h.audits.length, 1);
			assert.equal(h.audits[0].outcome, "error");
			assert.match(h.audits[0].error ?? "", /permit/i);
			assert.equal(h.audits[0].packId, "my-pack");
		}
	});

	it("rejects when the permit fails to consume (replayed / forged / expired) → 403, NO post, AUDITED", async () => {
		const { input, h } = makeInput({ consumePermit: () => false });
		const r = await handleSessionPost(input);
		assert.equal((r as { status: number }).status, 403);
		assert.match((r as { error: string }).error, /invalid, expired, or already-used/);
		assert.equal(h.posts.length, 0);
		assert.equal(h.audits.length, 1);
		assert.equal(h.audits[0].outcome, "error");
		assert.match(h.audits[0].error ?? "", /invalid, expired, or already-used/);
	});

	it("is CONTENT-BOUND: consumePermit receives {nonce, sessionId, packId, tool, contentHash(role,text)}", async () => {
		const { input, h } = makeInput({ role: "user", text: "hello agent", nonce: "permit-nonce-1" });
		await handleSessionPost(input);
		assert.equal(h.permitCalls.length, 1);
		const { nonce, binding } = h.permitCalls[0];
		assert.equal(nonce, "permit-nonce-1");
		assert.deepEqual(binding, {
			sessionId: SID,
			packId: "my-pack",
			tool: "sample_action",
			// Recomputed from the ORIGINAL role+text (not the system-framed delivery text).
			contentHash: computeContentHash("user", "hello agent"),
		});
	});

	it("SINGLE-USE: a real consumeWritePermit accepts the first post and rejects a replay", async () => {
		// Drive two posts through the SAME real permit store: the first mints+consumes,
		// the replay (same nonce) is dead.
		const { mintWritePermit, consumeWritePermit, _resetWritePermits } =
			await import("../src/server/extension-host/session-write-permit.ts");
		_resetWritePermits();
		const contentHash = computeContentHash("user", "hello agent");
		const nonce = mintWritePermit({ sessionId: SID, packId: "my-pack", tool: "sample_action", contentHash });
		const consumePermit = (n: string, b: WritePermitBinding) => consumeWritePermit(n, b);

		const { input: i1, h: h1 } = makeInput({ nonce, consumePermit });
		const r1 = await handleSessionPost(i1);
		assert.equal(r1.ok, true);
		assert.equal(h1.posts.length, 1);

		// Replay the captured frame: same nonce, already consumed → rejected.
		const { input: i2, h: h2 } = makeInput({ nonce, consumePermit });
		const r2 = await handleSessionPost(i2);
		assert.equal((r2 as { status: number }).status, 403);
		assert.equal(h2.posts.length, 0);
		_resetWritePermits();
	});
});

describe("handleSessionPost — every post is audited", () => {
	it("audits a successful post with the full record", async () => {
		const { input, h } = makeInput({ resumeTurn: false });
		await handleSessionPost(input);
		assert.equal(h.audits.length, 1);
		assert.deepEqual(h.audits[0], {
			tool: "sample_action",
			packId: "my-pack",
			sessionId: SID,
			role: "user",
			resumeTurn: false,
			ms: h.audits[0].ms,
			outcome: "ok",
		});
		assert.ok(h.audits[0].ms >= 0);
	});

	it("audits a FAILED post (poster throws) and surfaces a 500", async () => {
		const { input, h } = makeInput({ post: async () => { throw new Error("agent down"); } });
		const r = await handleSessionPost(input);
		assert.equal(r.ok, false);
		assert.equal((r as { status: number }).status, 500);
		assert.equal(h.audits.length, 1);
		assert.equal(h.audits[0].outcome, "error");
		assert.equal(h.audits[0].error, "agent down");
	});
});

describe("handleSessionPost — authorization + validation rejections", () => {
	it("unresolvable session → 403 (NO post, but AUDITED)", async () => {
		const { input, h } = makeInput({ resolveSession: () => undefined });
		const r = await handleSessionPost(input);
		assert.equal((r as { status: number }).status, 403);
		assert.equal(h.posts.length, 0);
		// Fix #3: even an authorization failure is audited.
		assert.equal(h.audits.length, 1);
		assert.equal(h.audits[0].outcome, "error");
	});

	it(":tool ∉ allowedTools → 403 (AUDITED)", async () => {
		const { input, h } = makeInput({ resolveSession: () => ({ allowedTools: ["something_else"] }) });
		const r = await handleSessionPost(input);
		assert.equal((r as { status: number }).status, 403);
		assert.equal(h.audits.length, 1);
		assert.equal(h.audits[0].outcome, "error");
		assert.equal(h.audits[0].tool, "sample_action");
	});

	it("invalid role → 400 (AUDITED)", async () => {
		const { input, h } = makeInput({ role: "assistant" });
		const r = await handleSessionPost(input);
		assert.equal((r as { status: number }).status, 400);
		assert.equal(h.audits.length, 1);
		assert.equal(h.audits[0].outcome, "error");
	});

	it("empty / whitespace-only text → 400 (AUDITED)", async () => {
		for (const text of ["", "   ", 42 as unknown]) {
			const { input, h } = makeInput({ text });
			const r = await handleSessionPost(input);
			assert.equal((r as { status: number }).status, 400);
			assert.equal(h.audits.length, 1);
			assert.equal(h.audits[0].outcome, "error");
		}
	});

	it("non-pack caller → 403 (session messaging is pack-only, AUDITED)", async () => {
		const { input, h } = makeInput({ resolvePackIdentity: () => ({ isPack: false, packId: "" }) });
		const r = await handleSessionPost(input);
		assert.equal((r as { status: number }).status, 403);
		assert.match((r as { error: string }).error, /market-pack/);
		assert.equal(h.posts.length, 0);
		assert.equal(h.audits.length, 1);
		assert.equal(h.audits[0].outcome, "error");
		assert.match(h.audits[0].error ?? "", /market-pack/);
	});
});

describe("handleSessionPost — cross-session posting is structurally impossible", () => {
	it("targets ONLY the TRUSTED bound session", async () => {
		// The poster is always called with the trusted bound sessionId; there is no
		// input field that could redirect the post to another session.
		const { input, h } = makeInput();
		await handleSessionPost(input);
		assert.equal(h.posts[0].sessionId, SID);
		assert.equal(Object.prototype.hasOwnProperty.call(input, "targetSessionId"), false);
		// No header/body/secret transport remains: the trusted WS supplies the session.
		assert.equal(Object.prototype.hasOwnProperty.call(input, "headerSessionId"), false);
		assert.equal(Object.prototype.hasOwnProperty.call(input, "sessionSecret"), false);
	});
});
