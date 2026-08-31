import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { InProcessMockBridge } from "../../../tests/e2e/in-process-mock-bridge.mjs";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sessionHeader(filePath: string): Record<string, unknown> {
	const firstLine = fs.readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0];
	return JSON.parse(firstLine);
}

describe("in-process mock new_session fidelity", () => {
	it("settles the old turn, rotates durable transcripts, and preserves the runtime tuple", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mock-new-session-"));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		const bridge = new InProcessMockBridge({
			cwd,
			env: { ...process.env, BOBBIT_AGENT_DIR: agentDir },
		});
		await bridge.start();
		try {
			await bridge.setModel("anthropic", "claude-sonnet-4-20250514");
			await bridge.setThinkingLevel("high");
			const runtime = (bridge as any)._agent;

			await bridge.prompt("OLD_CONTEXT_MARKER please use bash");
			await runtime._promptChain;

			const lifecycle: string[] = [];
			let resolveBusy!: () => void;
			const busy = new Promise<void>((resolve) => { resolveBusy = resolve; });
			const unsubscribe = bridge.onEvent((event: any) => {
				lifecycle.push(event.type === "session_status" ? `${event.type}:${event.status}` : event.type);
				if (event.type === "tool_execution_start") resolveBusy();
			});
			await bridge.prompt("ACTIVE_OLD_CONTEXT_MARKER STAY_BUSY:60000");
			await busy;

			const oldState = await bridge.getState();
			const oldPath = oldState.data.sessionFile as string;
			const oldHeader = sessionHeader(oldPath);
			const tupleBefore = {
				cwd: runtime.cwd,
				model: oldState.data.model,
				thinkingLevel: oldState.data.thinkingLevel,
			};

			const response = await bridge.newSession(7_654);
			assert.deepEqual(
				{ command: response.command, success: response.success, data: response.data },
				{ command: "new_session", success: true, data: { cancelled: false } },
			);
			assert.equal((bridge as any)._agent, runtime, "new_session must retain the current mock runtime instance");
			assert.ok(lifecycle.includes("agent_end"), "the interrupted old turn must reach agent_end before replacement");
			assert.ok(lifecycle.includes("agent_settled"), "the interrupted old turn must settle before replacement");
			unsubscribe();

			const newState = await bridge.getState();
			const newPath = newState.data.sessionFile as string;
			const newHeader = sessionHeader(newPath);
			assert.notEqual(newPath, oldPath, "new_session must rotate to a distinct transcript path");
			assert.notEqual(newHeader.id, oldHeader.id, "new_session must rotate to a distinct session header");
			assert.equal(newHeader.cwd, cwd);
			assert.deepEqual(
				{ cwd: runtime.cwd, model: newState.data.model, thinkingLevel: newState.data.thinkingLevel },
				tupleBefore,
				"cwd, model, and thinking selection must survive transcript replacement",
			);

			const messages = await bridge.getMessages();
			assert.deepEqual(messages.data, [], "the fresh model-facing conversation must be empty");
			const entries = await bridge.getTranscriptEntries();
			assert.deepEqual(entries, { success: true, data: { entries: [], leafId: null } });

			const retainedOld = fs.readFileSync(oldPath, "utf8");
			assert.match(retainedOld, /OLD_CONTEXT_MARKER/);
			assert.match(retainedOld, /ACTIVE_OLD_CONTEXT_MARKER/);
			assert.match(retainedOld, /BOBBIT_TOOL_TEST_OK_12345/);
			assert.doesNotMatch(retainedOld, /new_session|\/clear/i, "the control command must never enter model messages");
			const freshBeforePrompt = fs.readFileSync(newPath, "utf8");
			assert.doesNotMatch(freshBeforePrompt, /OLD_CONTEXT_MARKER|ACTIVE_OLD_CONTEXT_MARKER|new_session|\/clear/i);

			await bridge.prompt("NEW_CONTEXT_MARKER");
			await runtime._promptChain;
			assert.equal(fs.readFileSync(oldPath, "utf8"), retainedOld, "the retired transcript must remain durable and immutable");
			const freshAfterPrompt = fs.readFileSync(newPath, "utf8");
			assert.match(freshAfterPrompt, /NEW_CONTEXT_MARKER/);
			assert.doesNotMatch(freshAfterPrompt, /OLD_CONTEXT_MARKER|ACTIVE_OLD_CONTEXT_MARKER|new_session|\/clear/i);
		} finally {
			await bridge.stop();
		}
	});
});
