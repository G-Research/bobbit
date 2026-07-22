import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface RunningSourceProcess {
	child: ChildProcess;
	label: string;
	stdout: string[];
	stderr: string[];
}

export interface SourceGatewayOptions {
	repoRoot: string;
	tempRoot: string;
	workspaceDir: string;
	agentPath: string;
	port: number;
}

export interface SourceViteOptions {
	repoRoot: string;
	tempRoot: string;
	gatewayUrl: string;
	port: number;
}

const SOURCE_VITE_THEME_HTML = `<!doctype html>
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
			window.__sourceViteThemeCapture = {
				background: styles.getPropertyValue('--background').trim(),
				foreground: styles.getPropertyValue('--foreground').trim(),
				card: styles.getPropertyValue('--card').trim(),
				positive: styles.getPropertyValue('--positive').trim(),
				chart: styles.getPropertyValue('--chart-1').trim(),
				font: styles.fontFamily,
				dark: document.documentElement.classList.contains('dark'),
				palette: document.documentElement.getAttribute('data-palette')
			};
			document.documentElement.setAttribute('data-source-vite-authored-script', 'true');
		})();
	</script>
</head>
<body><div id="semantic">SOURCE_VITE_INLINE_THEME_READY</div></body>
</html>`;

/** Focused pi RPC test double: one prompt emits one completed Write tool call. */
export function sourceViteWriteAgentSource(): string {
	return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const html = ${JSON.stringify(SOURCE_VITE_THEME_HTML)};
const messages = [];
const agentDir = process.env.BOBBIT_AGENT_DIR || process.cwd();
fs.mkdirSync(agentDir, { recursive: true });
const sessionFile = path.join(agentDir, "source-vite-inline-theme-session.jsonl");
const model = { provider: "mock", id: "source-vite-write-agent", contextWindow: 128000, maxTokens: 16384, reasoning: false };
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const persist = () => fs.writeFileSync(sessionFile, messages.map((message) => JSON.stringify({ type: "message", message })).join("\\n") + (messages.length ? "\\n" : ""));
const emit = (event) => send(event);

async function runPrompt(text) {
	const user = { role: "user", content: [{ type: "text", text }] };
	messages.push(user);
	emit({ type: "message_end", message: user });
	emit({ type: "agent_start" });
	emit({ type: "session_status", status: "streaming" });
	const toolId = "source-vite-inline-theme-write";
	const input = { path: "theme-card.html", content: html };
	emit({ type: "tool_execution_start", toolName: "write", toolId, input });
	emit({ type: "tool_execution_update", toolName: "write", toolId, status: "complete", output: "Wrote source-Vite inline theme fixture" });
	emit({ type: "tool_execution_end", toolName: "write", toolCallId: toolId, isError: false });
	const assistant = { role: "assistant", content: [
		{ type: "toolCall", id: toolId, name: "write", arguments: input, input },
		{ type: "text", text: "Rendered source-Vite inline HTML." }
	] };
	const result = { role: "toolResult", toolCallId: toolId, toolName: "write", isError: false, content: [{ type: "text", text: "Wrote source-Vite inline theme fixture" }] };
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

export async function writeSourceViteAgent(filePath: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, sourceViteWriteAgentSource(), "utf8");
}

function isolatedEnvironment(tempRoot: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of [
		"BOBBIT_TOKEN",
		"BOBBIT_PI_DIR",
		"GATEWAY_URL",
		"VITE_HOST",
	]) delete env[key];
	const home = join(tempRoot, "home");
	return {
		...env,
		NODE_ENV: "test",
		NO_COLOR: "1",
		BOBBIT_DIR: join(tempRoot, "headquarters"),
		BOBBIT_SECRETS_DIR: join(tempRoot, "secrets"),
		BOBBIT_AGENT_DIR: join(tempRoot, "agent-state"),
		BOBBIT_SKIP_MCP: "1",
		BOBBIT_SKIP_TITLE_GENERATION: "1",
		BOBBIT_SKIP_NPM_CI: "1",
		BOBBIT_TEST_NO_EXTERNAL: "1",
		BOBBIT_TEST_NO_REMOTE: "1",
		HOME: home,
		USERPROFILE: home,
	};
}

function captureProcess(child: ChildProcess, label: string): RunningSourceProcess {
	const runtime = { child, label, stdout: [] as string[], stderr: [] as string[] };
	child.stdout?.on("data", chunk => runtime.stdout.push(String(chunk)));
	child.stderr?.on("data", chunk => runtime.stderr.push(String(chunk)));
	return runtime;
}

export function startIsolatedSourceGateway(options: SourceGatewayOptions): RunningSourceProcess {
	const cliPath = resolve(options.repoRoot, "dist", "server", "cli.js");
	const child = spawn(process.execPath, [
		cliPath,
		"--cwd", options.workspaceDir,
		"--host", "127.0.0.1",
		"--port", String(options.port),
		"--no-tls",
		"--no-ui",
		"--agent-cli", options.agentPath,
	], {
		cwd: options.repoRoot,
		env: isolatedEnvironment(options.tempRoot),
		windowsHide: true,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return captureProcess(child, "isolated Bobbit gateway");
}

export function startSourceVite(options: SourceViteOptions): RunningSourceProcess {
	const viteCli = resolve(options.repoRoot, "node_modules", "vite", "bin", "vite.js");
	const env = isolatedEnvironment(options.tempRoot);
	env.NODE_ENV = "development";
	env.GATEWAY_URL = options.gatewayUrl;
	env.VITE_HOST = "localhost";
	const child = spawn(process.execPath, [
		viteCli,
		"--host", "127.0.0.1",
		"--port", String(options.port),
		"--strictPort",
	], {
		cwd: options.repoRoot,
		env,
		windowsHide: true,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return captureProcess(child, "Vite source server");
}

export async function waitForSourceVite(baseUrl: string, runtime: RunningSourceProcess, timeoutMs = 120_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError = "not attempted";
	while (Date.now() < deadline) {
		if (runtime.child.exitCode !== null) throw processFailure(runtime, `exited ${runtime.child.exitCode} before readiness`);
		try {
			const response = await fetch(`${baseUrl}/`);
			const body = await response.text();
			if (response.ok && body.includes('/src/app/main.ts')) return;
			lastError = `${response.status} ${response.statusText}; sourceEntry=${body.includes('/src/app/main.ts')}`;
		} catch (error) {
			lastError = String(error);
		}
		await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
	}
	throw processFailure(runtime, `readiness timed out: ${lastError}`);
}

function killTree(child: ChildProcess): void {
	if (!child.pid) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		return;
	}
	try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
}

export async function stopSourceProcess(runtime: RunningSourceProcess): Promise<void> {
	if (runtime.child.exitCode !== null) return;
	const closed = new Promise<void>(resolveClosed => runtime.child.once("close", () => resolveClosed()));
	killTree(runtime.child);
	await Promise.race([closed, new Promise<void>(resolveDelay => setTimeout(resolveDelay, 10_000))]);
	if (runtime.child.exitCode === null) killTree(runtime.child);
}

export function processFailure(runtime: RunningSourceProcess, message: string): Error {
	return new Error(`${runtime.label} ${message}\nstdout:\n${runtime.stdout.join("")}\nstderr:\n${runtime.stderr.join("")}`);
}
