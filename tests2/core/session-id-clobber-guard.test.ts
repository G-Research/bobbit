// v2-native — companion invariant test for the "Fix LLM review reliability"
// goal. Pins the SessionManager.createSession guard against silently
// clobbering an existing session's transcript by reusing its id.
//
// The smoking-gun defect behind reviewer-transcript "resets" was that the
// bounded llm-review retry loop reused one pre-generated session id across
// attempts, and createSession did `const id = opts.sessionId || randomUUID()`
// with NO guard — building a brand-new agent in place and overwriting the
// prior transcript. The primary fix mints a fresh id per attempt; this guard
// is defense-in-depth: any accidental reuse of a LIVE session id must throw
// loudly (never silently clobber), while the sanctioned restart-resume path
// (opts.allowSessionReuse) is still permitted.

import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir } from "../../tests/helpers/tmp.ts";

const tmpRoot = makeTmpDir("session-id-clobber-guard-test-");
const stateDir = path.join(tmpRoot, "state");
fs.mkdirSync(stateDir, { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../../src/server/agent/session-manager.ts");

const managers: any[] = [];
afterEach(() => {
	while (managers.length > 0) {
		const m = managers.pop();
		if (m._statusHeartbeatTimer) clearInterval(m._statusHeartbeatTimer);
		m.sessions?.clear?.();
	}
});

function makeManager(): any {
	const m: any = new SessionManager();
	managers.push(m);
	return m;
}

describe("createSession sessionId-clobber guard", () => {
	it("throws when a caller reuses an already-LIVE session id (no allowSessionReuse)", async () => {
		const m = makeManager();
		const id = "llm-review-clobbertest1";
		// Simulate an existing live reviewer session under this id.
		m.sessions.set(id, { id, title: "existing reviewer", status: "idle" });

		let threw = false;
		try {
			await m.createSession("/tmp", undefined, undefined, undefined, { sessionId: id, roleName: "reviewer" });
		} catch (err: any) {
			threw = true;
			assert.match(
				String(err?.message ?? err),
				/Refusing to clobber live session/i,
				"guard must throw a clear 'refusing to clobber' error on live-id reuse",
			);
		}
		assert.equal(threw, true, "createSession must REFUSE to clobber a live session id (it threw nothing)");
		// The original live session record must be untouched.
		assert.equal(m.sessions.get(id)?.title, "existing reviewer", "existing session transcript/record was clobbered");
	});

	it("does NOT throw on live-id reuse when allowSessionReuse is set (sanctioned resume path)", async () => {
		const m = makeManager();
		const id = "llm-review-resumetest1";
		m.sessions.set(id, { id, title: "resumed reviewer", status: "idle" });

		// The resume path passes allowSessionReuse. The guard must not throw for
		// this sanctioned reuse. We only assert the guard branch is bypassed —
		// full session creation may still no-op/fail later on the minimal stub,
		// so scope the assertion to "the guard did not throw its clobber error".
		let clobberError: string | null = null;
		try {
			await m.createSession("/tmp", undefined, undefined, undefined, { sessionId: id, roleName: "reviewer", allowSessionReuse: true });
		} catch (err: any) {
			const msg = String(err?.message ?? err);
			if (/Refusing to clobber live session/i.test(msg)) clobberError = msg;
		}
		assert.equal(clobberError, null, "allowSessionReuse must bypass the clobber guard (sanctioned resume)");
	});
});
