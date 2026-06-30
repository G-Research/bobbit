import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function sessionManagerSource(): string {
	return fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-manager.ts"), "utf-8");
}

function shutdownBody(source: string): string {
	const start = source.indexOf("\tasync shutdown(): Promise<void> {");
	assert.notEqual(start, -1, "precondition: SessionManager.shutdown() must exist");
	const end = source.indexOf("\n// ── Sandbox credential auto-resolution", start);
	assert.notEqual(end, -1, "precondition: SessionManager.shutdown() section must be bounded before sandbox credential code");
	return source.slice(start, end);
}

test("shutdown does not persist only exact streaming sessions as interrupted", () => {
	const body = shutdownBody(sessionManagerSource());

	assert.doesNotMatch(
		body,
		/wasStreaming:\s*session\.status\s*===\s*["']streaming["']\s*[,}]/,
		`SessionManager.shutdown() must mark every active/busy reviewer status as interrupted for restart re-drive, not only status === "streaming". A nonInteractive reviewer killed while "starting", "preparing", or "aborting" is currently persisted with wasStreaming:false, so restore delegates to the verification harness without enough state for a prompt resume nudge. Replace the exact streaming-only snapshot with a centralized active-status predicate.`,
	);
});
