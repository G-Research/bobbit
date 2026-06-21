import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { ExecFileOptions } from "node:child_process";
import type { PreferencesStore } from "./preferences-store.js";
import { readClaudeCodeConfig, type ClaudeCodeConfig } from "./claude-code-config.js";

export interface ClaudeCodeStatus {
	available: boolean;
	authenticated: boolean;
	ready: boolean;
	version?: string;
	executablePath: string;
	reason?: string;
	/** MVP: no safe authenticated no-op probe is documented, so auth is verified at session start. */
	authenticationStatus?: "verified" | "login-required" | "unknown";
}

type ExecFileLike = (
	file: string,
	args: readonly string[],
	options: ExecFileOptions,
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const execFileAsync = promisify(execFileCb) as ExecFileLike;
const STATUS_CACHE_TTL_MS = 5_000;
let cachedStatus: { key: string; expiry: number; status: ClaudeCodeStatus } | null = null;
let cachedPromise: { key: string; promise: Promise<ClaudeCodeStatus> } | null = null;

export function invalidateClaudeCodeStatusCache(): void {
	cachedStatus = null;
	cachedPromise = null;
}

export async function getClaudeCodeStatus(prefs: Pick<PreferencesStore, "get">): Promise<ClaudeCodeStatus> {
	const config = readClaudeCodeConfig(prefs);
	const key = cacheKey(config);
	const now = Date.now();
	if (cachedStatus && cachedStatus.key === key && cachedStatus.expiry > now) return cachedStatus.status;
	if (cachedPromise && cachedPromise.key === key) return cachedPromise.promise;
	const promise = probeClaudeCodeStatus(config).then(status => {
		cachedStatus = { key, expiry: Date.now() + STATUS_CACHE_TTL_MS, status };
		if (cachedPromise?.key === key) cachedPromise = null;
		return status;
	}, err => {
		if (cachedPromise?.key === key) cachedPromise = null;
		throw err;
	});
	cachedPromise = { key, promise };
	return promise;
}

export async function probeClaudeCodeStatus(
	config: Pick<ClaudeCodeConfig, "executablePath">,
	execFile: ExecFileLike = execFileAsync,
): Promise<ClaudeCodeStatus> {
	const executablePath = config.executablePath;
	try {
		const { stdout, stderr } = await execFile(executablePath, ["--version"], {
			timeout: STATUS_CACHE_TTL_MS,
			windowsHide: true,
			shell: false,
			maxBuffer: 1024 * 1024,
		});
		const version = parseVersion(stdout, stderr);
		const testAssumeAuthenticated = process.env.BOBBIT_TEST_CLAUDE_CODE_AUTHENTICATED === "1";
		return {
			available: true,
			authenticated: testAssumeAuthenticated,
			ready: testAssumeAuthenticated,
			...(version ? { version } : {}),
			executablePath,
			...(testAssumeAuthenticated ? {} : { reason: "Claude Code authentication status unknown; sign in with Claude Code and refresh status." }),
			authenticationStatus: testAssumeAuthenticated ? "verified" : "unknown",
		};
	} catch (err: any) {
		return statusFromProbeError(executablePath, err);
	}
}

function cacheKey(config: ClaudeCodeConfig): string {
	return JSON.stringify({ executablePath: config.executablePath });
}

function parseVersion(stdout: string | Buffer, stderr: string | Buffer): string | undefined {
	const text = `${String(stdout || "")}\n${String(stderr || "")}`.trim();
	const firstLine = text.split(/\r?\n/).map(line => line.trim()).find(Boolean);
	if (!firstLine) return undefined;
	const match = firstLine.match(/(?:claude(?:\s+code)?\s*)?(?:version\s*)?([0-9]+(?:\.[0-9A-Za-z-]+)+)/i);
	return match?.[1] ?? firstLine;
}

function statusFromProbeError(executablePath: string, err: any): ClaudeCodeStatus {
	const output = [err?.stdout, err?.stderr, err?.message].filter(Boolean).map(String).join("\n");
	if (err?.code === "ENOENT") {
		return unavailable(executablePath, "Claude Code CLI not found");
	}
	if (err?.code === "EACCES" || err?.code === "EPERM") {
		return unavailable(executablePath, "Claude Code executable is not runnable");
	}
	if (err?.killed || err?.signal === "SIGTERM" || err?.code === "ETIMEDOUT" || /timed? out/i.test(output)) {
		return unavailable(executablePath, "Claude Code probe timed out");
	}
	if (/login|required|auth|authenticated/i.test(output)) {
		return {
			available: true,
			authenticated: false,
			ready: false,
			executablePath,
			reason: "Claude Code login required",
			authenticationStatus: "login-required",
		};
	}
	return unavailable(executablePath, "Claude Code probe failed");
}

function unavailable(executablePath: string, reason: string): ClaudeCodeStatus {
	return {
		available: false,
		authenticated: false,
		ready: false,
		executablePath,
		reason,
		authenticationStatus: "unknown",
	};
}
