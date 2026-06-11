import { Type } from "@sinclair/typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import path from "node:path";
import { getGatewayToken, getGatewayUrl } from "../_shared/gateway.ts";

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;
const DEFAULT_TIMEOUT = 300;
const MAX_TIMEOUT_SECONDS = 300;

const TRUSTED_COMMANDS = new Set(["gh", "git", "rg", "grep", "find", "ls", "cat", "head", "tail", "pwd", "sed"]);

type PolicyDecision = { allowed: true; argv: string[] } | { allowed: false; reason: string; argv?: string[] };
type PolicyOptions = { githubTarget?: { provider: "github"; owner: string; repo: string; number: number } };

export interface TrustedExecutableResolutionOptions {
	cwd?: string;
	envPath?: string;
	platform?: NodeJS.Platform;
	pathExt?: string;
	pathDelimiter?: string;
}

async function loadPolicy(): Promise<(command: string, options?: PolicyOptions) => PolicyDecision> {
	try {
		const mod = await import("../../../src/server/pr-walkthrough/walkthrough-readonly-policy.ts");
		return mod.evaluateWalkthroughReadonlyCommand;
	} catch {
		const mod = await import("../../../pr-walkthrough/walkthrough-readonly-policy.js");
		return mod.evaluateWalkthroughReadonlyCommand;
	}
}

function getReadonlyPolicyOptions(): PolicyOptions {
	const provider = process.env.BOBBIT_WALKTHROUGH_TARGET_PROVIDER;
	const owner = process.env.BOBBIT_WALKTHROUGH_TARGET_OWNER;
	const repo = process.env.BOBBIT_WALKTHROUGH_TARGET_REPO;
	const numberText = process.env.BOBBIT_WALKTHROUGH_TARGET_NUMBER;
	const number = numberText ? Number(numberText) : Number.NaN;
	if (provider === "github" && owner && repo && Number.isInteger(number)) {
		return { githubTarget: { provider: "github", owner, repo, number } };
	}
	return {};
}

function getSanitizedEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { NO_COLOR: "1", FORCE_COLOR: "0" };
	const pathValue = process.env.PATH ?? process.env.Path;
	if (pathValue) env.PATH = pathValue;
	if (process.env.HOME) env.HOME = process.env.HOME;
	else if (process.env.USERPROFILE) env.HOME = process.env.USERPROFILE;
	return env;
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

function resolveRealPath(p: string): string {
	try { return realpathSync.native(p); } catch { return path.resolve(p); }
}

function normalizeForCompare(p: string, platform: NodeJS.Platform): string {
	const resolved = path.resolve(p);
	return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInsideOrEqual(child: string, parent: string, platform: NodeJS.Platform): boolean {
	const normalizedChild = normalizeForCompare(child, platform);
	const normalizedParent = normalizeForCompare(parent, platform);
	if (normalizedChild === normalizedParent) return true;
	const relative = path.relative(normalizedParent, normalizedChild);
	return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function candidateExecutableNames(command: string, platform: NodeJS.Platform, pathExt: string): string[] {
	if (platform !== "win32") return [command];
	if (/\.[A-Za-z0-9]+$/.test(command)) return [command];
	const extensions = pathExt.split(";").map(ext => ext.trim().toLowerCase()).filter(Boolean);
	const preferred = [".exe", "", ...extensions.filter(ext => ext !== ".exe")];
	return Array.from(new Set(preferred.map(ext => command + ext)));
}

function assertFileIsExecutable(candidate: string, platform: NodeJS.Platform): void {
	const mode = platform === "win32" ? fsConstants.F_OK : fsConstants.F_OK | fsConstants.X_OK;
	accessSync(candidate, mode);
}

export function resolveTrustedExecutable(command: string, options: TrustedExecutableResolutionOptions = {}): string {
	if (!TRUSTED_COMMANDS.has(command)) throw new Error(`${command} is not a trusted PR walkthrough executable`);
	if (/[\\/]/.test(command) || /^[A-Za-z]:/.test(command) || /\.(?:exe|cmd|bat|ps1|sh)$/i.test(command)) {
		throw new Error("readonly_bash only resolves bare trusted command names");
	}
	const platform = options.platform ?? process.platform;
	const cwd = resolveRealPath(options.cwd ?? process.cwd());
	const envPath = options.envPath ?? process.env.PATH ?? process.env.Path ?? "";
	const delimiter = options.pathDelimiter ?? (platform === "win32" ? ";" : path.delimiter);
	const pathExt = options.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
	const names = candidateExecutableNames(command, platform, pathExt);

	for (const rawDir of envPath.split(delimiter)) {
		if (!rawDir || rawDir === "." || !path.isAbsolute(rawDir)) continue;
		const realDir = resolveRealPath(rawDir);
		if (isPathInsideOrEqual(realDir, cwd, platform)) continue;
		for (const name of names) {
			const candidate = path.join(realDir, name);
			try {
				assertFileIsExecutable(candidate, platform);
				const realCandidate = resolveRealPath(candidate);
				if (isPathInsideOrEqual(realCandidate, cwd, platform)) continue;
				return realCandidate;
			} catch { /* try next candidate */ }
		}
	}

	throw new Error(`Unable to resolve trusted executable for ${command}; refusing to use PATH/current-directory resolution`);
}

function killProcessTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
			spawn(taskkill, ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			process.kill(-pid, "SIGTERM");
		}
	} catch { /* process may already be gone */ }
}

function toolText(text: string, isError = false, details?: unknown) {
	return { content: [{ type: "text" as const, text }], isError, details };
}

export function normalizeReadonlyTimeout(timeout: unknown): { ok: true; seconds: number; clamped: boolean } | { ok: false; reason: string } {
	if (timeout === undefined || timeout === null) return { ok: true, seconds: DEFAULT_TIMEOUT, clamped: false };
	if (typeof timeout !== "number" || !Number.isFinite(timeout)) return { ok: false, reason: "timeout must be a finite number of seconds" };
	if (timeout < 0) return { ok: false, reason: "timeout must be zero or greater" };
	return { ok: true, seconds: Math.min(timeout, MAX_TIMEOUT_SECONDS), clamped: timeout > MAX_TIMEOUT_SECONDS };
}

function formatGatewayResponse(data: unknown): string {
	if (data && typeof data === "object" && "message" in data && typeof (data as any).message === "string") {
		return `${(data as any).message}\n\n${JSON.stringify(data, null, 2)}`;
	}
	return JSON.stringify(data, null, 2);
}

const extension: ExtensionFactory = (pi) => {
	// host.agents reviewer migration (design Decision C): the boundary is now the
	// pr-reviewer role grant + the default-deny `PR Walkthrough` tool group — NOT an
	// env-gated secret. Register the tools whenever a session id is present
	// (registration ≠ activation; allowedTools gates who can actually call them). The
	// server resolves the job binding from the verified caller session secret, so no
	// per-job env var or submission-proof env is read here any more.
	const sessionId = process.env.BOBBIT_SESSION_ID;
	const sessionSecret = process.env.BOBBIT_SESSION_SECRET;
	if (!sessionId) return;

	pi.registerTool({
		name: "readonly_bash",
		label: "Read-only Bash",
		description: "Run a strictly read-only shell command for PR walkthrough analysis.",
		promptSnippet: "Run gh/git/search/read-only shell commands. GitHub PR reads are scoped to the launched PR when known; mutating commands, tests, builds, installs, servers, GitHub review/comment actions, hidden/ignore override flags, recursive root searches, and repo-local binary spoofing are blocked.",
		parameters: Type.Object({
			command: Type.String(),
			timeout: Type.Optional(Type.Number({ description: "Seconds. Default 300; finite non-negative values only; values above 300 are clamped." })),
			description: Type.Optional(Type.String({ description: "Short label (3-6 words)." })),
		}),
		async execute(_toolCallId, { command, timeout }, abortSignal, onUpdate) {
			const timeoutResult = normalizeReadonlyTimeout(timeout);
			if (!timeoutResult.ok) return toolText(`readonly_bash blocked invalid timeout: ${timeoutResult.reason}.`, true);
			if (abortSignal?.aborted) return toolText("readonly_bash interrupted before start.", true);

			let evaluate: (command: string, options?: PolicyOptions) => PolicyDecision;
			try {
				evaluate = await loadPolicy();
			} catch (err: any) {
				return toolText(`readonly_bash policy failed to load: ${err?.message || err}`, true);
			}

			const policyOptions = getReadonlyPolicyOptions();
			const decision = evaluate(command, policyOptions);
			if (!decision.allowed) {
				return toolText(`Command blocked by PR walkthrough read-only policy: ${decision.reason}. Use read-only PR/diff inspection instead.`, true, { policy: decision });
			}

			let executablePath: string;
			try {
				executablePath = resolveTrustedExecutable(decision.argv[0], { cwd: process.cwd() });
			} catch (err: any) {
				return toolText(`readonly_bash blocked executable resolution: ${err?.message || err}`, true, { policy: decision });
			}
			if (abortSignal?.aborted) return toolText("readonly_bash interrupted before start.", true, { policy: decision });

			return new Promise((resolve) => {
				const timeoutSec = timeoutResult.seconds;
				const args = decision.argv.slice(1);
				const child = spawn(executablePath, args, {
					detached: true,
					shell: false,
					env: getSanitizedEnv(),
					cwd: process.cwd(),
					stdio: ["ignore", "pipe", "pipe"],
				});

				const chunks: string[] = [];
				let outputBytes = 0;
				let timedOut = false;
				let aborted = false;
				let truncatedByStreaming = false;

				const timer = setTimeout(() => {
					timedOut = true;
					if (child.pid) killProcessTree(child.pid);
				}, timeoutSec * 1000);

				const abortHandler = () => {
					aborted = true;
					if (child.pid) killProcessTree(child.pid);
				};
				if (abortSignal) {
					abortSignal.addEventListener("abort", abortHandler, { once: true });
					if (abortSignal.aborted) abortHandler();
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
					if (aborted) output += "\n\nCommand interrupted; subprocess tree was killed";
					output += `\n\nExit code: ${code ?? "unknown"}`;
					const wasTruncated = truncated.truncated || truncatedByStreaming;
					if (wasTruncated) output = `[Output truncated to last ${MAX_LINES} lines / ${MAX_BYTES} bytes]\n` + output;

					resolve(toolText(output, false, { exitCode: code, truncated: wasTruncated, policy: decision, executablePath, timeoutClamped: timeoutResult.clamped, timeoutSec }));
				});
				child.on("error", (err) => {
					clearTimeout(timer);
					if (abortSignal) abortSignal.removeEventListener("abort", abortHandler);
					resolve(toolText(`readonly_bash failed: ${err.message}`, true, { policy: decision, executablePath }));
				});
			});
		},
	});

	pi.registerTool({
		name: "read_pr_walkthrough_bundle",
		label: "Read PR Walkthrough Bundle",
		description: "Read the scoped persisted launch-time PR metadata and diff bundle for this walkthrough job with bounded output.",
		promptSnippet: "Start PR walkthrough analysis by reading the authoritative persisted bundle. Use manifest/summary first, then read individual files by path or index with limits.",
		parameters: Type.Object({
			mode: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("manifest"), Type.Literal("files"), Type.Literal("file")], { description: "Bounded read mode. Default manifest." })),
			path: Type.Optional(Type.String({ description: "File path for mode=file." })),
			index: Type.Optional(Type.Number({ description: "File index for mode=file when path is omitted." })),
			offset: Type.Optional(Type.Number({ description: "File or hunk offset. Default 0." })),
			limit: Type.Optional(Type.Number({ description: "Maximum files/hunks to return. Default 50; capped by gateway." })),
			hunkOffset: Type.Optional(Type.Number({ description: "Hunk offset for mode=file." })),
			hunkLimit: Type.Optional(Type.Number({ description: "Maximum hunks for mode=file." })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, args) {
			let baseUrl: string;
			let token: string;
			try {
				baseUrl = getGatewayUrl();
				token = getGatewayToken();
			} catch {
				return toolText("read_pr_walkthrough_bundle failed: missing Bobbit gateway credentials.", true);
			}

			const readArgs = {
				mode: args.mode,
				path: args.path,
				index: args.index,
				offset: args.offset,
				limit: args.limit,
				hunkOffset: args.hunkOffset,
				hunkLimit: args.hunkLimit,
			};

			try {
				const response = await fetch(`${baseUrl}/api/internal/pr-walkthrough/bundle`, {
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Bobbit-Session-Secret": sessionSecret ?? "" },
					// No jobId/sessionId in the body — the server resolves both from the
					// pack-store binding keyed by the verified caller session secret.
					body: JSON.stringify({ ...readArgs }),
				});
				const text = await response.text();
				let data: unknown = text;
				try { data = JSON.parse(text); } catch { /* keep text */ }
				if (!response.ok) return toolText(formatGatewayResponse(data), true, data);
				return toolText(formatGatewayResponse(data), false, data);
			} catch (err: any) {
				return toolText(`read_pr_walkthrough_bundle failed: ${err?.message || err}`, true);
			}
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
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Bobbit-Session-Secret": sessionSecret ?? "" },
					// No jobId — the server resolves it from the binding by the verified session.
					body: JSON.stringify({ yaml }),
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
