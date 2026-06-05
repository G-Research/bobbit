import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-archived-active-tools-"));
const stateDir = path.join(tmpRoot, "state");
fs.mkdirSync(stateDir, { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;
process.env.BOBBIT_AGENT_DIR = path.join(tmpRoot, "agent");

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
type PersistedSession = import("../src/server/agent/session-store.ts").PersistedSession;

function makeSession(agentSessionFile: string): PersistedSession {
	return {
		id: "archived-active-tools",
		title: "Archived active tools",
		cwd: tmpRoot,
		agentSessionFile,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		archived: true,
		archivedAt: Date.now(),
		sandboxed: false,
	};
}

describe("SessionManager archived transcript reader", () => {
	after(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("ignores Pi active_tools_change JSONL entries when loading archived messages", async () => {
		const transcript = path.join(tmpRoot, "session.jsonl");
		fs.writeFileSync(transcript, [
			{ type: "message", message: { role: "user", content: "first archived message" } },
			{ type: "active_tools_change", activeToolNames: ["read", "bash"], reason: "pi 0.77 tool selection" },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "second archived message" }] } },
			{ type: "active_tools_change", activeToolNames: [] },
			"{not-json",
		].map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n") + "\n", "utf-8");

		const manager = new SessionManager();
		try {
			manager.getSessionStore().put(makeSession(transcript));

			const messages = await manager.getArchivedMessages("archived-active-tools") as any[];
			assert.equal(messages.length, 2);
			assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
			assert.equal(messages[0].content, "first archived message");
			assert.equal(messages[1].content[0].text, "second archived message");
		} finally {
			await manager.shutdown();
		}
	});
});
