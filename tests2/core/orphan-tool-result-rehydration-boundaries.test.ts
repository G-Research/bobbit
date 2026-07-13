import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { activeAgentSessionsDir } from "../../src/server/agent/agent-session-path.ts";
import { sessionFsContextForAgentFile } from "../../src/server/agent/session-fs.ts";
import { switchSessionPathForAgent } from "../../src/server/agent/session-manager.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SETUP_SOURCE = fs.readFileSync(path.join(ROOT, "src/server/agent/session-setup.ts"), "utf8");

function section(from: string, to: string): string {
	const start = SETUP_SOURCE.indexOf(from);
	const end = SETUP_SOURCE.indexOf(to, start + from.length);
	expect(start, `${from} must exist`).toBeGreaterThanOrEqual(0);
	expect(end, `${to} must follow ${from}`).toBeGreaterThan(start);
	return SETUP_SOURCE.slice(start, end);
}

function expectSanitizeBeforeSwitch(body: string): void {
	const context = body.indexOf("sessionFsContextForAgentFile(plan, plan.preExistingAgentSessionFile)");
	const sanitize = body.indexOf("sanitizeAgentTranscriptFile(", context);
	const switchPath = body.indexOf("switchSessionPathForAgent({", sanitize);
	const dispatch = body.indexOf('{ type: "switch_session", sessionPath: switchSessionPath }', switchPath);

	expect(context, "boundary must resolve the transcript filesystem from its path").toBeGreaterThanOrEqual(0);
	expect(sanitize, "boundary must sanitize the pre-existing transcript").toBeGreaterThan(context);
	expect(switchPath, "boundary must translate the path for the agent realm").toBeGreaterThan(sanitize);
	expect(dispatch, "boundary must dispatch only the translated switch path").toBeGreaterThan(switchPath);
}

describe("pre-existing transcript realm resolution", () => {
	const hostFile = path.join(activeAgentSessionsDir(), "--workspace--", "2026-07-14T00-00-00-000Z_session.jsonl");
	const containerFile = "/home/node/.bobbit/agent/sessions/--workspace--/2026-07-14T00-00-00-000Z_session.jsonl";

	it("keeps a host session on host filesystem boundaries", () => {
		expect(sessionFsContextForAgentFile({ sandboxed: false, projectId: "p" }, hostFile)).toEqual({
			sandboxed: false,
			projectId: "p",
		});
		expect(switchSessionPathForAgent({ sandboxed: false, agentSessionFile: hostFile } as any)).toBe(hostFile);
	});

	it("reads a sandbox session's host-absolute transcript on the host and switches through its mount path", () => {
		expect(sessionFsContextForAgentFile({ sandboxed: true, projectId: "p" }, hostFile)).toEqual({
			sandboxed: false,
			projectId: "p",
		});
		expect(switchSessionPathForAgent({ sandboxed: true, agentSessionFile: hostFile } as any))
			.toBe("/home/node/.bobbit/agent/sessions/--workspace--/2026-07-14T00-00-00-000Z_session.jsonl");
	});

	it("keeps a sandbox container transcript in the container realm", () => {
		expect(sessionFsContextForAgentFile({ sandboxed: true, projectId: "p" }, containerFile)).toEqual({
			sandboxed: true,
			projectId: "p",
		});
		expect(switchSessionPathForAgent({ sandboxed: true, agentSessionFile: containerFile } as any)).toBe(containerFile);
	});
});

describe("pre-existing transcript rehydration boundaries", () => {
	it("sanitizes and translates before synchronous switch_session", () => {
		const body = section("async function spawnAgent(", "/**\n * Post-spawn setup");
		expectSanitizeBeforeSwitch(body);
	});

	it("sanitizes and translates before worktree switch_session", () => {
		const body = section("export async function executeWorktreeAsync(", "// ── Internal helpers");
		expectSanitizeBeforeSwitch(body);
		expect(body).toContain("const sourceFsCtx = sessionFsContextForAgentFile(plan, plan.preExistingAgentSessionFile)");
		expect(body).toContain("const correctAgentPath = sourceFsCtx.sandboxed");
		expect(body).toContain("const correctFsCtx = sessionFsContextForAgentFile(plan, correctAgentPath)");
		expect(body).toContain("sessionFileCopy(sourceFsCtx, plan.preExistingAgentSessionFile, correctFsCtx, correctAgentPath");
	});
});
