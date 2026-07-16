import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandRunner, ExecFileOptions, ExecFileResult, ExecFileSyncOptions, SpawnOptions } from "../../src/server/gateway-deps.js";

export interface FakeCommandResponse {
	stdout?: string | Buffer;
	stderr?: string | Buffer;
}

export interface FencedCommandRunnerOptions {
	fakes?: Record<string, FakeCommandResponse | ((file: string, args: readonly string[], options?: ExecFileOptions) => FakeCommandResponse | Promise<FakeCommandResponse>)>;
}

const NETWORK_GIT_COMMANDS = new Set(["push", "fetch", "clone", "ls-remote"]);

function commandName(file: string): string {
	return path.basename(file).replace(/\.exe$/i, "").toLowerCase();
}

function fakeKey(file: string, args: readonly string[]): string {
	return `${commandName(file)} ${args.join(" ")}`.trim();
}

const READ_ONLY_GIT_DISCOVERY = new Set(["rev-parse", "for-each-ref", "show-ref", "status"]);

function isReadOnlyGitDiscovery(args: readonly string[]): boolean {
	const subcommand = args[0];
	if (READ_ONLY_GIT_DISCOVERY.has(subcommand)) return true;
	if (subcommand === "remote") return args[1] === "get-url";
	if (subcommand !== "symbolic-ref") return false;
	return !args.includes("--delete") && args.filter(arg => !arg.startsWith("-")).length <= 2;
}

function hasExplicitGitDirectory(args: readonly string[], options?: ExecFileOptions | ExecFileSyncOptions): boolean {
	if (args.some(arg => arg === "--git-dir" || arg.startsWith("--git-dir="))) return true;
	const env = options?.env ?? process.env;
	return typeof env.GIT_DIR === "string" && env.GIT_DIR.length > 0;
}

function gitProbeCwd(options?: ExecFileOptions | ExecFileSyncOptions): string | null {
	if (options?.cwd !== undefined && typeof options.cwd !== "string") return null;
	return path.resolve(options?.cwd ?? process.cwd());
}

function isBareGitRepo(candidate: string): boolean {
	try {
		const stat = fs.statSync(candidate);
		if (!stat.isDirectory()) return false;
		return fs.existsSync(path.join(candidate, "HEAD")) && fs.existsSync(path.join(candidate, "objects"));
	} catch {
		return false;
	}
}

function hasGitMetadataAtOrAbove(candidate: string): boolean {
	let current = candidate;
	for (;;) {
		if (fs.existsSync(path.join(current, ".git")) || isBareGitRepo(current)) return true;
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

function shouldShortCircuitGitDiscovery(args: readonly string[], options?: ExecFileOptions | ExecFileSyncOptions): boolean {
	if (!isReadOnlyGitDiscovery(args) || hasExplicitGitDirectory(args, options)) return false;
	const cwd = gitProbeCwd(options);
	return cwd !== null && !hasGitMetadataAtOrAbove(cwd);
}

function nonRepositoryGitError(args: readonly string[], options?: ExecFileOptions | ExecFileSyncOptions): Error {
	const cwd = gitProbeCwd(options) ?? "<unknown>";
	const message = `[fenced-command-runner] skipped read-only git ${args[0]} discovery for non-repository cwd: ${cwd}`;
	const error = new Error(message) as Error & { code: number; stderr: string };
	error.code = 128;
	error.stderr = message;
	return error;
}

function toLocalPath(remote: string, cwd?: string): string | null {
	if (remote.startsWith("file://")) {
		try { return fileURLToPath(remote); } catch { return null; }
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(remote)) return null;
	if (/^[^/\\]+@[^:]+:/i.test(remote)) return null;
	return path.resolve(cwd ?? process.cwd(), remote);
}

function isAllowedLocalRemote(remote: string, cwd?: string): boolean {
	const localPath = toLocalPath(remote, cwd);
	return !!localPath && isBareGitRepo(localPath);
}

async function resolveRemoteName(realCommandRunner: CommandRunner, remote: string, cwd: string | undefined): Promise<string | null> {
	if (!cwd || !/^[A-Za-z0-9_.-]+$/.test(remote) || !hasGitMetadataAtOrAbove(path.resolve(cwd))) return null;
	try {
		const { stdout } = await realCommandRunner.execFile("git", ["remote", "get-url", remote], { cwd, encoding: "utf-8", timeout: 5_000 });
		return String(stdout).trim() || null;
	} catch {
		return null;
	}
}

function resolveRemoteNameSync(realCommandRunner: CommandRunner, remote: string, cwd: string | undefined): string | null {
	if (!cwd || !/^[A-Za-z0-9_.-]+$/.test(remote) || !hasGitMetadataAtOrAbove(path.resolve(cwd))) return null;
	try {
		const stdout = realCommandRunner.execFileSync!("git", ["remote", "get-url", remote], { cwd, encoding: "utf-8", timeout: 5_000 });
		return String(stdout).trim() || null;
	} catch {
		return null;
	}
}

function remoteCandidate(subcommand: string, args: readonly string[]): string | null {
	const rest = args.slice(1);
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--") continue;
		if (arg.startsWith("--")) {
			if (arg.includes("=")) continue;
			const next = rest[i + 1];
			if (next && !next.startsWith("-") && ["--upload-pack", "--exec", "--depth", "--branch", "--origin", "--config", "--server-option"].includes(arg)) i++;
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") continue;
		return arg;
	}
	return subcommand === "fetch" ? "origin" : null;
}

async function assertGitRemoteAllowed(realCommandRunner: CommandRunner, args: readonly string[], options?: ExecFileOptions): Promise<void> {
	const subcommand = args[0];
	if (!NETWORK_GIT_COMMANDS.has(subcommand)) return;
	const cwd = typeof options?.cwd === "string" ? options.cwd : undefined;
	const candidate = remoteCandidate(subcommand, args);
	if (!candidate) throw new Error(`[fenced-command-runner] blocked git ${subcommand}: remote is required`);
	const resolved = (await resolveRemoteName(realCommandRunner, candidate, cwd)) ?? candidate;
	if (!isAllowedLocalRemote(resolved, cwd)) {
		throw new Error(`[fenced-command-runner] blocked git ${subcommand} to non-local remote: ${candidate}`);
	}
}

function assertGitRemoteAllowedSync(realCommandRunner: CommandRunner, args: readonly string[], options?: ExecFileSyncOptions | SpawnOptions): void {
	const subcommand = args[0];
	if (!NETWORK_GIT_COMMANDS.has(subcommand)) return;
	const cwd = typeof options?.cwd === "string" ? options.cwd : undefined;
	const candidate = remoteCandidate(subcommand, args);
	if (!candidate) throw new Error(`[fenced-command-runner] blocked git ${subcommand}: remote is required`);
	const resolved = resolveRemoteNameSync(realCommandRunner, candidate, cwd) ?? candidate;
	if (!isAllowedLocalRemote(resolved, cwd)) {
		throw new Error(`[fenced-command-runner] blocked git ${subcommand} to non-local remote: ${candidate}`);
	}
}

export function createFencedCommandRunner(realCommandRunner: CommandRunner, opts: FencedCommandRunnerOptions = {}): CommandRunner {
	return {
		async execFile(file: string, args: readonly string[], options?: ExecFileOptions): Promise<ExecFileResult> {
			const name = commandName(file);
			const key = fakeKey(file, args);
			const fake = opts.fakes?.[key] ?? opts.fakes?.[name];
			if (fake) {
				const result = typeof fake === "function" ? await fake(file, args, options) : fake;
				return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
			}
			if (name === "gh") throw new Error("[fenced-command-runner] blocked gh invocation");
			if (name === "docker" || name === "podman") throw new Error(`[fenced-command-runner] blocked ${name} invocation`);
			if (name === "git") {
				if (shouldShortCircuitGitDiscovery(args, options)) throw nonRepositoryGitError(args, options);
				await assertGitRemoteAllowed(realCommandRunner, args, options);
			}
			return realCommandRunner.execFile(file, args, options);
		},
		execFileSync(file, args, options) {
			const name = commandName(file);
			if (name === "gh") throw new Error("[fenced-command-runner] blocked gh invocation");
			if (name === "docker" || name === "podman") throw new Error(`[fenced-command-runner] blocked ${name} invocation`);
			if (name === "git") {
				if (shouldShortCircuitGitDiscovery(args, options)) throw nonRepositoryGitError(args, options);
				assertGitRemoteAllowedSync(realCommandRunner, args, options);
			}
			return realCommandRunner.execFileSync!(file, args, options);
		},
		spawn(file, args, options) {
			const name = commandName(file);
			if (name === "gh") throw new Error("[fenced-command-runner] blocked gh invocation");
			if (name === "docker" || name === "podman") throw new Error(`[fenced-command-runner] blocked ${name} invocation`);
			if (name === "git") assertGitRemoteAllowedSync(realCommandRunner, args, options);
			return realCommandRunner.spawn!(file, args, options);
		},
	};
}
