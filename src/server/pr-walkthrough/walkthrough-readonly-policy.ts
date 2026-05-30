export interface WalkthroughReadonlyAllow {
	allowed: true;
	argv: string[];
}

export interface WalkthroughReadonlyBlock {
	allowed: false;
	reason: string;
	argv?: string[];
}

export type WalkthroughReadonlyDecision = WalkthroughReadonlyAllow | WalkthroughReadonlyBlock;

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

const GIT_ALLOWED = new Set(["diff", "show", "log", "rev-parse", "status"]);
const SEARCH_READ_ALLOWED = new Set(["rg", "grep", "ls", "cat", "head", "tail", "pwd"]);
const PATH_READING_COMMANDS = new Set(["rg", "grep", "ls", "cat", "head", "tail", "find", "sed"]);
const GH_PR_READ_ALLOWED = new Set(["view", "diff"]);
const GENERIC_WRITE_OR_ESCAPE_FLAGS = new Set(["--output", "--output-file", "--pathspec-from-file", "--git-dir", "--work-tree", "-C"]);
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

const GH_API_BODY_FLAGS = new Set(["-f", "--field", "-F", "--raw-field", "--input"]);
const GH_API_VALUE_FLAGS = new Set(["--jq", "-q", "--header", "-H", "--hostname"]);

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

function block(reason: string, argv?: string[]): WalkthroughReadonlyBlock {
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

function commonArgumentPolicy(argv: string[], options: { guardPaths?: boolean } = {}): WalkthroughReadonlyDecision | undefined {
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

function blockCurrentRootTraversal(commandName: string, argv: string[]): WalkthroughReadonlyBlock {
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

function allowGh(argv: string[]): WalkthroughReadonlyDecision {
	const common = commonArgumentPolicy(argv);
	if (common) return common;
	const [, first, second] = argv;
	if (first === "pr" && second && GH_PR_READ_ALLOWED.has(second)) return { allowed: true, argv };
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
	if (/^repos\/[^/]+\/[^/]+\/pulls\/\d+(?:\/(?:files|commits))?$/.test(normalized)) return { allowed: true, argv };
	return block("gh api is limited to read-only pull request metadata, files, and commits endpoints", argv);
}

function allowGit(argv: string[]): WalkthroughReadonlyDecision {
	const common = commonArgumentPolicy(argv);
	if (common) return common;
	const sub = argv[1];
	if (!sub || !GIT_ALLOWED.has(sub)) return block(`git ${sub ?? ""}`.trim() + " is not allowed in PR walkthrough sessions", argv);
	if (argv.slice(2).some(arg => arg === "--no-index" || arg === "--ext-diff" || arg === "--external-diff" || arg === "--textconv" || arg === "--output" || arg.startsWith("--output="))) {
		return block("git diff/show/log output, external diff, and arbitrary filesystem comparison flags are not allowed", argv);
	}
	if (sub === "status") {
		const allowedStatusArgs = new Set(["--short", "-s", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--branch", "-b", "--ignored", "--untracked-files", "-uno", "--ahead-behind"]);
		for (const arg of argv.slice(2)) {
			if (!allowedStatusArgs.has(arg) && !arg.startsWith("--untracked-files=")) {
				return block("git status is restricted to short/porcelain-style read-only flags", argv);
			}
		}
	}
	return { allowed: true, argv };
}

function allowRg(argv: string[]): WalkthroughReadonlyDecision {
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

function allowGrep(argv: string[]): WalkthroughReadonlyDecision {
	const common = commonArgumentPolicy(argv, { guardPaths: true });
	if (common) return common;
	const recursive = argv.slice(1).some(isGrepRecursiveFlag);
	if (!recursive) return { allowed: true, argv };
	const paths = extractSearchPaths(argv, grepOptionConsumesValue, new Set(["-e", "--regexp", "-f", "--file"]));
	if (!paths || paths.length === 0 || paths.some(isCurrentRootPathToken)) return blockCurrentRootTraversal("grep", argv);
	return { allowed: true, argv };
}

function allowFind(argv: string[]): WalkthroughReadonlyDecision {
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

function allowSed(argv: string[]): WalkthroughReadonlyDecision {
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

export function evaluateWalkthroughReadonlyCommand(command: string): WalkthroughReadonlyDecision {
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
	if (cmd === "gh") return allowGh(argv);
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

export function assertWalkthroughReadonlyCommand(command: string): string[] {
	const decision = evaluateWalkthroughReadonlyCommand(command);
	if (!decision.allowed) throw new Error(decision.reason);
	return decision.argv;
}
