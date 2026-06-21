import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeBridge, buildClaudeCodeArgs } from "../src/server/agent/claude-code-bridge.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(__dirname, "fixtures", "claude-code", "fake-claude-cli.mjs");

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < 2000) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(message);
}

function tempRecord(): { dir: string; recordPath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-fake-claude-"));
	return { dir, recordPath: path.join(dir, "record.jsonl") };
}

function readRecord(recordPath: string): any[] {
	return fs.readFileSync(recordPath, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe("ClaudeCodeBridge lifecycle", () => {
	it("spawns fake Claude with structured flags and sends prompts over stdin JSONL", async () => {
		fs.chmodSync(fakeCli, 0o755);
		const tmp = tempRecord();
		const bridge = new ClaudeCodeBridge({
			claudeCodeExecutable: fakeCli,
			env: { FAKE_CLAUDE_RECORD_PATH: tmp.recordPath, FAKE_CLAUDE_SPLIT: "1" },
		});
		const events: any[] = [];
		bridge.onEvent((event) => events.push(event));

		try {
			await bridge.start();
			await timeout(bridge.prompt("Hello"), 2000, "prompt was not accepted");
			await waitFor(() => events.some((event) => event.type === "agent_end"), "agent_end not emitted");

			const record = readRecord(tmp.recordPath);
			const argv = record[0].argv;
			assert.deepEqual(argv, ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages"]);
			const stdin = record.find((entry) => entry.type === "user");
			assert.equal(stdin.message.role, "user");
			assert.equal(stdin.message.content[0].text, "Hello");

			const assistantEnd = events.find((event) => event.type === "message_end" && event.message?.role === "assistant");
			assert.equal(assistantEnd?.message.content[0].text, "Hi there 🚀");
			assert.equal((await bridge.getState()).data.claudeCodeSessionId, "fake-claude-session");
			assert.equal((await bridge.getMessages()).data.messages.length, 2);
		} finally {
			await bridge.stop();
			fs.rmSync(tmp.dir, { recursive: true, force: true });
		}
	});

	it("rejects a pending prompt exactly once when the child exits mid-turn", async () => {
		fs.chmodSync(fakeCli, 0o755);
		const tmp = tempRecord();
		const bridge = new ClaudeCodeBridge({
			claudeCodeExecutable: fakeCli,
			env: { FAKE_CLAUDE_RECORD_PATH: tmp.recordPath, FAKE_CLAUDE_MODE: "crash-after-stdin" },
		});
		let processExitEvents = 0;
		bridge.onEvent((event) => {
			if (event.type === "process_exit") processExitEvents += 1;
		});

		try {
			await bridge.start();
			let rejectionCount = 0;
			const result = await timeout(
				bridge.prompt("trigger crash").then(
					(value) => ({ ok: true as const, value }),
					(error) => {
						rejectionCount += 1;
						return { ok: false as const, error };
					},
				),
				2000,
				"pending prompt did not reject after Claude Code child exit",
			);

			assert.equal(result.ok, false);
			assert.match(String(result.error?.message || result.error), /code 17/);
			assert.match(String(result.error?.message || result.error), /synthetic Claude Code child crash/);
			assert.equal(rejectionCount, 1);
			await waitFor(() => processExitEvents === 1, "process_exit not emitted once");
			await timeout(bridge.stop(), 500, "first stop hung");
			await timeout(bridge.stop(), 500, "second stop hung");
			assert.equal(rejectionCount, 1);
			assert.equal(processExitEvents, 1);
		} finally {
			fs.rmSync(tmp.dir, { recursive: true, force: true });
		}
	});

	it("abort emits an aborted turn without marking the expected SIGTERM as process_exit", async () => {
		fs.chmodSync(fakeCli, 0o755);
		const tmp = tempRecord();
		const bridge = new ClaudeCodeBridge({
			claudeCodeExecutable: fakeCli,
			env: { FAKE_CLAUDE_RECORD_PATH: tmp.recordPath, FAKE_CLAUDE_MODE: "idle" },
		});
		const events: any[] = [];
		bridge.onEvent((event) => events.push(event));

		try {
			await bridge.start();
			assert.equal((await bridge.abort()).success, true);
			await waitFor(() => !bridge.running, "abort did not terminate child");
			assert.ok(events.some((event) => event.type === "message_end" && event.message?.stopReason === "error"));
			assert.ok(events.some((event) => event.type === "agent_end" && event.stopReason === "abort"));
			assert.equal(events.some((event) => event.type === "process_exit"), false, "expected abort exits must not terminate the session");

			await timeout(bridge.prompt("after abort"), 2000, "bridge did not recover after abort");
			await waitFor(() => events.filter((event) => event.type === "agent_end").length >= 2, "post-abort prompt did not complete");
		} finally {
			await bridge.stop();
			fs.rmSync(tmp.dir, { recursive: true, force: true });
		}
	});

	it("passes selected Claude Code model aliases while preserving default CLI behavior", () => {
		assert.equal(buildClaudeCodeArgs({}).includes("--model"), false);
		assert.deepEqual(buildClaudeCodeArgs({ claudeCodeModelAlias: "sonnet" }).slice(-2), ["--model", "sonnet"]);
		assert.deepEqual(buildClaudeCodeArgs({ initialModel: "claude-code/opus" }).slice(-2), ["--model", "opus"]);
		assert.equal(buildClaudeCodeArgs({ claudeCodeModelAlias: "default" }).includes("--model"), false);
		assert.equal(buildClaudeCodeArgs({ initialModel: "claude-code/default" }).includes("--model"), false);
		assert.equal(buildClaudeCodeArgs({ claudeCodeModelAlias: "bad alias; rm -rf" }).includes("--model"), false);
	});

	it("passes persisted Claude Code session ids via the guarded resume flag", () => {
		assert.deepEqual(
			buildClaudeCodeArgs({ claudeCodeSessionId: "previous-claude-session" }),
			["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages", "--resume", "previous-claude-session"],
		);
		assert.equal(buildClaudeCodeArgs({ claudeCodeSessionId: "bad session; rm -rf" }).includes("--resume"), false);
	});

	it("passes Bobbit's assembled system prompt to Claude Code without rewriting user text or images", async () => {
		fs.chmodSync(fakeCli, 0o755);
		const tmp = tempRecord();
		const promptPath = path.join(tmp.dir, "system-prompt.md");
		const systemPrompt = "Role instructions\nGoal instructions\nDelegate instructions";
		fs.writeFileSync(promptPath, systemPrompt, "utf8");
		const bridge = new ClaudeCodeBridge({
			claudeCodeExecutable: fakeCli,
			systemPromptPath: promptPath,
			env: { FAKE_CLAUDE_RECORD_PATH: tmp.recordPath },
		});

		try {
			await bridge.start();
			await timeout(bridge.prompt("Describe this", [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }]), 2000, "prompt with image was not accepted");

			const record = readRecord(tmp.recordPath);
			const argv = record[0].argv;
			const promptFlagIndex = argv.indexOf("--append-system-prompt");
			assert.ok(promptFlagIndex >= 0, `expected --append-system-prompt in argv: ${argv.join(" ")}`);
			assert.equal(argv[promptFlagIndex + 1], systemPrompt);

			const stdin = record.find((entry) => entry.type === "user");
			assert.equal(stdin.message.content[0].type, "text");
			assert.equal(stdin.message.content[0].text, "Describe this");
			assert.equal(stdin.message.content[1].type, "image");
			assert.equal(stdin.message.content[1].source.media_type, "image/png");
			assert.equal(stdin.message.content[1].source.data, "ZmFrZQ==");
		} finally {
			await bridge.stop();
			fs.rmSync(tmp.dir, { recursive: true, force: true });
		}
	});

	it("uses the latest Claude session id for --resume on follow-up --print processes", async () => {
		fs.chmodSync(fakeCli, 0o755);
		const tmp = tempRecord();
		const bridge = new ClaudeCodeBridge({
			claudeCodeExecutable: fakeCli,
			env: { FAKE_CLAUDE_RECORD_PATH: tmp.recordPath, FAKE_CLAUDE_MODE: "exit-after-result" },
		});
		const events: any[] = [];
		bridge.onEvent((event) => events.push(event));

		try {
			await timeout(bridge.prompt("first"), 2000, "first prompt was not accepted");
			await waitFor(() => !bridge.running && events.some((event) => event.type === "agent_end"), "first --print process did not finish");
			assert.equal((await bridge.getState()).data.claudeCodeSessionId, "fake-claude-session");

			await timeout(bridge.prompt("second"), 2000, "second prompt was not accepted");
			await waitFor(() => !bridge.running && events.filter((event) => event.type === "agent_end").length >= 2, "second --print process did not finish");

			const argvRecords = readRecord(tmp.recordPath).filter((entry) => Array.isArray(entry.argv));
			assert.equal(argvRecords.length, 2);
			assert.equal(argvRecords[0].argv.includes("--resume"), false);
			assert.deepEqual(argvRecords[1].argv.slice(-2), ["--resume", "fake-claude-session"]);
		} finally {
			await bridge.stop();
			fs.rmSync(tmp.dir, { recursive: true, force: true });
		}
	});

	it("flushes final stdout JSON without a trailing newline before process close handling", async () => {
		fs.chmodSync(fakeCli, 0o755);
		const tmp = tempRecord();
		const bridge = new ClaudeCodeBridge({
			claudeCodeExecutable: fakeCli,
			env: { FAKE_CLAUDE_RECORD_PATH: tmp.recordPath, FAKE_CLAUDE_MODE: "exit-after-result", FAKE_CLAUDE_FINAL_NO_NEWLINE: "1" },
		});
		const events: any[] = [];
		bridge.onEvent((event) => events.push(event));

		try {
			await timeout(bridge.prompt("no newline"), 2000, "prompt was not accepted");
			await waitFor(() => !bridge.running, "unterminated final result did not close");
			assert.ok(events.some((event) => event.type === "agent_end" && event.stopReason === "stop"));
			assert.equal(events.some((event) => event.type === "process_exit"), false);
		} finally {
			await bridge.stop();
			fs.rmSync(tmp.dir, { recursive: true, force: true });
		}
	});

	it("passes explicit non-default permission mode but downgrades bypass without opt-in", () => {
		assert.deepEqual(buildClaudeCodeArgs({ claudeCodePermissionMode: "acceptEdits" }).slice(-2), ["--permission-mode", "acceptEdits"]);
		assert.equal(buildClaudeCodeArgs({ claudeCodePermissionMode: "bypassPermissions" }).includes("bypassPermissions"), false);
		assert.deepEqual(buildClaudeCodeArgs({ claudeCodePermissionMode: "bypassPermissions", claudeCodeAllowBypassPermissions: true }).slice(-2), ["--permission-mode", "bypassPermissions"]);
	});
});
