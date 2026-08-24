import fs from "node:fs";
import os from "node:os";
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
	return path.basename(file).replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
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

function shouldShortCircuitGitDiscovery(
	commandArgs: readonly string[],
	invocationArgs: readonly string[],
	options?: ExecFileOptions | ExecFileSyncOptions,
): boolean {
	if (!isReadOnlyGitDiscovery(commandArgs) || hasExplicitGitDirectory(invocationArgs, options)) return false;
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

async function resolveRemoteName(realCommandRunner: CommandRunner, remote: string, cwd: string | undefined, env: NodeJS.ProcessEnv | undefined): Promise<string | null> {
	if (!cwd || !/^[A-Za-z0-9_.-]+$/.test(remote) || !hasGitMetadataAtOrAbove(path.resolve(cwd))) return null;
	try {
		const { stdout } = await realCommandRunner.execFile("git", ["remote", "get-url", remote], { cwd, env, encoding: "utf-8", timeout: 5_000 });
		return String(stdout).trim() || null;
	} catch {
		return null;
	}
}

function resolveRemoteNameSync(realCommandRunner: CommandRunner, remote: string, cwd: string | undefined, env: NodeJS.ProcessEnv | undefined): string | null {
	if (!cwd || !/^[A-Za-z0-9_.-]+$/.test(remote) || !hasGitMetadataAtOrAbove(path.resolve(cwd))) return null;
	try {
		const stdout = realCommandRunner.execFileSync!("git", ["remote", "get-url", remote], { cwd, env, encoding: "utf-8", timeout: 5_000 });
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
	const resolved = (await resolveRemoteName(realCommandRunner, candidate, cwd, options?.env)) ?? candidate;
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
	const resolved = resolveRemoteNameSync(realCommandRunner, candidate, cwd, options?.env) ?? candidate;
	if (!isAllowedLocalRemote(resolved, cwd)) {
		throw new Error(`[fenced-command-runner] blocked git ${subcommand} to non-local remote: ${candidate}`);
	}
}

const GIT_GLOBAL_FLAGS = new Set([
	"--version",
	"--help",
	"-h",
	"-p",
	"--paginate",
	"-P",
	"--no-pager",
	"--no-replace-objects",
	"--bare",
	"--no-lazy-fetch",
	"--no-optional-locks",
	"--no-advice",
	"--literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
	"--html-path",
	"--man-path",
	"--info-path",
	"--exec-path",
]);

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--attr-source",
	"--super-prefix",
]);

const GIT_GLOBAL_LONG_OPTIONS_WITH_EQUALS = new Set([
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--attr-source",
	"--super-prefix",
	"--exec-path",
]);

const MALFORMED_GIT_INVOCATION = "[fenced-command-runner] blocked unclassified git invocation";
const GIT_CREDENTIAL_INVOCATION = "[fenced-command-runner] blocked git credential invocation";
const UNSAFE_GIT_CONFIGURATION = "[fenced-command-runner] blocked unsafe git configuration";
const MAX_GIT_CONFIG_ENV_ENTRIES = 128;

function gitConfigName(key: string): string {
	if (!key || key.includes("=") || /[\s\0]/.test(key) || !key.includes(".")) throw new Error(MALFORMED_GIT_INVOCATION);
	return key;
}

function gitConfigKey(value: string): string {
	const equals = value.indexOf("=");
	return gitConfigName(equals < 0 ? value : value.slice(0, equals));
}

function assertSafeGitConfigKey(key: string): void {
	if (/^alias\./i.test(key) || /^include\.path$/i.test(key) || /^includeif\..+\.path$/i.test(key)) {
		throw new Error(UNSAFE_GIT_CONFIGURATION);
	}
}

function assertSafeInlineGitConfig(value: string): void {
	assertSafeGitConfigKey(gitConfigKey(value));
}

function assertSafeConfigEnv(value: string): void {
	const equals = value.indexOf("=");
	if (equals <= 0 || equals === value.length - 1 || value.indexOf("=", equals + 1) !== -1) {
		throw new Error(MALFORMED_GIT_INVOCATION);
	}
	const variable = value.slice(equals + 1);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new Error(MALFORMED_GIT_INVOCATION);
	assertSafeGitConfigKey(gitConfigKey(value.slice(0, equals)));
}

function normalizedConfigEnvironment(env: NodeJS.ProcessEnv): Map<string, { name: string; value: string }> {
	const normalized = new Map<string, { name: string; value: string }>();
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined || !name.toUpperCase().startsWith("GIT_CONFIG")) continue;
		const upper = name.toUpperCase();
		if (normalized.has(upper)) throw new Error(MALFORMED_GIT_INVOCATION);
		normalized.set(upper, { name, value });
	}
	return normalized;
}

function assertSafeGitConfigEnvironment(env: NodeJS.ProcessEnv): void {
	const normalized = normalizedConfigEnvironment(env);
	if (normalized.has("GIT_CONFIG_PARAMETERS")) throw new Error(UNSAFE_GIT_CONFIGURATION);

	const countEntry = normalized.get("GIT_CONFIG_COUNT");
	const injectionNames = [...normalized.keys()].filter(name => name.startsWith("GIT_CONFIG_KEY_") || name.startsWith("GIT_CONFIG_VALUE_"));
	if (injectionNames.some(name => !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name))) throw new Error(MALFORMED_GIT_INVOCATION);
	const indexed = injectionNames;
	if (!countEntry) {
		if (indexed.length > 0) throw new Error(MALFORMED_GIT_INVOCATION);
		return;
	}
	if (!/^(?:0|[1-9]\d*)$/.test(countEntry.value)) throw new Error(MALFORMED_GIT_INVOCATION);
	const count = Number(countEntry.value);
	if (!Number.isSafeInteger(count) || count > MAX_GIT_CONFIG_ENV_ENTRIES || indexed.length !== count * 2) {
		throw new Error(MALFORMED_GIT_INVOCATION);
	}
	for (let index = 0; index < count; index++) {
		const key = normalized.get(`GIT_CONFIG_KEY_${index}`)?.value;
		const value = normalized.get(`GIT_CONFIG_VALUE_${index}`)?.value;
		if (key === undefined || value === undefined) throw new Error(MALFORMED_GIT_INVOCATION);
		assertSafeGitConfigKey(gitConfigName(key));
	}
}

function fencedGitOptions<T extends ExecFileOptions | ExecFileSyncOptions | SpawnOptions>(options: T | undefined): T {
	const env = { ...(options?.env ?? process.env) };
	assertSafeGitConfigEnvironment(env);
	for (const name of Object.keys(env)) {
		if (["GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"].includes(name.toUpperCase())) delete env[name];
	}
	env.GIT_CONFIG_GLOBAL = os.devNull;
	env.GIT_CONFIG_SYSTEM = os.devNull;
	env.GIT_CONFIG_NOSYSTEM = "1";
	return { ...(options ?? {}), env } as T;
}

/**
 * Find the Git subcommand without consulting Git or host configuration. Unknown
 * and incomplete leading options are rejected rather than guessed at: this is a
 * test security boundary, not a general-purpose Git argument parser.
 */
function classifyGitCommand(args: readonly string[]): readonly string[] {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "--") {
			index++;
			break;
		}
		if (arg.length > 0 && !arg.startsWith("-")) return args.slice(index);
		if (GIT_GLOBAL_FLAGS.has(arg)) {
			index++;
			continue;
		}
		if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
			const value = args[index + 1];
			if (value === undefined || value.length === 0) throw new Error(MALFORMED_GIT_INVOCATION);
			if (arg === "-c") assertSafeInlineGitConfig(value);
			if (arg === "--config-env") assertSafeConfigEnv(value);
			index += 2;
			continue;
		}
		if (arg.startsWith("-C") && arg.length > 2) {
			index++;
			continue;
		}
		if (arg.startsWith("-c") && arg.length > 2) {
			assertSafeInlineGitConfig(arg.slice(2));
			index++;
			continue;
		}
		const equals = arg.indexOf("=");
		if (equals > 0 && GIT_GLOBAL_LONG_OPTIONS_WITH_EQUALS.has(arg.slice(0, equals)) && equals < arg.length - 1) {
			if (arg.slice(0, equals) === "--config-env") assertSafeConfigEnv(arg.slice(equals + 1));
			index++;
			continue;
		}
		throw new Error(MALFORMED_GIT_INVOCATION);
	}
	const commandArgs = args.slice(index);
	if (!commandArgs[0] || commandArgs[0].startsWith("-")) throw new Error(MALFORMED_GIT_INVOCATION);
	return commandArgs;
}

/**
 * `git credential` reads the developer's real credential configuration, so
 * letting it through would make host trust — and the security assertions that
 * depend on it — vary by machine. Applied to every invocation path, not just the
 * one that has a caller today. Callers fail closed on a throw.
 */
function assertNotGitCredential(commandArgs: readonly string[]): void {
	if (commandArgs[0] === "credential") throw new Error(GIT_CREDENTIAL_INVOCATION);
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
			let delegatedOptions = options;
			if (name === "git") {
				const commandArgs = classifyGitCommand(args);
				assertNotGitCredential(commandArgs);
				delegatedOptions = fencedGitOptions(options);
				if (shouldShortCircuitGitDiscovery(commandArgs, args, delegatedOptions)) throw nonRepositoryGitError(commandArgs, delegatedOptions);
				await assertGitRemoteAllowed(realCommandRunner, commandArgs, delegatedOptions);
			}
			return realCommandRunner.execFile(file, args, delegatedOptions);
		},
		execFileSync(file, args, options) {
			const name = commandName(file);
			if (name === "gh") throw new Error("[fenced-command-runner] blocked gh invocation");
			if (name === "docker" || name === "podman") throw new Error(`[fenced-command-runner] blocked ${name} invocation`);
			let delegatedOptions = options;
			if (name === "git") {
				const commandArgs = classifyGitCommand(args);
				assertNotGitCredential(commandArgs);
				delegatedOptions = fencedGitOptions(options);
				if (shouldShortCircuitGitDiscovery(commandArgs, args, delegatedOptions)) throw nonRepositoryGitError(commandArgs, delegatedOptions);
				assertGitRemoteAllowedSync(realCommandRunner, commandArgs, delegatedOptions);
			}
			return realCommandRunner.execFileSync!(file, args, delegatedOptions);
		},
		spawn(file, args, options) {
			const name = commandName(file);
			if (name === "gh") throw new Error("[fenced-command-runner] blocked gh invocation");
			if (name === "docker" || name === "podman") throw new Error(`[fenced-command-runner] blocked ${name} invocation`);
			let delegatedOptions = options;
			if (name === "git") {
				const commandArgs = classifyGitCommand(args);
				assertNotGitCredential(commandArgs);
				delegatedOptions = fencedGitOptions(options);
				assertGitRemoteAllowedSync(realCommandRunner, commandArgs, delegatedOptions);
			}
			return realCommandRunner.spawn!(file, args, delegatedOptions);
		},
	};
}
