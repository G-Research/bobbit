/**
 * Custom bash tool extension for Bobbit.
 *
 * Replaces the built-in bash tool with a version that:
 * 1. Listens for 'exit' instead of 'close' — resolves when the shell exits,
 *    not when all FD holders (grandchild processes) close their pipes.
 * 2. Forcefully destroys pipes after the process exits.
 * 3. Applies a default safety timeout (5 min) when none is specified.
 *
 * Also provides bash_bg_create, bash_bg_logs, bash_bg_kill tools for
 * managing long-running background processes via the gateway API.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { createWriteStream } from "node:fs";

const MAX_BYTES = 50 * 1024; // 50KB output limit
const MAX_LINES = 2000;
const DEFAULT_TIMEOUT = 300; // 5 minutes

function getShellConfig(): { shell: string; args: string[] } {
	if (process.platform === "win32") {
		const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
		try { if (fs.existsSync(gitBash)) return { shell: gitBash, args: ["-c"] }; } catch { /* */ }
		return { shell: "cmd.exe", args: ["/c"] };
	}
	return { shell: "/bin/bash", args: ["-c"] };
}

function getShellEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	// Ensure color output is disabled for cleaner parsing
	env.NO_COLOR = "1";
	env.FORCE_COLOR = "0";
	return env;
}

function stripAnsiCodes(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function truncateTail(content: string): { content: string; truncated: boolean } {
	const lines = content.split("\n");
	if (lines.length <= MAX_LINES && content.length <= MAX_BYTES) {
		return { content, truncated: false };
	}
	// Take last MAX_LINES lines
	const tail = lines.slice(-MAX_LINES);
	let result = tail.join("\n");
	if (result.length > MAX_BYTES) {
		result = result.slice(-MAX_BYTES);
	}
	return { content: result, truncated: true };
}

function killProcessTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			process.kill(-pid, "SIGTERM");
		}
	} catch { /* process may already be dead */ }
}

function getModelName(sessionId: string | undefined): string {
	if (!sessionId) return '';
	try {
		const stateDir = process.env.BOBBIT_DIR
			? path.join(process.env.BOBBIT_DIR, 'state')
			: path.join(homedir(), '.pi');
		return fs.readFileSync(path.join(stateDir, `model-name-${sessionId}.txt`), 'utf-8').trim();
	} catch { return ''; }
}

function injectCoAuthorTrailer(command: string, sessionId: string | undefined): string {
	// Only match actual git commit commands
	const gitCommitPattern = /\bgit\s+commit\b/;
	if (!gitCommitPattern.test(command)) return command;

	// Don't add if already has Co-Authored-By trailer
	if (/--trailer\s+["']?Co-Authored/i.test(command)) return command;

	// Don't intercept merge commits, reverts, or cherry-picks (mechanical operations)
	if (/\bgit\s+(merge|revert|cherry-pick)\b/.test(command)) return command;

	// Build the trailer value — strip provider suffix like " (anthropic)" to keep it clean
	const modelName = getModelName(sessionId).replace(/\s*\([^)]*\)\s*$/, '');
	const author = modelName ? `Bobbit (${modelName})` : 'Bobbit';
	const trailer = `--trailer "Co-Authored-By: ${author} <bobbit@bobbit.ai>"`;

	// For chained commands (&&, ;, ||), find and modify each git commit portion
	return command.replace(
		/(\bgit\s+commit\b[^&|;]*)/g,
		(match) => {
			// Don't double-add if individual match already has --trailer
			if (match.includes('--trailer')) return match;
			return `${match.trimEnd()} ${trailer}`;
		}
	);
}

export default function (pi: ExtensionAPI) {
	// ── Gateway config ────────────────────────────────────────────
	const sessionId = process.env.BOBBIT_SESSION_ID;
	let token: string;
	let baseUrl: string;
	const envToken = process.env.BOBBIT_TOKEN;
	const envUrl = process.env.BOBBIT_GATEWAY_URL;
	if (envToken && envUrl) {
		token = envToken;
		baseUrl = envUrl.replace(/\/+$/, "");
	} else {
		try {
			const stateDir = process.env.BOBBIT_DIR
				? path.join(process.env.BOBBIT_DIR, "state")
				: path.join(homedir(), ".pi");
			const tokenFile = process.env.BOBBIT_DIR ? "token" : "gateway-token";
			token = fs.readFileSync(path.join(stateDir, tokenFile), "utf-8").trim();
			baseUrl = fs.readFileSync(path.join(stateDir, "gateway-url"), "utf-8").trim().replace(/\/+$/, "");
		} catch {
			console.error("[bash-tool] Cannot read gateway credentials");
			token = "";
			baseUrl = "";
		}
	}

	async function api(method: string, urlPath: string, body?: unknown): Promise<unknown> {
		const res = await fetch(`${baseUrl}${urlPath}`, {
			method,
			headers: {
				"Authorization": `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`API ${method} ${urlPath} failed (${res.status}): ${text}`);
		}
		return res.json();
	}

	// ── Custom bash tool ──────────────────────────────────────────

	pi.registerTool({
		name: "bash",
		label: "Bash",
		description: "Execute a bash command. Returns stdout+stderr. Output truncated to last 2000 lines / 50KB.",
		parameters: Type.Object({
			command: Type.String({ description: "The bash command to execute" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 300)" })),
		}),
		async execute(_toolCallId, { command, timeout }, abortSignal, onUpdate) {
			return new Promise((resolve) => {
				const timeoutSec = timeout ?? DEFAULT_TIMEOUT;
				const { shell, args } = getShellConfig();

				command = injectCoAuthorTrailer(command, sessionId);

			const child = spawn(shell, [...args, command], {
					detached: true,
					env: getShellEnv(),
					cwd: process.cwd(),
					stdio: ["ignore", "pipe", "pipe"],
				});

				const outputChunks: string[] = [];
				let outputBytes = 0;
				let tempFilePath: string | undefined;
				let tempFileStream: fs.WriteStream | undefined;
				let totalBytes = 0;
				let timedOut = false;

				// Timeout handler
				const timer = setTimeout(() => {
					timedOut = true;
					if (child.pid) killProcessTree(child.pid);
				}, timeoutSec * 1000);

				// Abort handler
				const abortHandler = () => {
					if (child.pid) killProcessTree(child.pid);
				};
				if (abortSignal) {
					if (abortSignal.aborted) {
						child.kill();
						clearTimeout(timer);
						resolve({ content: [{ type: "text" as const, text: "" }], details: { truncated: false } });
						return;
					}
					abortSignal.addEventListener("abort", abortHandler, { once: true });
				}

				const handleData = (data: Buffer) => {
					totalBytes += data.length;
					const text = stripAnsiCodes(data.toString("utf-8")).replace(/\r/g, "");

					// Temp file for large output
					if (totalBytes > MAX_BYTES && !tempFilePath) {
						const id = randomBytes(8).toString("hex");
						tempFilePath = path.join(tmpdir(), `bobbit-bash-${id}.log`);
						tempFileStream = createWriteStream(tempFilePath);
						for (const chunk of outputChunks) tempFileStream.write(chunk);
					}
					if (tempFileStream) tempFileStream.write(text);

					outputChunks.push(text);
					outputBytes += text.length;
					while (outputBytes > MAX_BYTES * 2 && outputChunks.length > 1) {
						const removed = outputChunks.shift()!;
						outputBytes -= removed.length;
					}

					// Stream to agent UI
					if (onUpdate) onUpdate({ content: [{ type: "text" as const, text }], details: {} });
				};

				child.stdout?.on("data", handleData);
				child.stderr?.on("data", handleData);

				// KEY FIX: Listen for 'exit' instead of 'close'.
				// 'exit' fires when the shell process itself exits.
				// 'close' waits for ALL FD holders (grandchild processes) to close pipes.
				child.on("exit", (code) => {
					clearTimeout(timer);
					if (abortSignal) abortSignal.removeEventListener("abort", abortHandler);

					// Forcefully destroy pipes so grandchild FDs don't block
					child.stdout?.destroy();
					child.stderr?.destroy();

					if (tempFileStream) tempFileStream.end();

					const fullOutput = outputChunks.join("");
					const { content, truncated } = truncateTail(fullOutput);
					const cancelled = code === null;

					let output = truncated ? content : fullOutput;
					if (timedOut) {
						output += `\n[Command timed out after ${timeoutSec}s and was killed]`;
					}
					if (truncated && tempFilePath) {
						output += `\n[Output truncated. Full output saved to ${tempFilePath}]`;
					}

					resolve({
						content: [{ type: "text" as const, text: `Exit code: ${cancelled ? "killed" : code}\n${output}` }],
						details: { truncated, fullOutputPath: tempFilePath },
					});
				});

				child.on("error", (err) => {
					clearTimeout(timer);
					if (abortSignal) abortSignal.removeEventListener("abort", abortHandler);
					if (tempFileStream) tempFileStream.end();
					resolve({
						content: [{ type: "text" as const, text: `Error spawning command: ${err.message}` }],
						details: {},
					});
				});
			});
		},
	});

	// ── bash_bg_create ────────────────────────────────────────────

	pi.registerTool({
		name: "bash_bg",
		label: "Background Process",
		description: "Manage background shell processes. Actions: create, logs, grep, head, slice, kill, list.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("create"),
				Type.Literal("logs"),
				Type.Literal("grep"),
				Type.Literal("head"),
				Type.Literal("slice"),
				Type.Literal("kill"),
				Type.Literal("list"),
				Type.Literal("wait"),
			], { description: "Action to perform" }),
			command: Type.Optional(Type.String({ description: "Shell command to run (for 'create')" })),
			name: Type.Optional(Type.String({ description: "Short name for the process (max 3 words, required for 'create'). Example: 'dev server', 'color echo loop', 'test runner'" })),
			id: Type.Optional(Type.String({ description: "Background process ID (for 'logs', 'grep', 'head', 'slice', 'kill', 'wait')" })),
			timeout: Type.Optional(Type.Number({ description: "Max seconds to wait (default: 300, for 'wait')" })),
			tail: Type.Optional(Type.Number({ description: "Number of log lines to return from end (default: 200, for 'logs')" })),
			pattern: Type.Optional(Type.String({ description: "Search pattern — string or regex (for 'grep')" })),
			context: Type.Optional(Type.Number({ description: "Lines of context around each match (default: 0, for 'grep')" })),
			max_results: Type.Optional(Type.Number({ description: "Max matches to return (default: 50, for 'grep')" })),
			lines: Type.Optional(Type.Number({ description: "Number of lines (default: 50, for 'head')" })),
			from: Type.Optional(Type.Number({ description: "Start line, 1-indexed (for 'slice')" })),
			to: Type.Optional(Type.Number({ description: "End line, inclusive (for 'slice')" })),
		}),
		async execute(_toolCallId, { action, command, name, id, tail, timeout, pattern, context, max_results, lines, from, to }) {
			const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

			if (!sessionId || !baseUrl) {
				return text("Error: Missing BOBBIT_SESSION_ID or gateway credentials");
			}

			try {
				switch (action) {
					case "create": {
						if (!command) return text("Error: 'command' is required for create");
						if (!name) return text("Error: 'name' is required for create — provide a short descriptive name (max 3 words)");
						const result = await api("POST", `/api/sessions/${sessionId}/bg-processes`, { command, name }) as any;
						return text(`Background process started.\nID: ${result.id}\nPID: ${result.pid}\nCommand: ${command}\n\nUse bash_bg with action "logs" and id "${result.id}" to check output.\nUse bash_bg with action "kill" and id "${result.id}" to terminate.`);
					}
					case "logs": {
						if (!id) return text("Error: 'id' is required for logs");
						const logs = await api("GET", `/api/sessions/${sessionId}/bg-processes/${id}/logs?tail=${tail || 200}`) as any;
						const output = logs.log?.map((e: any) => typeof e === "string" ? e : e.text ?? String(e)).join("\n") || "(no output)";
						return text(`Logs for ${id}:\n${output}`);
					}
					case "grep": {
						if (!id) return text("Error: 'id' is required for grep");
						if (!pattern) return text("Error: 'pattern' is required for grep");
						const params = new URLSearchParams({ pattern });
						if (context) params.set("context", String(context));
						if (max_results) params.set("max", String(max_results));
						const grepResult = await api("GET", `/api/sessions/${sessionId}/bg-processes/${id}/grep?${params}`) as any;
						if (grepResult.matches.length === 0) return text(`No matches for "${pattern}" in ${id} (${grepResult.total} total lines searched)`);
						const matchLines = grepResult.matches.map((m: any) => `${String(m.line).padStart(5)}  ${m.text}`).join("\n");
						return text(`${grepResult.total} match${grepResult.total !== 1 ? "es" : ""} for "${pattern}" in ${id}${grepResult.total > grepResult.matches.length ? ` (showing first ${grepResult.matches.length})` : ""}:\n${matchLines}`);
					}
					case "head": {
						if (!id) return text("Error: 'id' is required for head");
						const headResult = await api("GET", `/api/sessions/${sessionId}/bg-processes/${id}/head?lines=${lines || 50}`) as any;
						const headOutput = headResult.log?.map((e: any) => typeof e === "string" ? e : e.text ?? String(e)).join("\n") || "(no output)";
						return text(`First ${headResult.log?.length ?? 0} of ${headResult.totalLines} lines from ${id}:\n${headOutput}`);
					}
					case "slice": {
						if (!id) return text("Error: 'id' is required for slice");
						if (!from || !to) return text("Error: 'from' and 'to' are required for slice (1-indexed line numbers)");
						const sliceResult = await api("GET", `/api/sessions/${sessionId}/bg-processes/${id}/slice?from=${from}&to=${to}`) as any;
						const sliceOutput = sliceResult.log?.map((e: any, i: number) => `${String(from + i).padStart(5)}  ${typeof e === "string" ? e : e.text ?? String(e)}`).join("\n") || "(no output)";
						return text(`Lines ${from}-${to} of ${sliceResult.totalLines} from ${id}:\n${sliceOutput}`);
					}
					case "kill": {
						if (!id) return text("Error: 'id' is required for kill");
						await api("DELETE", `/api/sessions/${sessionId}/bg-processes/${id}`);
						return text(`Background process ${id} killed.`);
					}
					case "wait": {
						if (!id) return text("Error: 'id' is required for wait");
						const waitSec = timeout || 300;
						const waitResult = await api("GET", `/api/sessions/${sessionId}/bg-processes/${id}/wait?timeout=${waitSec}`) as any;
						const info = waitResult.info;
						if (waitResult.timedOut) {
							return text(`Process ${id} still running after ${waitSec}s (pid=${info.pid}, status=${info.status}). Use "logs", "grep", or "kill" to manage it.`);
						}
						return text(`Process ${id} exited with code ${info.exitCode}.\nUse bash_bg with action "grep" and id "${id}" to search output, or "logs" to see the tail.`);
					}
					case "list": {
						const data = await api("GET", `/api/sessions/${sessionId}/bg-processes`) as any;
						const procs = data.processes || [];
						if (procs.length === 0) return text("No background processes.");
						const lines = procs.map((p: any) =>
							`${p.id} [${p.status}] pid=${p.pid} cmd="${p.command}"${p.exitCode !== null ? ` exit=${p.exitCode}` : ""}`
						);
						return text(`Background processes:\n${lines.join("\n")}`);
					}
					default:
						return text(`Unknown action: ${action}`);
				}
			} catch (err: any) {
				return text(`Error: ${err.message}`);
			}
		},
	});
}
