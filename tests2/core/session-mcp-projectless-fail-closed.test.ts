// Ported from tests/headquarters-server-scope-guards.test.ts (straggler-coverage
// -triage PARTIAL: projectless-session MCP fail-closed). Faithful port of the
// pure-unit "session MCP manager resolution fails closed for projectless sessions"
// case — same assertions, vitest + fork env-guard.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDir(prefix: string): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test("session MCP manager resolution fails closed for projectless sessions", async () => {
	const bobbitDir = tmpDir("bobbit-mcp-cwd-scope-");
	process.env.BOBBIT_DIR = bobbitDir;
	delete process.env.BOBBIT_PI_DIR;
	const { resetAgentDirStateForTests } = await import("../../src/server/bobbit-dir.ts");
	resetAgentDirStateForTests?.();
	const { SessionManager } = await import("../../src/server/agent/session-manager.ts");
	const manager = new SessionManager();
	try {
		const cwd = tmpDir("bobbit-mcp-session-cwd-");
		(manager as any).sessions.set("legacy-session", { id: "legacy-session", cwd });
		const defaultManager = { kind: "default-mcp-manager" };
		(manager as any).mcpManager = defaultManager;
		const calls: unknown[] = [];
		(manager as any).ensureMcpManager = async (scope: unknown) => {
			calls.push(scope);
			return null;
		};

		assert.equal(manager.getMcpManagerForSession("legacy-session"), null);
		assert.equal(await manager.ensureMcpManagerForSession("legacy-session"), null);
		assert.equal(await manager.resolveMcpManagerForSession("legacy-session"), null);
		assert.deepEqual(calls, [], "projectless session should not use default or cwd-scoped MCP manager");

		assert.equal(await manager.resolveMcpManagerForSession("legacy-session", `cwd:${path.resolve(cwd)}`), null);
		assert.deepEqual(calls, [], "caller-supplied cwd scopeKey must not create a scoped MCP manager");
	} finally {
		(manager as any).sessions.clear();
		await manager.shutdown();
	}
});
