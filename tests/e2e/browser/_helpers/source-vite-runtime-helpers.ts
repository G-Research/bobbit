import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnTracked, type TrackedChild } from "../../../../src/server/agent/spawn-tree.js";

export type SourceProcessTreeAuthority = Pick<TrackedChild, "killTree" | "ownershipReady" | "waitForTreeExit">;

export interface RunningSourceProcess {
	child: ChildProcess;
	label: string;
	stdout: string[];
	stderr: string[];
	/** The root process identity is no longer safe to target after this boundary. */
	exited: boolean;
	closed: boolean;
	/** A graceful tree signal was dispatched while the root was still owned. */
	shutdownStarted: boolean;
	/** The detached POSIX group was observed while the root identity was live. */
	posixGroupOwned: boolean;
	/** A final POSIX group signal was dispatched at the root-exit boundary. */
	finalTreeSignalSent: boolean;
	/** Spawn-time Windows Job ownership; absent for raw fixture and POSIX processes. */
	trackedAuthority?: SourceProcessTreeAuthority;
	/** Coalesces repeated teardown onto the authority's single Job-close request. */
	trackedStop?: Promise<void>;
}

export interface StopSourceProcessOptions {
	/** Test seam: production teardown keeps a ten-second graceful shutdown window. */
	gracefulStopTimeoutMs?: number;
	/** Test seam: an authoritative signal receipt may gate forced escalation instead of elapsed time. */
	gracefulSignalReceipt?: Promise<void>;
	/** Test seam: bounds how long teardown waits for close after force-killing. */
	forceStopTimeoutMs?: number;
}

const SOURCE_PROCESS_GRACEFUL_STOP_TIMEOUT_MS = 10_000;
const SOURCE_PROCESS_FORCE_STOP_TIMEOUT_MS = 2_000;

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
let thinkingLevel = "off";
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
		send({ type: "response", id: message.id, success: true, data: { status: "idle", sessionFile, model, thinkingLevel } });
		return;
	}
	if (message.type === "set_thinking_level") {
		thinkingLevel = message.level;
		send({ type: "response", id: message.id, success: true });
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

export function captureSourceProcess(
	child: ChildProcess,
	label: string,
	trackedAuthority?: SourceProcessTreeAuthority,
): RunningSourceProcess {
	const runtime: RunningSourceProcess = {
		child,
		label,
		stdout: [],
		stderr: [],
		exited: false,
		closed: false,
		shutdownStarted: false,
		posixGroupOwned: false,
		finalTreeSignalSent: false,
		trackedAuthority,
	};
	child.stdout?.on("data", chunk => runtime.stdout.push(String(chunk)));
	child.stderr?.on("data", chunk => runtime.stderr.push(String(chunk)));
	// `exit` fences the root numeric identity. A graceful tree signal already
	// started while it was live may be completed exactly once at this boundary.
	child.once("exit", () => {
		runtime.exited = true;
		if (runtime.shutdownStarted && runtime.posixGroupOwned && process.platform !== "win32" && !runtime.finalTreeSignalSent) {
			forceExitedPosixGroup(runtime);
		}
	});
	child.once("close", () => { runtime.closed = true; });
	return runtime;
}

function startOwnedSourceProcess(
	file: string,
	args: readonly string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; stdio: StdioOptions; windowsHide: boolean },
	label: string,
): RunningSourceProcess {
	if (process.platform === "win32") {
		const tracked = spawnTracked(file, args, options);
		return captureSourceProcess(tracked.child, label, tracked);
	}
	const child = spawn(file, args, { ...options, detached: true });
	return captureSourceProcess(child, label);
}

export function startIsolatedSourceGateway(options: SourceGatewayOptions): RunningSourceProcess {
	const cliPath = resolve(options.repoRoot, "dist", "server", "cli.js");
	return startOwnedSourceProcess(process.execPath, [
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
		stdio: ["ignore", "pipe", "pipe"],
	}, "isolated Bobbit gateway");
}

export function startSourceVite(options: SourceViteOptions): RunningSourceProcess {
	const viteCli = resolve(options.repoRoot, "node_modules", "vite", "bin", "vite.js");
	const env = isolatedEnvironment(options.tempRoot);
	env.NODE_ENV = "development";
	env.GATEWAY_URL = options.gatewayUrl;
	env.VITE_HOST = "localhost";
	// This smoke proves the canonical bridge is loaded from Vite's source module
	// graph. The normal dev server remains bundled; only this owned fixture opts out.
	env.BOBBIT_VITE_SOURCE_GRAPH = "1";
	return startOwnedSourceProcess(process.execPath, [
		viteCli,
		"--host", "127.0.0.1",
		"--port", String(options.port),
		"--strictPort",
	], {
		cwd: options.repoRoot,
		env,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	}, "Vite source server");
}

async function joinSourceOwnership(runtime: RunningSourceProcess, deadline: number): Promise<void> {
	const ownershipReady = runtime.trackedAuthority?.ownershipReady;
	if (!ownershipReady) return;
	const remainingMs = Math.max(0, deadline - Date.now());
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			ownershipReady,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("ownership readiness timed out")), remainingMs);
			}),
		]);
	} catch (error) {
		throw processFailure(runtime, `failed before ownership readiness: ${String(error)}`);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

export async function waitForSourceGateway(baseUrl: string, runtime: RunningSourceProcess, timeoutMs = 120_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	await joinSourceOwnership(runtime, deadline);
	let lastError = "not attempted";
	while (Date.now() < deadline) {
		if (runtime.child.exitCode !== null) throw processFailure(runtime, `exited ${runtime.child.exitCode} before readiness`);
		try {
			const response = await fetch(`${baseUrl}/api/health`);
			if (response.ok) return;
			lastError = `${response.status} ${response.statusText}`;
		} catch (error) {
			lastError = String(error);
		}
		await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
	}
	throw processFailure(runtime, `readiness timed out: ${lastError}`);
}

export async function waitForSourceVite(baseUrl: string, runtime: RunningSourceProcess, timeoutMs = 120_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	await joinSourceOwnership(runtime, deadline);
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

function rootExited(runtime: RunningSourceProcess): boolean {
	return runtime.exited || runtime.child.exitCode !== null || runtime.child.signalCode !== null;
}

function signalOwnedProcessTree(runtime: RunningSourceProcess, signal: NodeJS.Signals): boolean {
	if (rootExited(runtime)) return false;
	const child = runtime.child;
	if (!child.pid) return false;
	if (process.platform === "win32") {
		// Raw fixture processes deliberately retain root-only termination. Real
		// Windows source runtimes use their spawn-time tracked Job authority above.
		try { child.kill(signal); } catch { /* root exited between observations */ }
		return true;
	}
	try {
		// Record continuous group ownership before delivery. The exit handler may
		// use this identity only once, at the root-exit boundary.
		process.kill(-child.pid, 0);
		runtime.posixGroupOwned = true;
		process.kill(-child.pid, signal);
	} catch {
		try { child.kill(signal); } catch { /* root exited between observations */ }
	}
	return true;
}

function forceExitedPosixGroup(runtime: RunningSourceProcess): void {
	const pid = runtime.child.pid;
	if (!pid || !runtime.posixGroupOwned || runtime.finalTreeSignalSent) return;
	// SIGTERM started before root exit. Only reap a group still observable at this
	// exact boundary; once empty, its numeric PGID must never be signalled later.
	try {
		process.kill(-pid, 0);
		process.kill(-pid, "SIGKILL");
	} catch { /* group already gone */ }
	runtime.finalTreeSignalSent = true;
}

function waitForProcessClose(runtime: RunningSourceProcess, timeoutMs: number): Promise<boolean> {
	if (runtime.closed) return Promise.resolve(true);
	return new Promise(resolveClosed => {
		const onClose = () => finish(true);
		const timeout = setTimeout(() => finish(false), timeoutMs);
		const finish = (closed: boolean) => {
			clearTimeout(timeout);
			runtime.child.removeListener("close", onClose);
			resolveClosed(closed);
		};
		runtime.child.once("close", onClose);
	});
}

type GracefulStopBoundary = "closed" | "receipt" | "deadline";

function waitForGracefulStopBoundary(
	runtime: RunningSourceProcess,
	receipt: Promise<void>,
	timeoutMs: number,
): Promise<GracefulStopBoundary> {
	if (runtime.closed) return Promise.resolve("closed");
	return new Promise((resolveBoundary, rejectBoundary) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			runtime.child.removeListener("close", onClose);
		};
		const finish = (boundary: GracefulStopBoundary) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolveBoundary(boundary);
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectBoundary(error);
		};
		const onClose = () => finish("closed");
		runtime.child.once("close", onClose);
		timeout = setTimeout(() => finish("deadline"), timeoutMs);
		void receipt.then(() => finish("receipt"), fail);
	});
}

function releaseProcessStdio(child: ChildProcess): void {
	for (const stream of [child.stdin, child.stdout, child.stderr]) {
		try { stream?.destroy(); } catch { /* best-effort cleanup after a failed OS close */ }
	}
	// If the OS did not acknowledge the forced kill, detached children must not
	// retain this Playwright worker through inherited stdio handles.
	try { child.unref(); } catch { /* child may have exited between checks */ }
}

function waitForTrackedTreeExit(authority: SourceProcessTreeAuthority, timeoutMs: number): Promise<boolean> {
	return new Promise((resolveCompletion, rejectCompletion) => {
		let settled = false;
		const finish = (result: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolveCompletion(result);
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			rejectCompletion(error);
		};
		const timeout = setTimeout(() => finish(false), timeoutMs);
		void Promise.resolve().then(() => authority.waitForTreeExit(timeoutMs)).then(finish, fail);
	});
}

function stopTrackedSourceProcess(
	runtime: RunningSourceProcess,
	gracefulStopTimeoutMs: number,
	forceStopTimeoutMs: number,
): Promise<void> {
	if (runtime.trackedStop) return runtime.trackedStop;
	if (runtime.closed) return Promise.resolve();
	const authority = runtime.trackedAuthority!;
	const completionTimeoutMs = gracefulStopTimeoutMs + forceStopTimeoutMs;
	runtime.trackedStop = Promise.resolve().then(async () => {
		runtime.shutdownStarted = true;
		authority.killTree("SIGKILL");
		let completed: boolean;
		try {
			completed = await waitForTrackedTreeExit(authority, completionTimeoutMs);
		} catch (error) {
			releaseProcessStdio(runtime.child);
			throw processFailure(runtime, `tree completion failed: ${String(error)}`);
		}
		if (!completed || !runtime.closed) {
			releaseProcessStdio(runtime.child);
			throw processFailure(runtime, completed
				? "tree completion was reported before process close"
				: `tree completion was not verified within ${completionTimeoutMs}ms`);
		}
	});
	return runtime.trackedStop;
}

export async function stopSourceProcess(
	runtime: RunningSourceProcess,
	options: StopSourceProcessOptions = {},
): Promise<void> {
	const gracefulStopTimeoutMs = options.gracefulStopTimeoutMs ?? SOURCE_PROCESS_GRACEFUL_STOP_TIMEOUT_MS;
	const forceStopTimeoutMs = options.forceStopTimeoutMs ?? SOURCE_PROCESS_FORCE_STOP_TIMEOUT_MS;
	if (runtime.trackedAuthority) {
		return stopTrackedSourceProcess(runtime, gracefulStopTimeoutMs, forceStopTimeoutMs);
	}
	if (runtime.closed) return;

	// Root exit is a hard PID/PGID ownership boundary. Do not send a late
	// numeric signal that could hit a reused process identity.
	if (rootExited(runtime)) {
		releaseProcessStdio(runtime.child);
		return;
	}

	// Initiate tree cleanup while the root remains the ownership witness. If it
	// exits while descendants retain stdio, captureSourceProcess sends the final
	// POSIX group signal synchronously at that exit boundary.
	runtime.shutdownStarted = signalOwnedProcessTree(runtime, "SIGTERM");
	if (options.gracefulSignalReceipt) {
		// A fixture that proves its handler is installed can fence escalation on the
		// actual signal receipt. A lost IPC receipt still yields at the same bounded
		// grace deadline, and every losing close/deadline listener is removed.
		const boundary = await waitForGracefulStopBoundary(
			runtime,
			options.gracefulSignalReceipt,
			gracefulStopTimeoutMs,
		);
		if (boundary === "closed") return;
	} else if (await waitForProcessClose(runtime, gracefulStopTimeoutMs)) {
		return;
	}

	// SIGTERM is deliberately not retried here: a stuck gateway may ignore it.
	// Force-kill only an identity still owned by this runtime, then wait for close
	// so inherited pipes cannot keep the Playwright worker alive.
	if (!rootExited(runtime) && process.platform !== "win32") {
		signalOwnedProcessTree(runtime, "SIGKILL");
		runtime.finalTreeSignalSent = true;
	}
	if (await waitForProcessClose(runtime, forceStopTimeoutMs)) return;

	releaseProcessStdio(runtime.child);
}

export function processFailure(runtime: RunningSourceProcess, message: string): Error {
	return new Error(`${runtime.label} ${message}\nstdout:\n${runtime.stdout.join("")}\nstderr:\n${runtime.stderr.join("")}`);
}
