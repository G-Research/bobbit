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

type PolicyEvaluator = (command: string, options?: PolicyOptions) => PolicyDecision;
type PolicyModule = { evaluateWalkthroughReadonlyCommand?: PolicyEvaluator };
type PolicyImporter = (specifier: string) => Promise<PolicyModule>;

function evaluatorFromModule(mod: PolicyModule, specifier: string): PolicyEvaluator {
	if (typeof mod.evaluateWalkthroughReadonlyCommand === "function") return mod.evaluateWalkthroughReadonlyCommand;
	throw new Error(`Policy module ${specifier} does not export evaluateWalkthroughReadonlyCommand`);
}

export function readonlyPolicyImportSpecifiers(extensionModuleUrl = import.meta.url): string[] {
	return [
		// Source checkout: <repo>/market-packs/pr-walkthrough/tools/pr-walkthrough/extension.ts
		new URL("../../../../src/server/pr-walkthrough/walkthrough-readonly-policy.ts", extensionModuleUrl).href,
		// Shipped built-in pack: <repo>/dist/server/builtin-packs/market-packs/pr-walkthrough/tools/pr-walkthrough/extension.ts
		new URL("../../../../../pr-walkthrough/walkthrough-readonly-policy.js", extensionModuleUrl).href,
	];
}

async function importPolicyModule(specifier: string): Promise<PolicyModule> {
	return import(specifier) as Promise<PolicyModule>;
}

export async function loadPolicy(extensionModuleUrl = import.meta.url, importer: PolicyImporter = importPolicyModule): Promise<PolicyEvaluator> {
	const failures: string[] = [];
	for (const specifier of readonlyPolicyImportSpecifiers(extensionModuleUrl)) {
		try {
			return evaluatorFromModule(await importer(specifier), specifier);
		} catch (err: any) {
			failures.push(`${specifier}: ${err?.message || err}`);
		}
	}

	// Docker sandboxes mount only the shipped pack tree at /market-packs-builtin,
	// not the gateway's dist/server tree. Keep a mirrored policy fallback in the
	// pack extension so readonly_bash remains available after RPC path remap.
	if (process.env.BOBBIT_DEBUG_PRW_POLICY === "1" && failures.length > 0) {
		process.emitWarning?.(`Using bundled PR walkthrough read-only policy fallback; imports failed: ${failures.join(" | ")}`);
	}
	return evaluateBundledWalkthroughReadonlyCommand;
}

const MAX_COMMAND_CHARS = 12_000;

const BLOCKED_EXECUTABLES = new Set([
	"bash", "sh", "zsh", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
	"node", "node.exe", "python", "python3", "python.exe", "ruby", "perl", "php", "deno", "tsx", "ts-node",
	"npm", "npx", "pnpm", "yarn", "bun", "cargo", "go", "pytest", "jest", "vitest", "mocha", "playwright",
	"docker", "docker.exe", "docker-compose", "podman", "kubectl",
	"make", "cmake", "ninja", "vite", "tsc", "webpack", "rollup",
	"rm", "rmdir", "del", "erase", "mv", "move", "cp", "copy", "mkdir", "touch", "chmod", "chown", "chgrp", "ln",
	"tee", "truncate", "dd", "install", "rsync", "scp", "curl", "wget",
	"service", "systemctl", "nohup", "setsid",
]);

const GIT_ALLOWED = new Set(["diff", "show", "log", "grep", "rev-parse", "status", "for-each-ref"]);
const GIT_GREP_ESCAPE_FLAGS = new Set(["-O", "--open-files-in-pager", "--untracked", "--no-exclude-standard", "--recurse-submodules"]);
const SEARCH_READ_ALLOWED = new Set(["rg", "grep", "ls", "cat", "head", "tail", "pwd"]);
const PATH_READING_COMMANDS = new Set(["rg", "grep", "ls", "cat", "head", "tail", "find", "sed"]);
const GH_PR_READ_ALLOWED = new Set(["view", "diff"]);
const GENERIC_WRITE_OR_ESCAPE_FLAGS = new Set(["--output", "--output-file", "--pathspec-from-file", "--git-dir", "--work-tree"]);
const SAFE_HIDDEN_PATH_SEGMENTS = new Set([".", ".github"]);
const SENSITIVE_PATH_SEGMENTS = new Set([".bobbit", ".git", ".ssh", ".gnupg", ".aws", ".azure", ".gcloud"]);
const RG_HIDDEN_OR_IGNORE_OVERRIDE_FLAGS = new Set([
	"--hidden",
	"--no-ignore",
	"--no-ignore-vcs",
	"--no-ignore-parent",
	"--no-ignore-global",
	"--no-ignore-dot",
	"--unrestricted",
	"--follow",
	"-L",
]);
const GIT_FOR_EACH_REF_ESCAPE_FLAGS = new Set(["--shell", "--perl", "--python", "--tcl"]);

const GH_API_BODY_FLAGS = new Set(["-f", "--field", "-F", "--raw-field", "--input"]);
const GH_API_VALUE_FLAGS = new Set(["--jq", "-q", "--header", "-H"]);
const GH_PR_VALUE_FLAGS = new Set(["--json", "--jq", "-q", "--template", "--color"]);

function basename(token: string): string {
	const normalized = token.replace(/\\/g, "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function executableTokenReason(token: string): string | undefined {
	if (token.includes("\0")) return "NUL bytes are not allowed in executable names";
	if (/[\\/]/.test(token) || /^[A-Za-z]:/.test(token)) {
		return "path-qualified executables are not allowed; use trusted command names such as git, gh, rg, or cat";
	}
	if (token.startsWith("~") || token.startsWith("$") || token.startsWith("%")) {
		return "dynamic executable paths are not allowed; use trusted command names such as git, gh, rg, or cat";
	}
	if (/\.(?:exe|cmd|bat|ps1|sh)$/i.test(token)) {
		return "executable file extensions are not allowed; use trusted command names such as git, gh, rg, or cat";
	}
	return undefined;
}

function hasForbiddenShellSyntax(command: string): string | undefined {
	if (command.length > MAX_COMMAND_CHARS) return `command exceeds ${MAX_COMMAND_CHARS} characters`;
	if (/\r|\n/.test(command)) return "multi-line commands and heredocs are not allowed";
	if (/[;&|`]/.test(command)) return "shell chaining, pipes, backgrounding, and command substitution are not allowed";
	if (/[<>]/.test(command)) return "redirection and heredocs are not allowed";
	if (/\$\s*\(|\$\s*\{/.test(command)) return "shell expansion and command substitution are not allowed";
	return undefined;
}

function tokenize(command: string): { ok: true; argv: string[] } | { ok: false; reason: string } {
	const argv: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\") {
			current += ch;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current.length > 0) {
				argv.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}

	if (quote) return { ok: false, reason: "unterminated quoted string" };
	if (current.length > 0) argv.push(current);
	return { ok: true, argv };
}

function block(reason: string, argv?: string[]): Extract<PolicyDecision, { allowed: false }> {
	return { allowed: false, reason, argv };
}

function unsafeTokenReason(token: string): string | undefined {
	if (!token) return undefined;
	if (token.includes("\0")) return "NUL bytes are not allowed in command arguments";
	if (/(^|[^\\])\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]*\}|\([^)]*\))/.test(token) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(token)) {
		return "environment-variable expansion syntax is not allowed in command arguments";
	}
	if (token.startsWith("~")) return "home-directory paths are not allowed; use repo-relative paths";
	if (token.startsWith("$") || token.startsWith("%")) return "environment-variable paths are not allowed; use repo-relative paths";
	if (/^(?:[A-Za-z]:|[\\/])/.test(token)) return "absolute paths are not allowed; use repo-relative paths";
	if (token === ".." || /^[.][.][\\/]/.test(token) || /[\\/][.][.](?:[\\/]|$)/.test(token)) return "parent-directory path traversal is not allowed";
	if (token.startsWith(":/")) return "git pathspec root escapes are not allowed";
	if (token.startsWith(":(")) return "git pathspec magic is not allowed";
	return undefined;
}

function sensitivePathTokenReason(token: string): string | undefined {
	if (!token || token === "." || token.startsWith("-")) return undefined;
	const normalized = token.replace(/\\/g, "/").replace(/^[']|[']$/g, "").replace(/^[\"]|[\"]$/g, "");
	if (!normalized || normalized === ".") return undefined;
	const parts = normalized.split("/").filter(Boolean);
	for (const part of parts) {
		const lower = part.toLowerCase();
		if (SENSITIVE_PATH_SEGMENTS.has(lower)) return `access to ${part}/ is blocked in PR walkthrough sessions`;
		if (lower.startsWith(".env")) return ".env files are blocked in PR walkthrough sessions";
		if (lower.startsWith(".") && !SAFE_HIDDEN_PATH_SEGMENTS.has(lower)) return `hidden path ${part} is blocked in PR walkthrough sessions`;
	}
	const leaf = parts.at(-1)?.toLowerCase() ?? normalized.toLowerCase();
	if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|known_hosts|authorized_keys)$/.test(leaf)) return "SSH credential files are blocked in PR walkthrough sessions";
	const looksLikePath = normalized.includes("/") || normalized.includes(".");
	if (looksLikePath && /(?:^|[-_.])(secret|secrets|credential|credentials|token|tokens|apikey|api_key)(?:[-_.]|$)/.test(leaf)) return "credential and token files are blocked in PR walkthrough sessions";
	if (/\.(?:pem|key|p12|pfx|kdbx|gpg|asc)$/i.test(leaf)) return "key and certificate files are blocked in PR walkthrough sessions";
	return undefined;
}

function commonArgumentPolicy(argv: string[], options: { guardPaths?: boolean } = {}): PolicyDecision | undefined {
	for (const token of argv.slice(1)) {
		if (GENERIC_WRITE_OR_ESCAPE_FLAGS.has(token) || token.startsWith("--output=") || token.startsWith("--output-file=") || token.startsWith("--pathspec-from-file=") || token.startsWith("--git-dir=") || token.startsWith("--work-tree=")) {
			return block(`${token.split("=")[0]} is not allowed in read-only PR walkthrough sessions`, argv);
		}
		const reason = unsafeTokenReason(token);
		if (reason) return block(reason, argv);
		if (options.guardPaths) {
			const pathReason = sensitivePathTokenReason(token);
			if (pathReason) return block(pathReason, argv);
		}
	}
	return undefined;
}

function isCurrentRootPathToken(token: string): boolean {
	const normalized = token.replace(/\\/g, "/").replace(/^['\"]|['\"]$/g, "").replace(/\/+/g, "/");
	return normalized === "." || /^\.\/*$/.test(normalized);
}

function blockCurrentRootTraversal(commandName: string, argv: string[]): Extract<PolicyDecision, { allowed: false }> {
	return block(`${commandName} recursive searches from the repository root/current directory are blocked; scope the command to a non-hidden subdirectory or file`, argv);
}

function rgFlagReason(token: string): string | undefined {
	const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
	if (RG_HIDDEN_OR_IGNORE_OVERRIDE_FLAGS.has(flag)) return `${flag} can reveal hidden or ignored paths and is not allowed`;
	if (/^-u{1,3}$/.test(token)) return `${token} can reveal ignored or hidden paths and is not allowed`;
	return undefined;
}

function optionHasInlineValue(token: string): boolean {
	return token.includes("=") || (/^-[A-Za-z][^A-Za-z-]/.test(token) && token.length > 2);
}

function rgOptionConsumesValue(token: string): boolean {
	if (optionHasInlineValue(token)) return false;
	return new Set([
		"-e", "--regexp", "-f", "--file", "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not",
		"-m", "--max-count", "-A", "--after-context", "-B", "--before-context", "-C", "--context", "--context-separator",
		"--colors", "--sort", "--sortr", "--threads", "--max-depth", "--max-filesize", "--encoding", "--engine",
	]).has(token);
}

function grepOptionConsumesValue(token: string): boolean {
	if (optionHasInlineValue(token)) return false;
	return new Set([
		"-e", "--regexp", "-f", "--file", "--include", "--exclude", "--exclude-dir", "--exclude-from",
		"-m", "--max-count", "-A", "--after-context", "-B", "--before-context", "-C", "--context", "-D", "-d",
	]).has(token);
}

function isGrepRecursiveFlag(token: string): boolean {
	return token === "-r" || token === "-R" || token === "--recursive" || token === "--dereference-recursive" || (/^-[^-].*[rR]/.test(token) && !token.startsWith("--"));
}

function extractSearchPaths(argv: string[], optionConsumesValue: (token: string) => boolean, patternOptions: Set<string>): string[] | undefined {
	const paths: string[] = [];
	let patternSeen = false;
	for (let i = 1; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--") {
			if (!patternSeen) {
				i++;
				patternSeen = true;
			}
			paths.push(...argv.slice(i + 1));
			break;
		}
		const optionName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
		if (token.startsWith("-") && token.includes("=") && patternOptions.has(optionName)) {
			patternSeen = true;
			continue;
		}
		if (token.startsWith("-") && optionConsumesValue(token)) {
			if (patternOptions.has(token)) patternSeen = true;
			i++;
			continue;
		}
		if (token.startsWith("-") && !patternSeen) continue;
		if (!patternSeen) {
			patternSeen = true;
			continue;
		}
		if (token.startsWith("-") && optionConsumesValue(token)) {
			i++;
			continue;
		}
		if (token.startsWith("-")) continue;
		paths.push(token);
	}
	if (!patternSeen) return undefined;
	return paths;
}

function ghApiInlineMethod(token: string): string | undefined {
	if (token.startsWith("--method=")) return token.slice("--method=".length);
	if (token.startsWith("-X") && token.length > 2) return token.slice(2);
	return undefined;
}

function isGhApiBodyFlag(token: string): boolean {
	if (GH_API_BODY_FLAGS.has(token)) return true;
	if (token.startsWith("--field=") || token.startsWith("--raw-field=") || token.startsWith("--input=")) return true;
	return /^-[fF].+/.test(token);
}

function completeGithubTarget(options?: PolicyOptions): { owner: string; repo: string; number: number } | undefined {
	const target = options?.githubTarget;
	if (!target || target.provider !== "github") return undefined;
	if (!target.owner || !target.repo || typeof target.number !== "number" || !Number.isInteger(target.number)) return undefined;
	return { owner: target.owner.toLowerCase(), repo: target.repo.toLowerCase(), number: target.number };
}

function ghDisallowedFlagReason(token: string): string | undefined {
	const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
	if (flag === "--hostname") return "--hostname is not allowed for PR walkthrough GitHub commands";
	if (flag === "--repo" || flag === "-R" || token.startsWith("-R")) return "--repo/-R is not allowed; walkthrough GitHub reads are scoped to the launched PR";
	return undefined;
}

function ghUrlArgumentReason(token: string): string | undefined {
	return /^https?:\/\//i.test(token) ? "URL arguments are not allowed; use the launched PR number and repository-scoped API endpoint" : undefined;
}

function ghPrOptionConsumesValue(token: string): boolean {
	if (optionHasInlineValue(token)) return false;
	return GH_PR_VALUE_FLAGS.has(token);
}

function extractGhPrSubject(argv: string[]): string | undefined {
	for (let i = 3; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--") return argv[i + 1];
		if (token.startsWith("-") && ghPrOptionConsumesValue(token)) {
			i++;
			continue;
		}
		if (token.startsWith("-")) continue;
		return token;
	}
	return undefined;
}

function validateGhPrSubject(subcommand: string, subject: string | undefined, target: ReturnType<typeof completeGithubTarget>, argv: string[]): PolicyDecision | undefined {
	if (!target) return undefined;
	if (!subject) return block(`gh pr ${subcommand} must explicitly target launched PR #${target.number}`, argv);
	if (!/^\d+$/.test(subject)) return block(`gh pr ${subcommand} is restricted to launched PR #${target.number}; URL and branch arguments are not allowed`, argv);
	if (Number(subject) !== target.number) return block(`gh pr ${subcommand} may only read launched PR #${target.number}`, argv);
	return undefined;
}

function validateGhApiEndpointTarget(endpoint: string, target: ReturnType<typeof completeGithubTarget>, argv: string[]): PolicyDecision | undefined {
	if (!target) return undefined;
	const normalized = endpoint.replace(/^\/+/, "");
	const match = normalized.match(/^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)(?:\/(?:files|commits))?$/);
	if (!match) return undefined;
	const [, owner, repo, numberText] = match;
	if (owner.toLowerCase() !== target.owner || repo.toLowerCase() !== target.repo || Number(numberText) !== target.number) {
		return block(`gh api may only read repos/${target.owner}/${target.repo}/pulls/${target.number} for the launched PR`, argv);
	}
	return undefined;
}

function validateGhCommonArgs(argv: string[]): PolicyDecision | undefined {
	for (const token of argv.slice(1)) {
		const flagReason = ghDisallowedFlagReason(token);
		if (flagReason) return block(flagReason, argv);
		const urlReason = ghUrlArgumentReason(token);
		if (urlReason) return block(urlReason, argv);
	}
	return undefined;
}

function allowGh(argv: string[], options?: PolicyOptions): PolicyDecision {
	const common = commonArgumentPolicy(argv);
	if (common) return common;
	const ghCommon = validateGhCommonArgs(argv);
	if (ghCommon) return ghCommon;
	const target = completeGithubTarget(options);
	const [, first, second] = argv;
	if (first === "pr" && second && GH_PR_READ_ALLOWED.has(second)) {
		const targetDecision = validateGhPrSubject(second, extractGhPrSubject(argv), target, argv);
		return targetDecision ?? { allowed: true, argv };
	}
	if (first === "pr") return block(`gh pr ${second ?? ""}`.trim() + " is not a read-only PR command", argv);

	if (first !== "api") return block("only gh pr view, gh pr diff, and selected read-only gh api calls are allowed", argv);

	let endpoint: string | undefined;
	for (let i = 2; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--") continue;
		if (token === "--method" || token === "-X") {
			const method = argv[i + 1]?.toUpperCase();
			if (method !== "GET") return block("gh api is restricted to GET requests", argv);
			i++;
			continue;
		}
		const inlineMethod = ghApiInlineMethod(token);
		if (inlineMethod !== undefined) {
			if (inlineMethod.toUpperCase() !== "GET") return block("gh api is restricted to GET requests", argv);
			continue;
		}
		if (isGhApiBodyFlag(token)) return block("gh api request bodies are not allowed", argv);
		if (token.startsWith("-") && !endpoint) {
			const optionName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
			if (optionName === "--paginate") continue;
			if (GH_API_VALUE_FLAGS.has(optionName) && !token.includes("=")) i++;
			continue;
		}
		if (!token.startsWith("-") && !endpoint) endpoint = token;
	}

	if (!endpoint) return block("gh api endpoint is required", argv);
	const normalized = endpoint.replace(/^\/+/, "");
	if (/^repos\/[^/]+\/[^/]+\/pulls\/\d+(?:\/(?:files|commits))?$/.test(normalized)) {
		const targetDecision = validateGhApiEndpointTarget(endpoint, target, argv);
		return targetDecision ?? { allowed: true, argv };
	}
	return block("gh api is limited to read-only pull request metadata, files, and commits endpoints", argv);
}

function gitGrepFlagReason(token: string): string | undefined {
	const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
	if (GIT_GREP_ESCAPE_FLAGS.has(flag)) return `${flag} is not allowed for git grep in read-only PR walkthrough sessions`;
	if (/^-[^-]*O/.test(token)) return "git grep -O is not allowed in read-only PR walkthrough sessions because it opens matching files in a pager/editor";
	return undefined;
}

function allowGit(argv: string[]): PolicyDecision {
	const common = commonArgumentPolicy(argv);
	if (common) return common;
	const sub = argv[1];
	if (!sub || !GIT_ALLOWED.has(sub)) return block(`git ${sub ?? ""}`.trim() + " is not allowed in PR walkthrough sessions", argv);
	if (argv.slice(2).some(arg => arg === "--no-index" || arg === "--ext-diff" || arg === "--external-diff" || arg === "--textconv" || arg === "--output" || arg.startsWith("--output="))) {
		return block("git diff/show/log/grep output, external diff, and arbitrary filesystem comparison flags are not allowed", argv);
	}
	if (sub === "grep") {
		for (const arg of argv.slice(2)) {
			const flagReason = gitGrepFlagReason(arg);
			if (flagReason) return block(flagReason, argv);
		}
	}
	if (sub === "status") {
		const allowedStatusArgs = new Set(["--short", "-s", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--branch", "-b", "--ignored", "--untracked-files", "-uno", "--ahead-behind"]);
		for (const arg of argv.slice(2)) {
			if (!allowedStatusArgs.has(arg) && !arg.startsWith("--untracked-files=")) {
				return block("git status is restricted to short/porcelain-style read-only flags", argv);
			}
		}
	}
	if (sub === "for-each-ref") {
		for (const arg of argv.slice(2)) {
			const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
			if (GIT_FOR_EACH_REF_ESCAPE_FLAGS.has(flag)) {
				return block(`${flag} is not allowed in read-only PR walkthrough sessions because it emits shell/interpreter-quoted output`, argv);
			}
		}
	}
	return { allowed: true, argv };
}

function allowRg(argv: string[]): PolicyDecision {
	const common = commonArgumentPolicy(argv, { guardPaths: true });
	if (common) return common;
	for (const token of argv.slice(1)) {
		const flagReason = rgFlagReason(token);
		if (flagReason) return block(flagReason, argv);
	}
	const paths = extractSearchPaths(argv, rgOptionConsumesValue, new Set(["-e", "--regexp", "-f", "--file"]));
	if (!paths || paths.length === 0 || paths.some(isCurrentRootPathToken)) return blockCurrentRootTraversal("rg", argv);
	return { allowed: true, argv };
}

function allowGrep(argv: string[]): PolicyDecision {
	const common = commonArgumentPolicy(argv, { guardPaths: true });
	if (common) return common;
	const recursive = argv.slice(1).some(isGrepRecursiveFlag);
	if (!recursive) return { allowed: true, argv };
	const paths = extractSearchPaths(argv, grepOptionConsumesValue, new Set(["-e", "--regexp", "-f", "--file"]));
	if (!paths || paths.length === 0 || paths.some(isCurrentRootPathToken)) return blockCurrentRootTraversal("grep", argv);
	return { allowed: true, argv };
}

function allowFind(argv: string[]): PolicyDecision {
	const common = commonArgumentPolicy(argv, { guardPaths: true });
	if (common) return common;
	const blocked = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"]);
	const paths: string[] = [];
	for (const token of argv.slice(1)) {
		if (blocked.has(token)) return block(`find action ${token} can mutate or write files`, argv);
		if (token === "-L") return block("find -L can follow symlinks into hidden or secret paths and is not allowed", argv);
	}
	for (const token of argv.slice(1)) {
		if (token === "--") continue;
		if (token.startsWith("-") || token === "(" || token === "!" || token === ")" || token === ",") break;
		paths.push(token);
	}
	if (paths.length === 0 || paths.some(isCurrentRootPathToken)) return blockCurrentRootTraversal("find", argv);
	return { allowed: true, argv };
}

function allowSed(argv: string[]): PolicyDecision {
	const common = commonArgumentPolicy(argv, { guardPaths: true });
	if (common) return common;
	let hasNoPrint = false;
	let script: string | undefined;
	for (const token of argv.slice(1)) {
		if (token === "-i" || token.startsWith("-i")) return block("sed in-place editing is not allowed", argv);
		if (token === "-n" || (/^-[A-Za-z]+$/.test(token) && token.includes("n"))) {
			hasNoPrint = true;
			continue;
		}
		if (!token.startsWith("-") && script === undefined) script = token;
	}
	if (!hasNoPrint) return block("sed is allowed only with -n for bounded read-only printing", argv);
	if (!script || !/p\s*$/.test(script) || /[ewr]/.test(script.replace(/\\./g, ""))) {
		return block("sed is restricted to print-only scripts such as -n '1,40p'", argv);
	}
	return { allowed: true, argv };
}

function longLivedReadFlagReason(commandName: string, token: string): string | undefined {
	if (commandName !== "tail") return undefined;
	if (token === "--follow" || token.startsWith("--follow=") || token === "-f" || token === "-F") {
		return `${token} can keep readonly_bash running indefinitely and is not allowed`;
	}
	if (/^-[^-].*[fF]/.test(token)) return `${token} can keep readonly_bash running indefinitely and is not allowed`;
	return undefined;
}

function evaluateBundledWalkthroughReadonlyCommand(command: string, options: PolicyOptions = {}): PolicyDecision {
	const trimmed = command.trim();
	if (!trimmed) return block("empty command");
	const syntaxReason = hasForbiddenShellSyntax(trimmed);
	if (syntaxReason) return block(syntaxReason);

	const parsed = tokenize(trimmed);
	if (!parsed.ok) return block(parsed.reason);
	const argv = parsed.argv;
	if (argv.length === 0) return block("empty command");

	const executableReason = executableTokenReason(argv[0]);
	if (executableReason) return block(executableReason, argv);

	const cmd = basename(argv[0]);
	if (BLOCKED_EXECUTABLES.has(cmd)) return block(`${cmd} is not permitted in read-only PR walkthrough sessions`, argv);
	if (cmd === "gh") return allowGh(argv, options);
	if (cmd === "git") return allowGit(argv);
	if (cmd === "find") return allowFind(argv);
	if (cmd === "sed") return allowSed(argv);
	if (cmd === "rg") return allowRg(argv);
	if (cmd === "grep") return allowGrep(argv);
	if (SEARCH_READ_ALLOWED.has(cmd)) {
		const common = commonArgumentPolicy(argv, { guardPaths: PATH_READING_COMMANDS.has(cmd) });
		if (common) return common;
		for (const token of argv.slice(1)) {
			const flagReason = longLivedReadFlagReason(cmd, token);
			if (flagReason) return block(flagReason, argv);
		}
		return { allowed: true, argv };
	}

	return block(`${cmd} is not on the PR walkthrough read-only command allowlist`, argv);
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
	// pr-reviewer role policy + the default-deny `PR Walkthrough` tool group — NOT an
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
