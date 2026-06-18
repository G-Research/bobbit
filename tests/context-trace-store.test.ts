import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextTraceStore, type TraceEntry } from "../src/server/agent/context-trace-store.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "context-trace-store-"));
}

function entry(n: number, extra = ""): TraceEntry {
	return {
		ts: n,
		hook: "sessionSetup",
		sessionId: "sess-1",
		providers: [{ id: `p${n}`, ms: n, blocks: 1, omitted: 0, error: extra || undefined }],
	};
}

describe("ContextTraceStore", () => {
	it("appends and reads traces in order with optional limits", () => {
		const dir = tmpDir();
		try {
			const store = new ContextTraceStore(dir);
			store.appendTrace("sess-1", entry(1));
			store.appendTrace("sess-1", entry(2));

			assert.deepEqual(store.readTrace("sess-1").map((e) => e.ts), [1, 2]);
			assert.deepEqual(store.readTrace("sess-1", 1).map((e) => e.ts), [2]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("caps trace files at 2 MB by dropping oldest lines", () => {
		const dir = tmpDir();
		try {
			const store = new ContextTraceStore(dir);
			const large = "x".repeat(12 * 1024);
			for (let i = 0; i < 260; i++) store.appendTrace("sess-cap", entry(i, large));

			const traceFile = path.join(dir, "session-context-trace", "sess-cap.jsonl");
			assert.ok(fs.statSync(traceFile).size <= 2 * 1024 * 1024);
			const rows = store.readTrace("sess-cap");
			assert.ok(rows.length > 0);
			assert.ok(rows[0].ts > 0, "oldest entries should be dropped");
			assert.equal(rows.at(-1)?.ts, 259, "newest entry should be retained");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
