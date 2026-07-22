import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import WebSocket from "ws";

export interface CommandResult {
	command: string;
	args: string[];
	code: number;
	stdout: string;
	stderr: string;
}

export interface RunningCli {
	child: ChildProcess;
	stdout: string[];
	stderr: string[];
}

const PACKED_THEME_HTML = `<!doctype html>
<html>
<head>
	<style>
		:root { background: var(--background); color: var(--foreground); font-family: inherit; }
		body { margin: 0; background: var(--card); color: var(--foreground); }
		#semantic { color: var(--positive); border-color: var(--chart-1); }
	</style>
	<script>
		(function () {
			var styles = getComputedStyle(document.documentElement);
			window.__packedThemeCapture = {
				background: styles.getPropertyValue('--background').trim(),
				foreground: styles.getPropertyValue('--foreground').trim(),
				card: styles.getPropertyValue('--card').trim(),
				positive: styles.getPropertyValue('--positive').trim(),
				chart: styles.getPropertyValue('--chart-1').trim(),
				font: styles.fontFamily,
				dark: document.documentElement.classList.contains('dark'),
				palette: document.documentElement.getAttribute('data-palette')
			};
			document.documentElement.setAttribute('data-authored-script-ran', 'true');
		})();
	</script>
</head>
<body><div id="semantic">PACKAGED_INLINE_THEME_READY</div></body>
</html>`;

/** A focused pi RPC test double written into the clean consumer. It emits a
 * completed Write tool call containing token-backed HTML; no repository source
 * module is imported by the installed Bobbit process or its browser runtime. */
export function packedWriteAgentSource(): string {
	return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const html = ${JSON.stringify(PACKED_THEME_HTML)};
const messages = [];
const agentDir = process.env.BOBBIT_AGENT_DIR || process.cwd();
fs.mkdirSync(agentDir, { recursive: true });
const sessionFile = path.join(agentDir, "packed-inline-theme-session.jsonl");
const model = { provider: "mock", id: "mock-model", contextWindow: 128000, maxTokens: 16384, reasoning: false };
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const persist = () => fs.writeFileSync(sessionFile, messages.map((message) => JSON.stringify({ type: "message", message })).join("\\n") + (messages.length ? "\\n" : ""));
const emit = (event) => send(event);

async function runPrompt(text) {
	const user = { role: "user", content: [{ type: "text", text }] };
	messages.push(user);
	emit({ type: "message_end", message: user });
	emit({ type: "agent_start" });
	emit({ type: "session_status", status: "streaming" });
	const toolId = "packed-inline-theme-write";
	const input = { path: "theme-card.html", content: html };
	emit({ type: "tool_execution_start", toolName: "Write", toolId, input });
	emit({ type: "tool_execution_update", toolName: "Write", toolId, status: "complete", output: "Wrote packaged inline theme fixture" });
	emit({ type: "tool_execution_end", toolName: "Write", toolCallId: toolId, isError: false });
	const assistant = { role: "assistant", content: [
		{ type: "toolCall", id: toolId, name: "Write", arguments: input, input },
		{ type: "text", text: "Rendered packaged inline HTML." }
	] };
	const result = { role: "toolResult", toolCallId: toolId, toolName: "Write", isError: false, content: [{ type: "text", text: "Wrote packaged inline theme fixture" }] };
	messages.push(assistant, result);
	emit({ type: "message_end", message: assistant });
	emit({ type: "message_end", message: result });
	persist();
	emit({ type: "agent_end" });
	emit({ type: "session_status", status: "idle" });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	let message;
	try { message = JSON.parse(line); } catch { return; }
	if (message.type === "prompt" || message.type === "follow_up") {
		send({ type: "response", id: message.id, success: true });
		void runPrompt(message.message || "");
		return;
	}
	if (message.type === "get_state") {
		persist();
		send({ type: "response", id: message.id, success: true, data: { status: "idle", sessionFile, model } });
		return;
	}
	if (message.type === "get_messages") {
		send({ type: "response", id: message.id, success: true, data: messages });
		return;
	}
	if (message.type === "abort") {
		send({ type: "response", id: message.id, success: true });
		emit({ type: "agent_end" });
		emit({ type: "session_status", status: "idle" });
		return;
	}
	send({ type: "response", id: message.id, success: true });
});
send({ type: "session_status", status: "idle" });
`;
}

function displayCommand(command: string, args: readonly string[]): string {
	return [command, ...args].map(value => /\s/.test(value) ? JSON.stringify(value) : value).join(" ");
}

function killTree(child: ChildProcess): void {
	if (!child.pid) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		return;
	}
	try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
}

export function runCommand(
	command: string,
	args: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number },
): Promise<CommandResult> {
	const rendered = displayCommand(command, args);
	const timeoutMs = options.timeoutMs ?? 120_000;
	const maxOutputBytes = options.maxOutputBytes ?? 20 * 1024 * 1024;
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let terminalError: Error | undefined;
		let settled = false;
		const collect = (target: Buffer[], chunk: Buffer | string): void => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			outputBytes += buffer.byteLength;
			if (outputBytes > maxOutputBytes && !terminalError) {
				terminalError = new Error(`${rendered} exceeded the ${maxOutputBytes}-byte output limit`);
				killTree(child);
				return;
			}
			target.push(buffer);
		};
		child.stdout?.on("data", chunk => collect(stdout, chunk));
		child.stderr?.on("data", chunk => collect(stderr, chunk));
		const timer = setTimeout(() => {
			terminalError = new Error(`${rendered} timed out after ${timeoutMs}ms`);
			killTree(child);
		}, timeoutMs);
		child.once("error", error => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`Failed to spawn ${rendered}: ${error.message}`, { cause: error }));
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const stdoutText = Buffer.concat(stdout).toString("utf8");
			const stderrText = Buffer.concat(stderr).toString("utf8");
			if (terminalError) {
				reject(new Error(`${terminalError.message}\nstdout:\n${stdoutText}\nstderr:\n${stderrText}`));
				return;
			}
			if (signal || code === null) {
				reject(new Error(`${rendered} terminated without an exit code (signal: ${signal ?? "unknown"})`));
				return;
			}
			resolve({ command, args: [...args], code, stdout: stdoutText, stderr: stderrText });
		});
	});
}

function npmInvocation(args: string[]): { command: string; args: string[] } {
	const npmExecPath = process.env.npm_execpath;
	if (npmExecPath && existsSync(npmExecPath)) return { command: process.execPath, args: [npmExecPath, ...args] };
	return { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

export function runNpm(
	args: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number },
): Promise<CommandResult> {
	const invocation = npmInvocation(args);
	return runCommand(invocation.command, invocation.args, options);
}

/** Drop npm lifecycle variables inherited from the Bobbit test command so the
 * empty consumer behaves like an independent npm project. Registry/cache/auth
 * configuration remains inherited from the machine running the E2E lane. */
export function cleanConsumerNpmEnv(cwd: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) {
		const lower = key.toLowerCase();
		if (lower.startsWith("npm_package_") || lower.startsWith("npm_lifecycle_") || [
			"npm_config_local_prefix",
			"npm_config_package_lock",
			"npm_config_shrinkwrap",
			"npm_config_workspace",
			"npm_config_workspaces",
			"npm_config_include_workspace_root",
			"npm_config_ignore_scripts",
			"npm_config_omit",
			"npm_config_include",
			"npm_config_optional",
			"npm_config_dry_run",
		].includes(lower)) delete env[key];
	}
	delete env.INIT_CWD;
	env.INIT_CWD = cwd;
	return env;
}

export async function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("failed to allocate an IPv4 test port"));
				return;
			}
			const port = address.port;
			server.close(error => error ? reject(error) : resolve(port));
		});
	});
}

export function startPackagedCli(options: {
	cliPath: string;
	consumerDir: string;
	workspaceDir: string;
	agentPath: string;
	secretsDir: string;
	agentDir: string;
	port: number;
}): RunningCli {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const home = join(options.consumerDir, "home");
	const child = spawn(process.execPath, [
		options.cliPath,
		"--cwd", options.workspaceDir,
		"--host", "127.0.0.1",
		"--port", String(options.port),
		"--no-tls",
		"--agent-cli", options.agentPath,
	], {
		cwd: options.consumerDir,
		env: {
			...process.env,
			NODE_ENV: "test",
			NO_COLOR: "1",
			BOBBIT_SKIP_MCP: "1",
			BOBBIT_SKIP_TITLE_GENERATION: "1",
			BOBBIT_SKIP_NPM_CI: "1",
			BOBBIT_TEST_NO_EXTERNAL: "1",
			BOBBIT_TEST_NO_REMOTE: "1",
			BOBBIT_SECRETS_DIR: options.secretsDir,
			BOBBIT_AGENT_DIR: options.agentDir,
			HOME: home,
			USERPROFILE: home,
		},
		windowsHide: true,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.on("data", chunk => stdout.push(String(chunk)));
	child.stderr?.on("data", chunk => stderr.push(String(chunk)));
	return { child, stdout, stderr };
}

export async function waitForHealth(baseUrl: string, runtime: RunningCli, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError = "not attempted";
	while (Date.now() < deadline) {
		if (runtime.child.exitCode !== null) {
			throw new Error(`packaged CLI exited ${runtime.child.exitCode} before health check\nstdout:\n${runtime.stdout.join("")}\nstderr:\n${runtime.stderr.join("")}`);
		}
		try {
			const response = await fetch(`${baseUrl}/health`);
			if (response.ok) return;
			lastError = `${response.status} ${response.statusText}`;
		} catch (error) {
			lastError = String(error);
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(`packaged CLI health timed out: ${lastError}\nstdout:\n${runtime.stdout.join("")}\nstderr:\n${runtime.stderr.join("")}`);
}

export async function stopPackagedCli(runtime: RunningCli): Promise<void> {
	if (runtime.child.exitCode !== null) return;
	const closed = new Promise<void>(resolve => runtime.child.once("close", () => resolve()));
	if (process.platform === "win32") killTree(runtime.child);
	else {
		try { process.kill(-runtime.child.pid!, "SIGTERM"); } catch { runtime.child.kill("SIGTERM"); }
	}
	await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 10_000))]);
	if (runtime.child.exitCode === null) killTree(runtime.child);
}

export async function readToken(secretsDir: string): Promise<string> {
	const token = (await readFile(join(secretsDir, "token"), "utf8")).trim();
	if (token.length < 64) throw new Error(`packaged CLI wrote an invalid token to ${secretsDir}`);
	return token;
}

export async function createProjectAndSession(baseUrl: string, token: string, workspaceDir: string): Promise<string> {
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
	const projectResponse = await fetch(`${baseUrl}/api/projects`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			name: `packed-runtime-${process.pid}`,
			rootPath: workspaceDir,
			upsert: true,
			acceptCanonical: true,
		}),
	});
	if (!projectResponse.ok) throw new Error(`packed project creation failed: ${projectResponse.status} ${await projectResponse.text()}`);
	const project = await projectResponse.json() as { id?: string };
	if (!project.id) throw new Error("packed project creation returned no id");
	const sessionResponse = await fetch(`${baseUrl}/api/sessions`, {
		method: "POST",
		headers,
		body: JSON.stringify({ projectId: project.id, cwd: workspaceDir }),
	});
	if (sessionResponse.status !== 201) throw new Error(`packed session creation failed: ${sessionResponse.status} ${await sessionResponse.text()}`);
	const session = await sessionResponse.json() as { id?: string };
	if (!session.id) throw new Error("packed session creation returned no id");
	return session.id;
}

export async function promptSession(wsBaseUrl: string, sessionId: string, token: string): Promise<void> {
	const ws = new WebSocket(`${wsBaseUrl}/ws/${sessionId}`);
	const messages: unknown[] = [];
	let authenticated = false;
	let finished = false;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.close();
			reject(new Error(`packaged session prompt timed out; messages=${JSON.stringify(messages.slice(-12))}`));
		}, 30_000);
		ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
		ws.on("message", raw => {
			let message: any;
			try { message = JSON.parse(raw.toString()); } catch { return; }
			messages.push(message);
			if (message.type === "auth_ok" && !authenticated) {
				authenticated = true;
				ws.send(JSON.stringify({ type: "prompt", text: "emit the packaged inline HTML theme fixture" }));
			}
			if (authenticated && message.type === "event" && message.data?.type === "agent_end" && !finished) {
				finished = true;
				clearTimeout(timer);
				ws.close();
				resolve();
			}
		});
		ws.on("error", error => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

export async function writePackedAgent(filePath: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, packedWriteAgentSource(), "utf8");
}

export function commandFailure(result: CommandResult): string {
	return `${displayCommand(result.command, result.args)} failed with ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

export function assetBasename(filePath: string): string {
	return basename(filePath).replace(/\\/g, "/");
}
