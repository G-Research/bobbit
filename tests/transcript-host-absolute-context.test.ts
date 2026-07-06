import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sessionFileCopy, sessionFileRead, sessionFsContextForAgentFile } from "../src/server/agent/session-fs.js";

function tmpDir(label: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-transcript-host-${label}-`));
}

describe("sandboxed persisted host-absolute transcript paths", () => {
	it("reads a host-absolute transcript from the host even when the session is sandboxed", async () => {
		const dir = tmpDir("read");
		try {
			const transcript = path.join(dir, "historical.jsonl");
			fs.writeFileSync(transcript, '{"type":"message","message":{"role":"user","content":"host historical"}}\n');

			const ctx = sessionFsContextForAgentFile({ sandboxed: true, projectId: "project-a" }, transcript);
			assert.equal(ctx.sandboxed, false, "host-absolute persisted paths must bypass sandbox I/O");
			assert.equal(await sessionFileRead(ctx, transcript, null), fs.readFileSync(transcript, "utf-8"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps container transcript paths in sandbox context", () => {
		const ctx = sessionFsContextForAgentFile(
			{ sandboxed: true, projectId: "project-a" },
			"/home/node/.bobbit/agent/sessions/--workspace--/2026-01-01T00-00-00-000Z_sid.jsonl",
		);
		assert.equal(ctx.sandboxed, true);
	});

	it("copies host-absolute archived transcripts host-to-host for sandboxed persisted sessions", async () => {
		const dir = tmpDir("copy");
		try {
			const src = path.join(dir, "old-agent", "sessions", "source.jsonl");
			const dst = path.join(dir, "new-agent", "sessions", "dest.jsonl");
			fs.mkdirSync(path.dirname(src), { recursive: true });
			fs.writeFileSync(src, "historical transcript\n");

			const ps = { sandboxed: true, projectId: "project-a" };
			await sessionFileCopy(
				sessionFsContextForAgentFile(ps, src),
				src,
				sessionFsContextForAgentFile(ps, dst),
				dst,
				null,
			);

			assert.equal(fs.readFileSync(dst, "utf-8"), "historical transcript\n");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("server transcript routes and continue flow use host-absolute-aware contexts", () => {
		const source = fs.readFileSync(path.join(process.cwd(), "src", "server", "server.ts"), "utf-8");
		// Fork/continue moved to the core route registry (STR-01 cohort 21) —
		// scan both files: the transcript route stays in server.ts, the
		// fork/continue clone contexts live in session-mutation-routes.ts.
		const mutationRoutes = fs.readFileSync(path.join(process.cwd(), "src", "server", "routes", "session-mutation-routes.ts"), "utf-8");
		for (const src of [source, mutationRoutes]) {
			assert.doesNotMatch(src, /SessionFsContext = \{ sandboxed: (?:targetPs|ps|extPs)\.sandboxed/);
			assert.doesNotMatch(src, /const (?:srcCtx|dstCtx|copyCtx) = \{ sandboxed: !!ps\.sandboxed/);
		}
		// GET /api/sessions/:id/transcript's readContent is async (it falls back to
		// the live Claude Code bridge's get_messages when there is no on-disk
		// agentSessionFile yet — see the Claude Code live-session fallback below),
		// but it must still route the on-disk case through the host-absolute-aware
		// `ctx` from `sessionFsContextForAgentFile`, never a raw sandboxed read.
		assert.match(source, /if \(targetPs\.agentSessionFile\) return sessionFileRead\(ctx, targetPs\.agentSessionFile, sandboxManager\);/);
		assert.match(mutationRoutes, /const srcCtx = sessionFsContextForAgentFile\(ps, sourceJsonl\)/);
	});
});
