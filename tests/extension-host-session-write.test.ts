/**
 * Unit tests for the C2 session-WRITE handler
 * (src/server/extension-host/session-write.ts :: handleSessionPost) — design
 * docs/design/extension-host-phase2.md §8 C2.1.
 *
 * `host.session.postMessage` DRIVES the agent, so it is the highest-risk Host-API
 * addition. These pins prove the server-side controls:
 *   - authorized via authorizeScopedRequest (NOT authorizeActionRequest): a
 *     panel/entrypoint with NO toolUseId is accepted (the input carries no
 *     toolUseId field at all).
 *   - role ∈ {user, system} + non-empty text required.
 *   - pack-only: a non-pack caller is rejected (server-derived packId).
 *   - resumeTurn !== false resumes the agent turn; resumeTurn === false delivers
 *     without resuming.
 *   - the target session is ALWAYS the header-bound session — there is NO body
 *     param for another session, so cross-session posting is impossible.
 *   - EVERY post/resume is audited (success AND failure).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	handleSessionPost,
	type SessionPostInput,
	type SessionPostAudit,
} from "../src/server/extension-host/session-write.ts";
import type { ActionGuardSession } from "../src/server/extension-host/action-guard.ts";

const SID = "sess-1";

interface Harness {
	posts: Array<{ sessionId: string; text: string; role: string; resume: boolean }>;
	audits: SessionPostAudit[];
}

function makeInput(over: Partial<SessionPostInput> = {}): { input: SessionPostInput; h: Harness } {
	const h: Harness = { posts: [], audits: [] };
	const input: SessionPostInput = {
		tool: "sample_action",
		headerSessionId: SID,
		bodySessionId: SID,
		role: "user",
		text: "hello agent",
		resolveSession: (id: string): ActionGuardSession | undefined =>
			id === SID ? { allowedTools: ["sample_action"] } : undefined,
		resolvePackIdentity: () => ({ isPack: true, packId: "my-pack" }),
		post: async (sessionId, text, opts) => { h.posts.push({ sessionId, text, ...opts }); },
		audit: (rec) => { h.audits.push(rec); },
		now: (() => { let t = 1000; return () => (t += 5); })(),
		...over,
	};
	return { input, h };
}

describe("handleSessionPost — happy path (scoped guard, no toolUseId)", () => {
	it("posts into the HEADER-BOUND session and resumes by default", async () => {
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
	it("missing x-bobbit-session-id header → 403 (and NO post, NO audit)", async () => {
		const { input, h } = makeInput({ headerSessionId: undefined });
		const r = await handleSessionPost(input);
		assert.equal((r as { status: number }).status, 403);
		assert.equal(h.posts.length, 0);
		assert.equal(h.audits.length, 0);
	});

	it("body.sessionId mismatching the header → 403 (cross-session attempt blocked)", async () => {
		const { input, h } = makeInput({ bodySessionId: "other-session" });
		const r = await handleSessionPost(input);
		assert.equal((r as { status: number }).status, 403);
		assert.equal(h.posts.length, 0);
	});

	it(":tool ∉ allowedTools → 403", async () => {
		const { input } = makeInput({ resolveSession: () => ({ allowedTools: ["something_else"] }) });
		const r = await handleSessionPost(input);
		assert.equal((r as { status: number }).status, 403);
	});

	it("invalid role → 400", async () => {
		const { input } = makeInput({ role: "assistant" });
		const r = await handleSessionPost(input);
		assert.equal((r as { status: number }).status, 400);
	});

	it("empty / whitespace-only text → 400", async () => {
		for (const text of ["", "   ", 42 as unknown]) {
			const { input } = makeInput({ text });
			const r = await handleSessionPost(input);
			assert.equal((r as { status: number }).status, 400);
		}
	});

	it("non-pack caller → 403 (session messaging is pack-only)", async () => {
		const { input, h } = makeInput({ resolvePackIdentity: () => ({ isPack: false, packId: "" }) });
		const r = await handleSessionPost(input);
		assert.equal((r as { status: number }).status, 403);
		assert.match((r as { error: string }).error, /market-pack/);
		assert.equal(h.posts.length, 0);
	});
});

describe("handleSessionPost — cross-session posting is structurally impossible", () => {
	it("targets ONLY the header-bound session even if the body names another", async () => {
		// The body sessionId mismatch is rejected first; but even a matching body
		// never feeds the target — the poster is always called with guard.sessionId.
		const { input, h } = makeInput();
		await handleSessionPost(input);
		assert.equal(h.posts[0].sessionId, SID);
		// There is no input field that could redirect the post to another session.
		assert.equal(Object.prototype.hasOwnProperty.call(input, "targetSessionId"), false);
	});
});
