import { Type } from "@sinclair/typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { getGatewayToken, getGatewayUrl } from "../_shared/gateway.ts";

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;
const DEFAULT_TIMEOUT = 300;

type PolicyDecision = { allowed: true; argv: string[] } | { allowed: false; reason: string; argv?: string[] };

async function loadPolicy(): Promise<(command: string) => PolicyDecision> {
	try {
		const mod = await import("../../../src/server/pr-walkthrough/walkthrough-readonly-policy.ts");
		return mod.evaluateWalkthroughReadonlyCommand;
	} catch {
		const mod = await import("../../../pr-walkthrough/walkthrough-readonly-policy.js");
		return mod.evaluateWalkthroughReadonlyCommand;
	}
}

function getShellConfig(): { shell: string; args: string[] } {
	if (process.platform === "win32") {
		const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
		try { if (fs.existsSync(gitBash)) return { shell: gitBash, args: ["-c"] }; } catch { /* ignore */ }
		return { shell: "cmd.exe", args: ["/c"] };
	}
	return { shell: "/bin/bash", args: ["-c"] };
}

function getShellEnv(): NodeJS.ProcessEnv {
	return { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
}

function stripAnsiCodes(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function truncateTail(content: string): { content: string; truncated: boolean } {
	const lines = content.split("\n");
	if (lines.length <= MAX_LINES && content.length <= MAX_BYTES) return { content, truncated: false };
	let result = lines.slice(-MAX_LINES).join("\n");
	if (result.length > MAX_BYTES) result = result.slice(-MAX_BYTES);
	return { content: result, truncated: true };
}

function killProcessTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			process.kill(-pid, "SIGTERM");
		}
	} catch { /* process may already be gone */ }
}

function toolText(text: string, isError = false, details?: unknown) {
	return { content: [{ type: "text" as const, text }], isError, details };
}

function formatGatewayResponse(data: unknown): string {
	if (data && typeof data === "object" && "message" in data && typeof (data as any).message === "string") {
		return `${(data as any).message}\n\n${JSON.stringify(data, null, 2)}`;
	}
	return JSON.stringify(data, null, 2);
}

const extension: ExtensionFactory = (pi) => {
	const sessionId = process.env.BOBBIT_SESSION_ID;
	const jobId = process.env.BOBBIT_WALKTHROUGH_JOB_ID;
	if (!sessionId || !jobId) return;

	pi.registerTool({
		name: "readonly_bash",
		label: "Read-only Bash",
		description: "Run a strictly read-only shell command for PR walkthrough analysis.",
		promptSnippet: "Run gh/git/search/read-only shell commands. Mutating commands, tests, builds, installs, servers, and GitHub review/comment actions are blocked.",
		parameters: Type.Object({
			command: Type.String(),
			timeout: Type.Optional(Type.Number({ description: "Seconds. Default 300." })),
			description: Type.Optional(Type.String({ description: "Short label (3-6 words)." })),
		}),
		async execute(_toolCallId, { command, timeout }, abortSignal, onUpdate) {
			let evaluate: (command: string) => PolicyDecision;
			try {
				evaluate = await loadPolicy();
			} catch (err: any) {
				return toolText(`readonly_bash policy failed to load: ${err?.message || err}`, true);
			}

			const decision = evaluate(command);
			if (!decision.allowed) {
				return toolText(`Command blocked by PR walkthrough read-only policy: ${decision.reason}. Use read-only PR/diff inspection instead.`, true, { policy: decision });
			}

			return new Promise((resolve) => {
				const timeoutSec = timeout ?? DEFAULT_TIMEOUT;
				const { shell, args } = getShellConfig();
				const child = spawn(shell, [...args, command], {
					detached: true,
					env: getShellEnv(),
					cwd: process.cwd(),
					stdio: ["ignore", "pipe", "pipe"],
				});

				const chunks: string[] = [];
				let outputBytes = 0;
				let timedOut = false;
				let truncatedByStreaming = false;

				const timer = setTimeout(() => {
					timedOut = true;
					if (child.pid) killProcessTree(child.pid);
				}, timeoutSec * 1000);

				const abortHandler = () => {
					if (child.pid) killProcessTree(child.pid);
				};
				if (abortSignal) {
					if (abortSignal.aborted) {
						clearTimeout(timer);
						resolve(toolText("", false, { truncated: false, policy: decision }));
						return;
					}
					abortSignal.addEventListener("abort", abortHandler, { once: true });
				}

				const handleData = (data: Buffer) => {
					const text = stripAnsiCodes(data.toString("utf-8")).replace(/\r/g, "");
					chunks.push(text);
					outputBytes += text.length;
					while (outputBytes > MAX_BYTES * 2 && chunks.length > 1) {
						const removed = chunks.shift()!;
						outputBytes -= removed.length;
						truncatedByStreaming = true;
					}
					if (onUpdate) {
						const updateText = text.length > 8192 ? `${text.slice(0, 8192)}\n[update truncated]` : text;
						onUpdate({ content: [{ type: "text" as const, text: updateText }], details: { truncated: text.length > 8192 } });
					}
				};

				child.stdout?.on("data", handleData);
				child.stderr?.on("data", handleData);
				child.on("exit", (code) => {
					clearTimeout(timer);
					if (abortSignal) abortSignal.removeEventListener("abort", abortHandler);
					child.stdout?.destroy();
					child.stderr?.destroy();

					let output = chunks.join("");
					const truncated = truncateTail(output);
					output = truncated.content;
					if (timedOut) output += `\n\nCommand timed out after ${timeoutSec}s`;
					output += `\n\nExit code: ${code ?? "unknown"}`;
					const wasTruncated = truncated.truncated || truncatedByStreaming;
					if (wasTruncated) output = `[Output truncated to last ${MAX_LINES} lines / ${MAX_BYTES} bytes]\n` + output;

					resolve(toolText(output, false, { exitCode: code, truncated: wasTruncated, policy: decision }));
				});
				child.on("error", (err) => {
					clearTimeout(timer);
					if (abortSignal) abortSignal.removeEventListener("abort", abortHandler);
					resolve(toolText(`readonly_bash failed: ${err.message}`, true, { policy: decision }));
				});
			});
		},
	});

	pi.registerTool({
		name: "submit_pr_walkthrough_yaml",
		label: "Submit PR Walkthrough YAML",
		description: "Submit the completed PR walkthrough YAML document for validation and panel publishing.",
		promptSnippet: "Submit exactly one completed PR walkthrough YAML document. If validation fails, fix the YAML and call this tool again.",
		parameters: Type.Object({ yaml: Type.String({ description: "The complete YAML document matching the PR walkthrough schema." }) }),
		async execute(_toolCallId, { yaml }) {
			let baseUrl: string;
			let token: string;
			try {
				baseUrl = getGatewayUrl();
				token = getGatewayToken();
			} catch {
				return toolText("submit_pr_walkthrough_yaml failed: missing Bobbit gateway credentials.", true);
			}

			try {
				const response = await fetch(`${baseUrl}/api/internal/pr-walkthrough/submit-yaml`, {
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
					body: JSON.stringify({ sessionId, jobId, yaml }),
				});
				const text = await response.text();
				let data: unknown = text;
				try { data = JSON.parse(text); } catch { /* keep text */ }
				if (!response.ok) return toolText(formatGatewayResponse(data), true, data);
				return toolText(formatGatewayResponse(data), false, data);
			} catch (err: any) {
				return toolText(`submit_pr_walkthrough_yaml failed: ${err?.message || err}`, true);
			}
		},
	});
};

export default extension;
