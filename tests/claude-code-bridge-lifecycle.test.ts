import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ClaudeCodeBridge, buildClaudeCodeArgs, normalizeClaudeCodeEffort } from "../src/server/agent/claude-code-bridge.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(__dirname, "fixtures", "claude-code", "fake-claude-cli.mjs");

function fakeCliWithEnv(dir: string, env: Record<string, string>): string {
	const wrapper = path.join(dir, "fake-claude-wrapper.mjs");
	const assignments = Object.entries(env)
		.map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`)
		.join("\n");
	fs.writeFileSync(wrapper, `#!/usr/bin/env node\n${assignments}\nawait import(${JSON.stringify(pathToFileURL(fakeCli).href)});\n`, "utf8");
	fs.chmodSync(wrapper, 0o755);
	return wrapper;
}

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

function permissionModeArg(args: string[]): string | undefined {
	const index = args.indexOf("--permission-mode");
	return index >= 0 ? args[index + 1] : undefined;
}

function withPatchedEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(patch)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const restore = () => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	try {
		const result = fn();
		if (result && typeof (result as any).finally === "function") {
			return (result as Promise<unknown>).finally(restore) as T;
		}
		restore();
		return result;
	} catch (error) {
		restore();
		throw error;
	}
}

function envRecordingCli(dir: string, recordPath: string): string {
	const cli = path.join(dir, "env-recording-claude.mjs");
	const keys = [
		"PATH",
		"HOME",
		"TMPDIR",
		"TEMP",
		"LANG",
		"LC_ALL",
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"GITHUB_TOKEN",
		"AWS_SECRET_ACCESS_KEY",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"BOBBIT_GATEWAY_TOKEN",
		"EXTRA_TOKEN",
		"EXTRA_SAFE",
	];
	fs.writeFileSync(cli, `#!/usr/bin/env node
import fs from "node:fs";
const keys = ${JSON.stringify(keys)};
const selected = Object.fromEntries(keys.map((key) => [key, process.env[key]]).filter(([, value]) => value !== undefined));
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ env: selected }) + "\\n", "utf8");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }) + "\\n");
  process.exit(0);
});
`, "utf8");
	fs.chmodSync(cli, 0o755);
	return cli;
}

describe("ClaudeCodeBridge lifecycle", () => {
	it("does not spawn a repo-local claude executable from cwd or injected PATH", async () => {
		const tmp = tempRecord();
		const malicious = path.join(tmp.dir, "claude");
		fs.writeFileSync(malicious, "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.argv[2] || 'hijacked', 'hijacked')\n", "utf8");
		fs.chmodSync(malicious, 0o755);
		const previousPath = process.env.PATH;
		process.env.PATH = tmp.dir;
		const bridge = new ClaudeCodeBridge({
			cwd: tmp.dir,
			claudeCodeExecutable: "claude",
			env: { PATH: tmp.dir, ANTHROPIC_API_KEY: "must-not-leak" },
		});

		try {
			await assert.rejects(() => bridge.start(), /not found on trusted PATH/);
			assert.equal(fs.existsSync(tmp.recordPath), false);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			await bridge.stop();
			fs.rmSync(tmp.dir, { recursive: true, force: true });
		}
	});

	it("passes only minimal safe environment to Claude Code child processes", async () => {
		const tmp = tempRecord();
		const safeBin = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-bridge-path-"));
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-bridge-home-"));
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-bridge-temp-"));
		const cli = envRecordingCli(tmp.dir, tmp.recordPath);
		const bridge = new ClaudeCodeBridge({
			claudeCodeExecutable: cli,
			env: {
				HOME: path.join(home, "override"),
				TEMP: temp,
				LANG: "fr_FR.UTF-8",
				ANTHROPIC_API_KEY: "extra-anthropic-secret",
				EXTRA_TOKEN: "extra-token-secret",
				EXTRA_SAFE: "not-on-allowlist",
			},
		});

		try {
			await withPatchedEnv({
				PATH: [path.dirname(process.execPath), safeBin].join(path.delimiter),
				HOME: home,
				TMPDIR: temp,
				LANG: "en_US.UTF-8",
				LC_ALL: "C.UTF-8",
				ANTHROPIC_API_KEY: "process-anthropic-secret",
				OPENAI_API_KEY: "process-openai-secret",
				GITHUB_TOKEN: "process-github-secret",
				AWS_SECRET_ACCESS_KEY: "process-aws-secret",
				GOOGLE_APPLICATION_CREDENTIALS: "/secret/google.json",
				BOBBIT_GATEWAY_TOKEN: "process-bobbit-secret",
			}, () => timeout(bridge.prompt("check env"), 2000, "prompt was not accepted"));

			const [{ env }] = readRecord(tmp.recordPath);
			assert.equal(env.HOME, path.join(home, "override"));
			assert.equal(env.TMPDIR, temp);
			assert.equal(env.TEMP, temp);
			assert.equal(env.LANG, "fr_FR.UTF-8");
			assert.equal(env.LC_ALL, "C.UTF-8");
			assert.ok(String(env.PATH || "").split(path.delimiter).includes(fs.realpathSync(safeBin)));
			assert.equal(env.ANTHROPIC_API_KEY, undefined);
			assert.equal(env.OPENAI_API_KEY, undefined);
			assert.equal(env.GITHUB_TOKEN, undefined);
			assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
			assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
			assert.equal(env.BOBBIT_GATEWAY_TOKEN, undefined);
			assert.equal(env.EXTRA_TOKEN, undefined);
			assert.equal(env.EXTRA_SAFE, undefined);
		} finally {
			await bridge.stop();
			fs.rmSync(tmp.dir, { recursive: true, force: true });
			fs.rmSync(safeBin, { recursive: true, force: true });
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(temp, { recursive: true, force: true });
		}
	});

	it("spawns fake Claude with structured flags and sends prompts over stdin JSONL", async () => {
		const tmp = tempRecord();
		const bridge = new ClaudeCodeBridge({
			claudeCodeExecutable: fakeCliWithEnv(tmp.dir, { FAKE_CLAUDE_RECORD_PATH: tmp.recordPath, FAKE_CLAUDE_SPLIT: "1" }),
		});
		const events: any[] = [];
		bridge.onEvent((event) => events.push(event));

		try {
			await bridge.start();
			await timeout(bridge.prompt("Hello"), 2000, "prompt was not accepted");
			await waitFor(() => events.some((event) => event.type === "agent_end"), "agent_end not emitted");

			const record = readRecord(tmp.recordPath);
			const argv = record[0].argv;
			assert.deepEqual(argv, ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages", "--permission-mode", "acceptEdits"]);
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

	it("rejects a pending prompt and terminates when stdout exceeds stream bounds", async () => {
		const tmp = tempRecord();
		const oversizedCli = path.join(tmp.dir, "oversized-claude.mjs");
		fs.writeFileSync(oversizedCli, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {
  const text = 'x'.repeat(1024 * 1024 + 1);
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\\n');
  setInterval(() => {}, 1000);
});
`, "utf8");
		fs.chmodSync(oversizedCli, 0o755);
		const bridge = new ClaudeCodeBridge({ claudeCodeExecutable: oversizedCli });
		const events: any[] = [];
		bridge.onEvent((event) => events.push(event));

		try {
			await bridge.start();
			await assert.rejects(() => timeout(bridge.prompt("trigger"), 2000, "prompt did not reject"), /exceeded/);
			await waitFor(() => events.some((event) => event.type === "agent_end" && event.stopReason === "error"), "stream limit error was not surfaced");
		} finally {
			await bridge.stop();
			fs.rmSync(tmp.dir, { recursive: true, force: true });
		}
	});

	it("rejects a pending prompt exactly once when the child exits mid-turn", async () => {
		const tmp = tempRecord();
		const bridge = new ClaudeCodeBridge({
			claudeCodeExecutable: fakeCliWithEnv(tmp.dir, { FAKE_CLAUDE_RECORD_PATH: tmp.recordPath, FAKE_CLAUDE_MODE: "crash-after-stdin" }),
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
		const tmp = tempRecord();
		const bridge = new ClaudeCodeBridge({
			claudeCodeExecutable: fakeCliWithEnv(tmp.dir, { FAKE_CLAUDE_RECORD_PATH: tmp.recordPath, FAKE_CLAUDE_MODE: "idle" }),
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
		assert.equal(buildClaudeCodeArgs({ claudeCodeModelAlias: "local-claude-sonnet-4-6" })[buildClaudeCodeArgs({ claudeCodeModelAlias: "local-claude-sonnet-4-6" }).indexOf("--model") + 1], "claude-sonnet-4-6");
		assert.equal(buildClaudeCodeArgs({ claudeCodeModelAlias: "vendor:model.alias-48" })[buildClaudeCodeArgs({ claudeCodeModelAlias: "vendor:model.alias-48" }).indexOf("--model") + 1], "vendor:model.alias-48");
		assert.equal(buildClaudeCodeArgs({ initialModel: "claude-code/local-claude-opus-4-8" })[buildClaudeCodeArgs({ initialModel: "claude-code/local-claude-opus-4-8" }).indexOf("--model") + 1], "claude-opus-4-8");
		assert.equal(buildClaudeCodeArgs({ claudeCodeModelAlias: "default" }).includes("--model"), false);
		assert.equal(buildClaudeCodeArgs({ initialModel: "claude-code/default" }).includes("--model"), false);
		assert.equal(buildClaudeCodeArgs({ claudeCodeModelAlias: "bad alias; rm -rf" }).includes("--model"), false);
	});

	it("passes persisted Claude Code session ids via the guarded resume flag", () => {
		assert.deepEqual(
			buildClaudeCodeArgs({ claudeCodeSessionId: "previous-claude-session" }),
			["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages", "--permission-mode", "acceptEdits", "--resume", "previous-claude-session"],
		);
		assert.equal(buildClaudeCodeArgs({ claudeCodeSessionId: "bad session; rm -rf" }).includes("--resume"), false);
	});

	it("passes Bobbit's assembled system prompt to Claude Code without rewriting user text or images", async () => {
		const tmp = tempRecord();
		const promptPath = path.join(tmp.dir, "system-prompt.md");
		const systemPrompt = "Role instructions\nGoal instructions\nDelegate instructions";
		fs.writeFileSync(promptPath, systemPrompt, "utf8");
		const bridge = new ClaudeCodeBridge({
			claudeCodeExecutable: fakeCliWithEnv(tmp.dir, { FAKE_CLAUDE_RECORD_PATH: tmp.recordPath }),
			systemPromptPath: promptPath,
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
		const tmp = tempRecord();
		const bridge = new ClaudeCodeBridge({
			claudeCodeExecutable: fakeCliWithEnv(tmp.dir, { FAKE_CLAUDE_RECORD_PATH: tmp.recordPath, FAKE_CLAUDE_MODE: "exit-after-result" }),
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

	it("switches Claude Code aliases in the same Bobbit bridge by restarting with --resume", async () => {
		const tmp = tempRecord();
		const bridge = new ClaudeCodeBridge({
			claudeCodeExecutable: fakeCliWithEnv(tmp.dir, { FAKE_CLAUDE_RECORD_PATH: tmp.recordPath }),
			claudeCodeModelAlias: "local-claude-sonnet-4-6",
		});
		const events: any[] = [];
		bridge.onEvent((event) => events.push(event));

		try {
			await timeout(bridge.prompt("first"), 2000, "first prompt was not accepted");
			await waitFor(() => events.some((event) => event.type === "agent_end"), "first prompt did not complete");
			assert.equal((await bridge.getState()).data.claudeCodeSessionId, "fake-claude-session");
			assert.equal((await bridge.getMessages()).data.messages.length, 2);

			const result = await timeout(bridge.setModel("claude-code", "local-claude-opus-4-8"), 2000, "model switch did not finish");
			assert.equal(result.success, true);
			assert.equal((await bridge.getState()).data.model.id, "local-claude-opus-4-8");
			assert.equal((await bridge.getMessages()).data.messages.length, 2, "restart must preserve translated Bobbit messages");

			await waitFor(
				() => readRecord(tmp.recordPath).filter((entry) => Array.isArray(entry.argv)).length >= 2,
				"model switch did not spawn resumed Claude Code process",
			);
			const argvRecords = readRecord(tmp.recordPath).filter((entry) => Array.isArray(entry.argv));
			assert.equal(argvRecords.length, 2);
			assert.equal(argvRecords[0].argv[argvRecords[0].argv.indexOf("--model") + 1], "claude-sonnet-4-6");
			assert.ok(argvRecords[1].argv.includes("--model"), `expected second argv to include --model: ${argvRecords[1].argv.join(" ")}`);
			assert.equal(argvRecords[1].argv[argvRecords[1].argv.indexOf("--model") + 1], "claude-opus-4-8");
			assert.ok(argvRecords[1].argv.includes("--resume"), `expected second argv to include --resume: ${argvRecords[1].argv.join(" ")}`);
			assert.equal(argvRecords[1].argv[argvRecords[1].argv.indexOf("--resume") + 1], "fake-claude-session");
		} finally {
			await bridge.stop();
			fs.rmSync(tmp.dir, { recursive: true, force: true });
		}
	});

	it("restarts an idle Claude Code bridge with resumed session id when effort changes", async () => {
		const tmp = tempRecord();
		const bridge = new ClaudeCodeBridge({
			claudeCodeExecutable: fakeCliWithEnv(tmp.dir, { FAKE_CLAUDE_RECORD_PATH: tmp.recordPath }),
			initialThinkingLevel: "minimal",
		});
		const events: any[] = [];
		bridge.onEvent((event) => events.push(event));

		try {
			await timeout(bridge.prompt("first"), 2000, "first prompt was not accepted");
			await waitFor(() => events.some((event) => event.type === "agent_end"), "first prompt did not complete");

			const result = await timeout(bridge.setThinkingLevel("high"), 2000, "effort switch did not finish");
			assert.equal(result.success, true);
			assert.equal((await bridge.getState()).data.thinkingLevel, "high");

			await waitFor(
				() => readRecord(tmp.recordPath).filter((entry) => Array.isArray(entry.argv)).length >= 2,
				"effort switch did not spawn resumed Claude Code process",
			);
			const argvRecords = readRecord(tmp.recordPath).filter((entry) => Array.isArray(entry.argv));
			assert.equal(argvRecords[0].argv[argvRecords[0].argv.indexOf("--effort") + 1], "low");
			assert.equal(argvRecords[1].argv[argvRecords[1].argv.indexOf("--effort") + 1], "high");
			assert.ok(argvRecords[1].argv.includes("--resume"), `expected resumed effort restart: ${argvRecords[1].argv.join(" ")}`);
			assert.equal(argvRecords[1].argv[argvRecords[1].argv.indexOf("--resume") + 1], "fake-claude-session");
		} finally {
			await bridge.stop();
			fs.rmSync(tmp.dir, { recursive: true, force: true });
		}
	});

	it("flushes final stdout JSON without a trailing newline before process close handling", async () => {
		const tmp = tempRecord();
		const bridge = new ClaudeCodeBridge({
			claudeCodeExecutable: fakeCliWithEnv(tmp.dir, { FAKE_CLAUDE_RECORD_PATH: tmp.recordPath, FAKE_CLAUDE_MODE: "exit-after-result", FAKE_CLAUDE_FINAL_NO_NEWLINE: "1" }),
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

	it("preserves configured Claude Code permission defaults while applying Bobbit fresh/read-only defaults", () => {
		assert.equal(permissionModeArg(buildClaudeCodeArgs({})), "acceptEdits");
		assert.equal(permissionModeArg(buildClaudeCodeArgs({ claudeCodePermissionMode: "default" })), "default");
		assert.equal(permissionModeArg(buildClaudeCodeArgs({ readOnly: true, claudeCodePermissionMode: "default" })), "plan");
		assert.equal(permissionModeArg(buildClaudeCodeArgs({ readOnly: true, claudeCodePermissionMode: "bypassPermissions", claudeCodeAllowBypassPermissions: true })), "plan");
	});

	it("passes explicit permission mode and effort while downgrading bypass without opt-in", () => {
		assert.equal(permissionModeArg(buildClaudeCodeArgs({ claudeCodePermissionMode: "acceptEdits" })), "acceptEdits");
		assert.equal(permissionModeArg(buildClaudeCodeArgs({ claudeCodePermissionMode: "bypassPermissions" })), "default");
		assert.equal(permissionModeArg(buildClaudeCodeArgs({ claudeCodePermissionMode: "bypassPermissions", claudeCodeAllowBypassPermissions: true })), "bypassPermissions");
		const effortArgs = buildClaudeCodeArgs({ initialThinkingLevel: "minimal" });
		assert.deepEqual(effortArgs.slice(-4), ["--permission-mode", "acceptEdits", "--effort", "low"]);
		assert.equal(normalizeClaudeCodeEffort("off"), "low");
		assert.equal(normalizeClaudeCodeEffort("xhigh"), "xhigh");
		assert.equal(normalizeClaudeCodeEffort("invalid"), undefined);
	});
});
